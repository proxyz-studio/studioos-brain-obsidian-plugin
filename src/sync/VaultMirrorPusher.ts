import type { TFile, Vault } from 'obsidian';

import type { BrainApiClient } from '../api/client';
import { sha256Hex } from './contentHash';

/**
 * Maximum upserts per server batch. Mirrors the cap on
 * POST /api/brain/sync/vault-files. Larger walks paginate locally.
 */
const BATCH_SIZE = 250;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DAILY_NOTE_CONTENT_MAX_BYTES = 200_000;
const DAILY_NOTE_PATH_RE = /(?:^|\/)(?:Daily Notes|01-DAILY)\/\d{4}-\d{2}-\d{2}\.md$/;

/**
 * Skip files that obviously aren't user-authored Obsidian content. We
 * push markdown only on first pass; future iterations can extend to
 * attachments once the server's content cap is generous enough.
 */
const SUPPORTED_EXTENSIONS = new Set(['md']);

type AppLike = {
  vault: Vault;
};

export type VaultMirrorPusherOptions = {
  app: AppLike;
  api: BrainApiClient;
  /** Default: 5 minutes. */
  intervalMs?: number;
  onSyncComplete?: (result: { batches: number; upserted: number; deleted: number }) => void | Promise<void>;
  /** Optional logger — defaults to noop in production. */
  log?: (msg: string, ...rest: unknown[]) => void;
  /** Test-only timer injection. */
  _setInterval?: typeof setInterval;
  _clearInterval?: typeof clearInterval;
};

/**
 * VaultMirrorPusher — periodically refreshes the StudioOS server's
 * `obsidian_vault_files` index cache.
 *
 * Lifecycle:
 *   - `start()` performs one index-only walk, then schedules future walks.
 *   - `syncNow()` lets Settings trigger the same walk manually.
 *   - `stop()` cancels the interval.
 *
 * Push semantics:
 *   - Pushes path + mtime + size only. The server preserves any older cached
 *     content when content is omitted, so index refreshes cannot blank previews.
 */
export class VaultMirrorPusher {
  private app: AppLike;
  private api: BrainApiClient;
  private intervalMs: number;
  private onSyncComplete?: (result: { batches: number; upserted: number; deleted: number }) => void | Promise<void>;
  private log: (msg: string, ...rest: unknown[]) => void;
  private setIntervalFn: typeof setInterval;
  private clearIntervalFn: typeof clearInterval;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private syncing = false;
  private knownPaths = new Set<string>();

  constructor(opts: VaultMirrorPusherOptions) {
    this.app = opts.app;
    this.api = opts.api;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onSyncComplete = opts.onSyncComplete;
    this.log = opts.log ?? (() => {});
    this.setIntervalFn = opts._setInterval ?? setInterval.bind(globalThis);
    this.clearIntervalFn = opts._clearInterval ?? clearInterval.bind(globalThis);
  }

  /** Whether the pusher is currently registered + running. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Begin mirroring. Walks the vault and registers change listeners. Safe
   * to call multiple times — subsequent calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    await this.syncNow();
    this.intervalHandle = this.setIntervalFn(() => {
      void this.syncNow();
    }, this.intervalMs);
  }

  /** Stop mirroring. Cancels the scheduled index refresh. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Walk every markdown file in the vault and push index-only batches. Skips
   * unsupported extensions. Called by `start()`, by the interval, and by the
   * Settings "Sync now" button.
   */
  async syncNow(): Promise<{ batches: number; upserted: number; deleted: number }> {
    if (this.syncing) {
      return { batches: 0, upserted: 0, deleted: 0 };
    }
    this.syncing = true;
    const files = this.app.vault.getMarkdownFiles();
    const currentPaths = new Set(files.map(f => f.path).filter(isSupportedExtension));
    const deletes = Array.from(this.knownPaths).filter(path => !currentPaths.has(path));
    let batches = 0;
    let upserted = 0;
    let deleted = 0;
    try {
      for (let i = 0; i < Math.max(files.length, deletes.length); i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);
        const deleteBatch = deletes.slice(i, i + BATCH_SIZE);
        const upserts = await this.buildUpserts(batch);
        if (upserts.length === 0 && deleteBatch.length === 0) {
          continue;
        }
        const res = await this.api.pushVaultFiles({ upserts, deletes: deleteBatch });
        batches += 1;
        if (res.ok) {
          upserted += res.upserted ?? upserts.length;
          deleted += res.deleted ?? deleteBatch.length;
        } else {
          this.log('[vault-mirror] push failed', res);
        }
      }
      this.knownPaths = currentPaths;
      await this.onSyncComplete?.({ batches, upserted, deleted });
      return { batches, upserted, deleted };
    } finally {
      this.syncing = false;
    }
  }

  private async buildUpserts(files: TFile[]): Promise<Array<{
    path: string;
    mtime: string;
    size_bytes: number;
    content?: string;
    content_hash?: string;
  }>> {
    const out: Array<{ path: string; mtime: string; size_bytes: number; content?: string; content_hash?: string }> = [];
    for (const file of files) {
      const stat = file.stat;
      const mtime = stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString();
      const sizeBytes = stat?.size ?? 0;
      const entry: { path: string; mtime: string; size_bytes: number } = {
        path: file.path,
        mtime,
        size_bytes: sizeBytes,
      };
      if (shouldMirrorDailyNoteContent(file.path, sizeBytes)) {
        const content = await this.app.vault.read(file);
        out.push({
          ...entry,
          content,
          content_hash: await sha256Hex(content),
        });
        continue;
      }
      out.push(entry);
    }
    return out;
  }
}

function isSupportedExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return SUPPORTED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function shouldMirrorDailyNoteContent(path: string, sizeBytes: number): boolean {
  return sizeBytes <= DAILY_NOTE_CONTENT_MAX_BYTES && DAILY_NOTE_PATH_RE.test(path);
}
