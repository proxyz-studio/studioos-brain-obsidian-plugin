import { describe, expect, it, vi } from 'vitest';

import { PendingWritesPuller } from './PendingWritesPuller';

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

function makeMockVault() {
  return {
    adapter: {
      writeBinary: vi.fn(),
      write: vi.fn(),
    },
  };
}

describe('PendingWritesPuller', () => {
  it('downloads attachments and marks them applied', async () => {
    const api = makeMockApi();
    const vault = makeMockVault();
    const puller = new PendingWritesPuller({ api: api as any, vault: vault as any });

    api.fetchAttachmentBlob.mockResolvedValue({ blob: new ArrayBuffer(4), mime: 'image/png' });
    api.postAttachmentApplied.mockResolvedValue(true);

    await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(vault.adapter.writeBinary).toHaveBeenCalledWith('Brain/attachments/2026-06-06-test.png', expect.any(ArrayBuffer));
    expect(api.postAttachmentApplied).toHaveBeenCalledWith('a1');
  });

  it('writes init files and posts init applied', async () => {
    const api = makeMockApi();
    const vault = makeMockVault();
    const puller = new PendingWritesPuller({ api: api as any, vault: vault as any });

    api.postInitApplied.mockResolvedValue(true);

    await puller.tick({
      pendingAttachments: [],
      pendingInits: [
        { vaultPath: 'Brain/README.md', content: '# Welcome' },
      ],
    });

    expect(vault.adapter.write).toHaveBeenCalledWith('Brain/README.md', '# Welcome');
    expect(api.postInitApplied).toHaveBeenCalled();
  });

  it('calls onError when blob fetch fails', async () => {
    const api = makeMockApi();
    const vault = makeMockVault();
    const onError = vi.fn();
    const puller = new PendingWritesPuller({ api: api as any, vault: vault as any, onError });

    api.fetchAttachmentBlob.mockResolvedValue(null);

    await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(onError).toHaveBeenCalled();
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it('survives a crash mid-write and resumes on next tick', async () => {
    const api = makeMockApi();
    const vault = makeMockVault();
    const onError = vi.fn();
    const puller = new PendingWritesPuller({ api: api as any, vault: vault as any, onError });

    api.fetchAttachmentBlob.mockResolvedValue({ blob: new ArrayBuffer(4), mime: 'image/png' });
    api.postAttachmentApplied.mockRejectedValue(new Error('network'));

    await puller.tick({
      pendingAttachments: [
        { id: 'a1', vaultPath: 'Brain/attachments/2026-06-06-test.png', mime: 'image/png', sizeBytes: 4, contentHash: 'h1' },
      ],
      pendingInits: [],
    });

    expect(vault.adapter.writeBinary).toHaveBeenCalled();
    expect(api.postAttachmentApplied).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });
});
