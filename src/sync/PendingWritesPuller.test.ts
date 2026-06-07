import { describe, expect, it, vi } from 'vitest';

import { PendingWritesPuller } from './PendingWritesPuller';
import { MemoryVaultWriter } from './VaultWriter';

function makeMockApi() {
  return {
    fetchAttachmentBlob: vi.fn(),
    postAttachmentApplied: vi.fn(),
    postInitApplied: vi.fn(),
  } as unknown as {
    fetchAttachmentBlob: ReturnType<typeof vi.fn>;
    postAttachmentApplied: ReturnType<typeof vi.fn>;
    postInitApplied: ReturnType<typeof vi.fn>;
  } & { vaultId: string };
}

describe('PendingWritesPuller', () => {
  it('downloads attachments and marks them applied', async () => {
    const api = makeMockApi();
    const writer = new MemoryVaultWriter();
    const puller = new PendingWritesPuller({ api: api as any, writer });

    api.fetchAttachmentBlob.mockResolvedValue({ blob: new ArrayBuffer(4), mime: 'image/png' });
    api.postAttachmentApplied.mockResolvedValue(true);

    const ok = await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(ok).toBe(true);
    expect(writer.calls).toContainEqual({
      op: 'writeBinary',
      path: 'Brain/attachments/2026-06-06-test.png',
      content: '4',
    });
    expect(api.postAttachmentApplied).toHaveBeenCalledWith('a1');
  });

  it('writes init files and posts init applied', async () => {
    const api = makeMockApi();
    const writer = new MemoryVaultWriter();
    const puller = new PendingWritesPuller({ api: api as any, writer });

    api.postInitApplied.mockResolvedValue(true);

    const ok = await puller.tick({
      pendingAttachments: [],
      pendingInits: [
        { vaultPath: 'Brain/README.md', content: '# Welcome' },
      ],
    });

    expect(ok).toBe(true);
    expect(writer.files.get('Brain/README.md')).toBe('# Welcome');
    expect(api.postInitApplied).toHaveBeenCalled();
  });

  it('calls onError when blob fetch fails', async () => {
    const api = makeMockApi();
    const writer = new MemoryVaultWriter();
    const onError = vi.fn();
    const puller = new PendingWritesPuller({ api: api as any, writer, onError });

    api.fetchAttachmentBlob.mockResolvedValue(null);

    const ok = await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalled();
    expect(writer.calls.filter(c => c.op === 'writeBinary')).toHaveLength(0);
  });

  it('survives a crash mid-write and resumes on next tick', async () => {
    const api = makeMockApi();
    const writer = new MemoryVaultWriter();
    const onError = vi.fn();
    const puller = new PendingWritesPuller({ api: api as any, writer, onError });

    api.fetchAttachmentBlob.mockResolvedValue({ blob: new ArrayBuffer(4), mime: 'image/png' });
    api.postAttachmentApplied.mockRejectedValue(new Error('network'));

    const ok = await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(ok).toBe(false);
    expect(writer.calls.some(c => c.op === 'writeBinary')).toBe(true);
    expect(api.postAttachmentApplied).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('returns false when attachment applied endpoint fails without throwing', async () => {
    const api = makeMockApi();
    const writer = new MemoryVaultWriter();
    const onError = vi.fn();
    const puller = new PendingWritesPuller({ api: api as any, writer, onError });

    api.fetchAttachmentBlob.mockResolvedValue({ blob: new ArrayBuffer(4), mime: 'image/png' });
    api.postAttachmentApplied.mockResolvedValue(false);

    const ok = await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'attachment_apply_failed: a1' }));
  });
});
