import type { EventRef, TFile, Vault } from 'obsidian';

import type { BrainApiClient } from '../api/client';

/**
 * Maximum upserts per server batch. Mirrors the cap on
 * POST /api/brain/sync/vault-files. Larger walks paginate locally.
 */
const BATCH_SIZE = 250;

/**
 * Files larger than this are pushed as "index-only" (path + mtime + size,
 * no content). The web UI's preview endpoint will fall through to a
 * `pending` state for those files until we either lift the cap or
 * implement on-demand fetching. Mirrors the server's 500kB content cap
 * with a 100kB safety margin so headers + JSON envelope stay under
 * the limit.
 */
const MAX_INLINE_CONTENT = 400_000;

/**
 * Coalesce filesystem events for this many ms before flushing. Obsidian
 * fires `modify` repeatedly while a user types — debouncing keeps the
 * server burn rate sane and lets edits settle before we push.
 */
const DEBOUNCE_MS = 1500;

/**
 * Skip files that obviously aren't user-authored Obsidian content. We
 * push markdown only on first pass; future iterations can extend to
 * attachments once the server's content cap is generous enough.
 */
const SUPPORTED_EXTENSIONS = new Set(['md']);

type PendingChange =
  | { kind: 'upsert'; path: string }
  | { kind: 'delete'; path: string };

type AppLike = {
  vault: Vault;
};

export type VaultMirrorPusherOptions = {
  app: AppLike;
  api: BrainApiClient;
  /** Optional logger — defaults to noop in production. */
  log?: (msg: string, ...rest: unknown[]) => void;
};

/**
 * VaultMirrorPusher — keeps the StudioOS server's `obsidian_vault_files`
 * cache in sync with the user's local Obsidian vault.
 *
 * Lifecycle:
 *   - `start()` performs the initial walk: enumerate every markdown file,
 *     batch them, push to the server.
 *   - While running, registers vault create/modify/delete/rename events.
 *     Each event queues a debounced flush.
 *   - `stop()` removes the listeners and cancels pending timers.
 *
 * Push semantics:
 *   - Files <= MAX_INLINE_CONTENT are pushed with `content` populated.
 *   - Larger files push only path + mtime + size; the server records the
 *     index entry and the web UI shows a "pending" state until we lift
 *     the cap or add on-demand fetching.
 */
export class VaultMirrorPusher {
  private app: AppLike;
  private api: BrainApiClient;
  private log: (msg: string, ...rest: unknown[]) => void;

  private eventRefs: EventRef[] = [];
  private pending = new Map<string, PendingChange>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: VaultMirrorPusherOptions) {
    this.app = opts.app;
    this.api = opts.api;
    this.log = opts.log ?? (() => {});
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
    this.registerListeners();
    await this.initialWalk();
  }

  /** Stop mirroring. Removes listeners and cancels pending timers. */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    for (const ref of this.eventRefs) {
      this.app.vault.offref(ref);
    }
    this.eventRefs = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pending.clear();
  }

  /**
   * Walk every markdown file in the vault and push in batches. Skips
   * unsupported extensions. Called by `start()` but also exposed so the
   * settings UI can offer a "Resync vault" affordance later.
   */
  async initialWalk(): Promise<{ batches: number; upserted: number }> {
    const files = this.app.vault.getMarkdownFiles();
    let batches = 0;
    let upserted = 0;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      const upserts = await this.buildUpserts(batch);
      if (upserts.length === 0) {
        continue;
      }
      const res = await this.api.pushVaultFiles({ upserts, deletes: [] });
      batches += 1;
      if (res.ok) {
        upserted += res.upserted ?? upserts.length;
      } else {
        this.log('[vault-mirror] push failed', res);
      }
    }
    return { batches, upserted };
  }

  /** Test hook + debug surface — returns the queue size without flushing. */
  pendingCount(): number {
    return this.pending.size;
  }

  /** Test hook — fire the queue immediately. */
  async flushNow(): Promise<{ upserted: number; deleted: number } | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    return this.drain();
  }

  private registerListeners(): void {
    const v = this.app.vault;
    this.eventRefs.push(v.on('create', file => this.handleChange('upsert', file)));
    this.eventRefs.push(v.on('modify', file => this.handleChange('upsert', file)));
    this.eventRefs.push(v.on('delete', file => this.handleChange('delete', file)));
    this.eventRefs.push(v.on('rename', (file, oldPath) => {
      // Treat rename as `delete(old) + upsert(new)` — same effect on the
      // server's path-keyed table and keeps the queue simple.
      this.pending.set(oldPath, { kind: 'delete', path: oldPath });
      this.handleChange('upsert', file);
    }));
  }

  private handleChange(kind: 'upsert' | 'delete', file: unknown): void {
    if (!isTFile(file)) {
      return;
    }
    if (!isSupportedExtension(file.path)) {
      return;
    }
    this.pending.set(file.path, { kind, path: file.path });
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.drain();
    }, DEBOUNCE_MS);
  }

  private async drain(): Promise<{ upserted: number; deleted: number } | null> {
    if (this.pending.size === 0) {
      return null;
    }
    const upsertPaths: string[] = [];
    const deletes: string[] = [];
    for (const change of this.pending.values()) {
      if (change.kind === 'delete') {
        deletes.push(change.path);
      } else {
        upsertPaths.push(change.path);
      }
    }
    this.pending.clear();

    const upsertFiles = upsertPaths
      .map(p => this.app.vault.getAbstractFileByPath(p))
      .filter(isTFile);
    const upserts = await this.buildUpserts(upsertFiles);

    let upserted = 0;
    let deleted = 0;
    // Chunk if we somehow built more than the server cap (huge bulk renames).
    for (let i = 0; i < Math.max(upserts.length, deletes.length); i += BATCH_SIZE) {
      const batchUpserts = upserts.slice(i, i + BATCH_SIZE);
      const batchDeletes = deletes.slice(i, i + BATCH_SIZE);
      if (batchUpserts.length === 0 && batchDeletes.length === 0) {
        continue;
      }
      const res = await this.api.pushVaultFiles({ upserts: batchUpserts, deletes: batchDeletes });
      if (res.ok) {
        upserted += res.upserted ?? batchUpserts.length;
        deleted += res.deleted ?? batchDeletes.length;
      } else {
        this.log('[vault-mirror] flush failed', res);
      }
    }
    return { upserted, deleted };
  }

  private async buildUpserts(files: TFile[]): Promise<Array<{
    path: string;
    mtime: string;
    size_bytes: number;
    content?: string;
  }>> {
    const out: Array<{ path: string; mtime: string; size_bytes: number; content?: string }> = [];
    for (const file of files) {
      const stat = file.stat;
      const mtime = stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString();
      const sizeBytes = stat?.size ?? 0;
      const entry: { path: string; mtime: string; size_bytes: number; content?: string } = {
        path: file.path,
        mtime,
        size_bytes: sizeBytes,
      };
      if (sizeBytes > 0 && sizeBytes <= MAX_INLINE_CONTENT) {
        try {
          entry.content = await this.app.vault.read(file);
        } catch (err) {
          this.log('[vault-mirror] read failed; pushing index-only', file.path, err);
        }
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

function isTFile(x: unknown): x is TFile {
  if (!x || typeof x !== 'object') {
    return false;
  }
  return typeof (x as { path?: unknown }).path === 'string';
}
