import { App, Notice, normalizePath } from 'obsidian';
import { BrainApiClient } from '../api/client';
import { VaultWriter } from './VaultWriter';
import { buildConflictFile } from './conflictFile';
import { buildUploadPayload } from './uploadPayload';

const BRAIN_FOLDER = '05-BRAIN';
const DEBOUNCE_MS = 500;

export type FileWatcherOpts = {
  app: App;
  api: BrainApiClient;
  writer: VaultWriter;

  /** Generate a request UUID for Flow B idempotency. */
  newRequestId: () => string;

  /** Read the last known server hash for a given brain_id (or null if unknown).
   *  Caller maintains this map from /changes responses. */
  getLastKnownServerHash: (brainId: string) => string | null;

  /** Optional surface for user-facing errors. */
  onError?: (msg: string, err: unknown) => void;

  /** Test-only timer + Date injection. */
  _setTimeout?: typeof setTimeout;
  _clearTimeout?: typeof clearTimeout;
  _now?: () => Date;
};

export class FileWatcher {
  private opts: FileWatcherOpts;
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners: (() => void)[] = [];
  private setTimeoutFn: typeof setTimeout;
  private clearTimeoutFn: typeof clearTimeout;
  private nowFn: () => Date;

  constructor(opts: FileWatcherOpts) {
    this.opts = opts;
    this.setTimeoutFn = opts._setTimeout ?? setTimeout;
    this.clearTimeoutFn = opts._clearTimeout ?? clearTimeout;
    this.nowFn = opts._now ?? (() => new Date());
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

  /** Queue a file for debounced upload. Public for direct testing.
   *  Returns the pending flush promise if one was scheduled (for test awaiting). */
  queueUpload(path: string): void {
    const normalized = normalizePath(path);
    if (!normalized.startsWith(`${BRAIN_FOLDER}/`)) return;
    if (normalized.includes(' (conflict ')) return; // skip conflict files
    const prev = this.pending.get(normalized);
    if (prev !== undefined) this.clearTimeoutFn(prev);
    const timer = this.setTimeoutFn(() => {
      this.pending.delete(normalized);
      void this.flush(normalized);
    }, DEBOUNCE_MS);
    this.pending.set(normalized, timer);
  }

  private queueIfInBrainFolder(file: unknown): void {
    if (!isTFile(file)) return;
    this.queueUpload(file.path);
  }

  private queueDeleteIfInBrainFolder(file: unknown): void {
    if (!isTFile(file)) return;
    if (!file.path.startsWith(`${BRAIN_FOLDER}/`)) return;
    // Proper delete handling needs a path→brainId index — deferred to PR-5 polish.
    this.opts.onError?.('File deletion sync deferred to PR-5 polish.', new Error('not_implemented_yet'));
  }

  /** Exposed for test assertions — tests can call this directly to skip the debounce. */
  async flush(path: string): Promise<void> {
    try {
      const exists = await this.opts.writer.exists(path);
      if (!exists) return; // file deleted between queue and flush

      const content = await this.opts.writer.read(path);

      // Extract brain_id via regex to look up last_known_server_hash
      const brainIdMatch = content.match(/^\s*---\s*\n[\s\S]*?\bbrain_id:\s*(\S+)/m);
      const brainId = brainIdMatch?.[1] ?? null;
      const lastKnownServerHash = brainId ? this.opts.getLastKnownServerHash(brainId) : null;

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
        const r = await this.opts.api.uploadFlowB(decision.payload);
        if (!r.ok) this.opts.onError?.(`Upload failed: ${r.code}`, new Error(r.code));
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
      if (!r.ok) {
        this.opts.onError?.(`Upload failed: ${r.code}`, new Error(r.code));
      }
    } catch (err) {
      this.opts.onError?.('Sync upload threw', err);
    }
  }
}

function isTFile(x: unknown): x is { path: string } {
  return typeof x === 'object' && x !== null && 'path' in x && typeof (x as { path: unknown }).path === 'string';
}
