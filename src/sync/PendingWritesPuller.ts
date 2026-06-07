import type { BrainApiClient } from '../api/client';
import type { PendingAttachment, PendingInit } from '../api/types';
import type { VaultWriter } from './VaultWriter';

/**
 * Pulls pending server-authored writes (init files + attachments) from StudioOS
 * and applies them to the local Obsidian vault. Runs as a tick inside the
 * existing sync loop, right after ChangesSyncer.
 *
 * Idempotency: if the plugin crashes mid-write, the next tick picks up the same
 * attachments (applied_at is still null) and writes them again. Filesystem write
 * is idempotent (overwrite). The /applied POST is also idempotent server-side.
 */
export type PendingWritesPullerOpts = {
  api: BrainApiClient;
  writer: VaultWriter;
  onError?: (err: Error) => void;
};

export class PendingWritesPuller {
  private api: BrainApiClient;
  private writer: VaultWriter;
  private onError?: (err: Error) => void;

  constructor(opts: PendingWritesPullerOpts) {
    this.api = opts.api;
    this.writer = opts.writer;
    this.onError = opts.onError;
  }

  async tick(result: { pendingAttachments: PendingAttachment[]; pendingInits: PendingInit[] }): Promise<boolean> {
    let ok = true;

    for (const att of result.pendingAttachments) {
      try {
        const blob = await this.api.fetchAttachmentBlob(att.id);
        if (!blob) {
          ok = false;
          this.onError?.(new Error(`attachment_blob_missing: ${att.id}`));
          continue;
        }
        await this.writer.writeBinary(att.vaultPath, blob.blob);
        const applied = await this.api.postAttachmentApplied(att.id);
        if (!applied) {
          ok = false;
          this.onError?.(new Error(`attachment_apply_failed: ${att.id}`));
        }
      } catch (err) {
        ok = false;
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    for (const init of result.pendingInits) {
      try {
        await this.writer.write(init.vaultPath, init.content);
      } catch (err) {
        ok = false;
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (result.pendingInits.length > 0) {
      try {
        const applied = await this.api.postInitApplied();
        if (!applied) {
          ok = false;
          this.onError?.(new Error('init_apply_failed'));
        }
      } catch (err) {
        ok = false;
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return ok;
  }
}
