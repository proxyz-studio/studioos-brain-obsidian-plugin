import { BrainApiClient } from '../api/client';
import { ChangeRow } from '../api/types';
import { VaultWriter } from './VaultWriter';

export type ChangesSyncerOpts = {
  api: BrainApiClient;
  writer: VaultWriter;

  /** Load persistence — return the saved cursor + etag from plugin data. */
  loadCursor: () => { since: string | null; etag: string | null };
  /** Persist cursor — called after each successful 200 response. */
  saveCursor: (since: string | null, etag: string | null) => Promise<void>;

  /** Called when /changes returns 401 (token revoked). Caller clears token + stops sync. */
  onUnauthorized: () => Promise<void> | void;

  /** Optional: called on any thrown/network error so caller can surface to user. */
  onError?: (err: unknown) => void;

  /** Poll interval in ms. Default 60 seconds. */
  intervalMs?: number;

  /** Test-only timer injection. */
  _setInterval?: typeof setInterval;
  _clearInterval?: typeof clearInterval;
};

const DEFAULT_INTERVAL_MS = 60 * 1000;

export class ChangesSyncer {
  private opts: ChangesSyncerOpts;
  private handle: ReturnType<typeof setInterval> | null = null;
  private setIntervalFn: typeof setInterval;
  private clearIntervalFn: typeof clearInterval;
  private running = false;

  constructor(opts: ChangesSyncerOpts) {
    this.opts = opts;
    this.setIntervalFn = opts._setInterval ?? setInterval;
    this.clearIntervalFn = opts._clearInterval ?? clearInterval;
  }

  start() {
    if (this.handle) return;
    void this.tick();
    this.handle = this.setIntervalFn(
      () => void this.tick(),
      this.opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
  }

  stop() {
    if (this.handle) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  /** Public for manual sync-now triggers (e.g., Settings button later). */
  async tick(): Promise<void> {
    if (this.running) return; // skip if previous tick still running
    this.running = true;
    try {
      const { since, etag } = this.opts.loadCursor();
      const result = await this.opts.api.getChanges({
        since: since ? new Date(since) : undefined,
        etag: etag ?? undefined,
      });

      if (result.status === 401) {
        await this.opts.onUnauthorized();
        this.stop();
        return;
      }
      if (result.notModified) return;
      if (!result.data) return; // non-OK non-304 — error

      await this.applyChanges(result.data.changes);

      // Persist new cursor — use the largest updated_at in the batch as the next since.
      const newSince = newestUpdatedAt(result.data.changes, since);
      await this.opts.saveCursor(newSince, result.data.etag);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.running = false;
    }
  }

  private async applyChanges(changes: ChangeRow[]): Promise<void> {
    for (const ch of changes) {
      if (!ch.path) continue; // unstamped — server should have filtered (D11), defensive
      if (ch.deleted_at) {
        await this.opts.writer.delete(ch.path);
      } else {
        await this.opts.writer.write(ch.path, ch.content);
      }
    }
  }
}

function newestUpdatedAt(changes: ChangeRow[], current: string | null): string | null {
  let max = current;
  for (const ch of changes) {
    if (!max || ch.updated_at > max) max = ch.updated_at;
  }
  return max;
}
