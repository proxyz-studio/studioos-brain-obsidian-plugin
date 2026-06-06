import type { BrainApiClient } from '../api/client';
import type { PendingAttachment, PendingInit } from '../api/types';

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
  vault: { adapter: { writeBinary(path: string, data: ArrayBuffer): Promise<void>; write(path: string, content: string): Promise<void>; } };
  onError?: (err: Error) => void;
};

export class PendingWritesPuller {
  private api: BrainApiClient;
  private vault: PendingWritesPullerOpts['vault'];
  private onError?: (err: Error) => void;

  constructor(opts: PendingWritesPullerOpts) {
    this.api = opts.api;
    this.vault = opts.vault;
    this.onError = opts.onError;
  }

  async tick(result: { pendingAttachments: PendingAttachment[]; pendingInits: PendingInit[] }): Promise<void> {
    for (const att of result.pendingAttachments) {
      try {
        const blob = await this.api.fetchAttachmentBlob(att.id);
        if (!blob) {
          this.onError?.(new Error(`attachment_blob_missing: ${att.id}`));
          continue;
        }
        await this.vault.adapter.writeBinary(att.vaultPath, blob.blob);
        await this.api.postAttachmentApplied(att.id);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    for (const init of result.pendingInits) {
      try {
        await this.vault.adapter.write(init.vaultPath, init.content);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (result.pendingInits.length > 0) {
      try {
        await this.api.postInitApplied();
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
