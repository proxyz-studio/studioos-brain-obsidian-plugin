import { App, Notice, normalizePath } from 'obsidian';
import { BrainApiClient } from '../api/client';
import { SyncIndex } from './SyncIndex';
import { VaultWriter } from './VaultWriter';
import { buildConflictFile } from './conflictFile';
import { buildUploadPayload } from './uploadPayload';

const BRAIN_FOLDER = '05-BRAIN';
const DEBOUNCE_MS = 500;

export type FileWatcherOpts = {
  app: App;
  api: BrainApiClient;
  writer: VaultWriter;

  /** Persistent bidirectional path↔brainId↔hash index. */
  syncIndex: SyncIndex;

  /** Persist the index after mutations (e.g. on successful upload or delete). */
  persistIndex: () => Promise<void>;

  /** Generate a request UUID for Flow B idempotency. */
  newRequestId: () => string;

  /** Optional surface for user-facing errors. */
  onError?: (msg: string, err: unknown) => void;

  /** Test-only timer + Date injection. */
  _setTimeout?: typeof setTimeout;
  _clearTimeout?: typeof clearTimeout;
  _now?: () => Date;
  /** Test-only wall-clock override for suppression logic. Default: Date.now */
  _nowMs?: () => number;
};

export class FileWatcher {
  private opts: FileWatcherOpts;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners: (() => void)[] = [];
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private nowFn: () => Date;
  private nowMsFn: () => number;
  /** In-flight flush paths — prevents concurrent flushes for the same path (M1). */
  private inFlight = new Set<string>();
  /** Suppress upload of paths written by ChangesSyncer to break the sync loop (M2). */
  private suppressUntil = new Map<string, number>();

  constructor(opts: FileWatcherOpts) {
    this.opts = opts;
    // .bind(globalThis) is mandatory — see HeartbeatScheduler.ts for context.
    // setTimeout/clearTimeout are methods of the global object and require
    // their original `this`. Storing them as instance properties and calling
    // `this.setTimeoutFn(...)` strips that and throws TypeError: Illegal
    // invocation at load time. Unit tests inject `_setTimeout`/`_clearTimeout`,
    // so they skip the native call — this can only be caught by a live install.
    this.setTimeoutFn = opts._setTimeout ?? setTimeout.bind(globalThis);
    this.clearTimeoutFn = opts._clearTimeout ?? clearTimeout.bind(globalThis);
    this.nowFn = opts._now ?? (() => new Date());
    this.nowMsFn = opts._nowMs ?? (() => Date.now());
  }

  start() {
    this.stop();
    const refModify = this.opts.app.vault.on('modify', file => void this.queueIfInBrainFolder(file));
    const refCreate = this.opts.app.vault.on('create', file => void this.queueIfInBrainFolder(file));
    const refDelete = this.opts.app.vault.on('delete', file => void this.queueDeleteIfInBrainFolder(file));
    this.listeners.push(
      () => this.opts.app.vault.offref(refModify),
      () => this.opts.app.vault.offref(refCreate),
      () => this.opts.app.vault.offref(refDelete),
    );
  }

  stop() {
    for (const off of this.listeners) off();
    this.listeners = [];
    for (const t of this.pending.values()) this.clearTimeoutFn(t);
    this.pending.clear();
  }

  /** Queue a file for debounced upload. Public for direct testing. */
  queueUpload(path: string): void {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${BRAIN_FOLDER}/`)) return;
    // Check server-write suppression to break the ChangesSyncer → FileWatcher loop (M2)
    const suppressedUntil = this.suppressUntil.get(normalized);
    if (suppressedUntil !== undefined) {
      if (suppressedUntil > this.nowMsFn()) return;
      // Suppression expired — clean up and proceed
      this.suppressUntil.delete(normalized);
    }
    const prev = this.pending.get(normalized);
    if (prev !== undefined) this.clearTimeoutFn(prev);
    const timer = this.setTimeoutFn(() => {
      this.pending.delete(normalized);
      void this.flush(normalized);
    }, DEBOUNCE_MS);
    this.pending.set(normalized, timer);
  }

  /** Suppress upload events for `path` for `durationMs` milliseconds.
   *  Called by ChangesSyncer's onChangeApplied to prevent re-uploading server writes (M2). */
  suppressPath(path: string, durationMs = 2000): void {
    const normalized = normalizePath(path);
    this.suppressUntil.set(normalized, this.nowMsFn() + durationMs);
  }

  private queueIfInBrainFolder(file: unknown): void {
    if (!isTFile(file)) return;
    this.queueUpload(file.path);
  }

  private queueDeleteIfInBrainFolder(file: unknown): void {
    if (!isTFile(file)) return;
    void this.handleDelete(file.path);
  }

  /** Exposed for direct testing without vault event plumbing. */
  async handleDelete(path: string): Promise<void> {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${BRAIN_FOLDER}/`)) return;
    if (normalized.includes(' (conflict ')) return; // conflict files are never tracked
    const entry = this.opts.syncIndex.getByPath(normalized);
    if (!entry) {
      // File was never synced server-side — nothing to delete
      return;
    }
    try {
      const r = await this.opts.api.deleteItem(entry.brainId);
      if (r.ok) {
        this.opts.syncIndex.deleteByPath(normalized);
        await this.opts.persistIndex();
      } else {
        this.opts.onError?.(`Delete sync failed: ${r.code}`, new Error(r.code));
      }
    } catch (err) {
      this.opts.onError?.('Delete sync threw', err);
    }
  }

  /** Exposed for test assertions — tests can call this directly to skip the debounce. */
  async flush(path: string): Promise<void> {
    // In-flight guard: skip concurrent flushes for the same path (M1)
    if (this.inFlight.has(path)) return;
    this.inFlight.add(path);
    try {
      const exists = await this.opts.writer.exists(path);
      if (!exists) return; // file deleted between queue and flush

      const content = await this.opts.writer.read(path);

      // Extract brain_id via regex to look up last_known_server_hash from the persistent index
      const brainIdMatch = content.match(/^\s*---\s*\n[\s\S]*?\bbrain_id:\s*(\S+)/m);
      const brainId = brainIdMatch?.[1] ?? null;
      const lastKnownServerHash = brainId ? this.opts.syncIndex.getHash(brainId) : null;

      const decision = await buildUploadPayload({
        path,
        content,
        requestUuid: this.opts.newRequestId(),
        lastKnownServerHash,
      });

      if (decision.kind === 'skip') {
        this.opts.onError?.(decision.reason, new Error('skipped'));
        return;
      }

      if (decision.kind === 'flowB') {
        const r = await this.opts.api.uploadFlowB(decision.payload, decision.idempotencyKey);
        if (r.ok) {
          // Update the index with the server-assigned brain_id + returned hash
          this.opts.syncIndex.set({ brainId: r.brain_id, path, contentHash: r.content_hash });
          await this.opts.persistIndex();
        } else {
          this.opts.onError?.(`Upload failed: ${r.code}`, new Error(r.code));
        }
        return;
      }

      // Flow C
      const r = await this.opts.api.uploadFlowC(decision.payload);
      if (!r.ok && r.code === 'hash_mismatch' && 'canonical' in r) {
        // 409 conflict — write companion file with loser content, overwrite original with winner
        const { conflictPath, conflictContent } = buildConflictFile({
          originalPath: path,
          loserContent: content,
          now: this.nowFn(),
        });
        await this.opts.writer.write(conflictPath, conflictContent);
        await this.opts.writer.write(path, r.canonical.content);
        new Notice(`StudioOS Brain: saved 2 versions of "${path.split('/').pop()}" — see (conflict) copy.`);
        return;
      }
      if (r.ok) {
        // Update hash in the index (brain_id is known for Flow C, hash may have changed)
        this.opts.syncIndex.set({ brainId: r.brain_id, path, contentHash: r.content_hash });
        await this.opts.persistIndex();
      } else {
        this.opts.onError?.(`Upload failed: ${r.code}`, new Error(r.code));
      }
    } catch (err) {
      this.opts.onError?.('Sync upload threw', err);
    } finally {
      this.inFlight.delete(path);
    }
  }
}

function isTFile(x: unknown): x is { path: string } {
  return typeof x === 'object' && x !== null && 'path' in x && typeof (x as { path: unknown }).path === 'string';
}
