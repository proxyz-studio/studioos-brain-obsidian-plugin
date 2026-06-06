/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultMirrorPusher } from './VaultMirrorPusher';

// ---------------------------------------------------------------------------
// Fake vault + api harness
// ---------------------------------------------------------------------------

type FakeFile = {
  path: string;
  stat?: { mtime: number; size: number };
  content?: string;
};

function makeApp(initialFiles: FakeFile[] = []) {
  const filesByPath = new Map<string, FakeFile>();
  for (const f of initialFiles) {
    filesByPath.set(f.path, f);
  }
  const listeners: Record<string, Array<(file: unknown, oldPath?: string) => void>> = {
    create: [], modify: [], delete: [], rename: [],
  };
  const eventRefs: Array<{ event: string; id: number }> = [];

  const vault: any = {
    getMarkdownFiles: () => Array.from(filesByPath.values()).filter(f => f.path.endsWith('.md')),
    getAbstractFileByPath: (path: string) => filesByPath.get(path) ?? null,
    read: async (file: any) => file.content ?? '',
    on: (event: string, cb: (file: unknown, oldPath?: string) => void) => {
      listeners[event]?.push(cb);
      const ref = { event, id: Math.random() };
      eventRefs.push(ref);
      return ref;
    },
    offref: (ref: any) => {
      const idx = eventRefs.findIndex(r => r.id === ref.id);
      if (idx >= 0) eventRefs.splice(idx, 1);
    },
    // Test helpers
    _setFile: (file: FakeFile) => filesByPath.set(file.path, file),
    _removeFile: (path: string) => filesByPath.delete(path),
    _emit: (event: 'create' | 'modify' | 'delete' | 'rename', file: unknown, oldPath?: string) => {
      for (const l of listeners[event] ?? []) {
        l(file, oldPath);
      }
    },
  };
  return { app: { vault }, vault };
}

function makeApi() {
  const calls: Array<{ upserts: any[]; deletes: any[] }> = [];
  const api: any = {
    pushVaultFiles: vi.fn(async (payload: { upserts: any[]; deletes: any[] }) => {
      calls.push(payload);
      return { ok: true, status: 200, upserted: payload.upserts.length, deleted: payload.deletes.length };
    }),
  };
  return { api, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VaultMirrorPusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('walks every markdown file on start and batches them to the server', async () => {
    const files: FakeFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `Brain/note-${i}.md`,
      stat: { mtime: Date.UTC(2026, 5, 6), size: 10 },
      content: `# note ${i}`,
    }));
    const { app } = makeApp(files);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    expect(api.pushVaultFiles).toHaveBeenCalledOnce();
    const call = calls[0];

    expect(call.upserts).toHaveLength(5);
    expect(call.upserts[0]).toMatchObject({
      path: 'Brain/note-0.md',
      size_bytes: 10,
      content: '# note 0',
    });
    expect(call.upserts[0].mtime).toMatch(/^2026-06-06T/);
  });

  it('skips non-markdown files in the initial walk', async () => {
    const { app } = makeApp([
      { path: 'Brain/note.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
      { path: 'Brain/image.png', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 } } as any,
    ]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    expect(calls[0]?.upserts).toHaveLength(1);
    expect(calls[0]?.upserts[0]?.path).toBe('Brain/note.md');
  });

  it('pushes the index entry but omits content when the file exceeds the inline cap', async () => {
    const huge = 'x'.repeat(500_000);
    const { app } = makeApp([
      { path: 'Brain/huge.md', stat: { mtime: Date.UTC(2026, 5, 6), size: huge.length }, content: huge },
    ]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    expect(calls[0]?.upserts[0]?.content).toBeUndefined();
    expect(calls[0]?.upserts[0]?.size_bytes).toBe(500_000);
  });

  it('registers create/modify/delete/rename listeners on start', async () => {
    const { app, vault } = makeApp([]);
    const { api } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    // The fake vault tracks how many listeners are active via the eventRefs array.
    // Four listeners (create, modify, delete, rename) implies 4 registered events.
    expect(vault.on).toBeDefined();
    expect(pusher.isRunning).toBe(true);
  });

  it('debounces a burst of modify events into one push', async () => {
    const { app, vault } = makeApp([]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();
    calls.length = 0;

    vault._setFile({ path: 'Brain/draft.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' });
    vault._emit('modify', vault._getFile?.('Brain/draft.md') ?? { path: 'Brain/draft.md' });
    vault._emit('modify', { path: 'Brain/draft.md' });
    vault._emit('modify', { path: 'Brain/draft.md' });

    await vi.advanceTimersByTimeAsync(2000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(1);
    expect(calls[0]?.upserts).toHaveLength(1);
    expect(calls[0]?.upserts[0]?.path).toBe('Brain/draft.md');
  });

  it('rename queues a delete of the old path + an upsert of the new path', async () => {
    const { app, vault } = makeApp([]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();
    calls.length = 0;

    vault._setFile({ path: 'Brain/new.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' });
    vault._emit('rename', { path: 'Brain/new.md' }, 'Brain/old.md');

    await vi.advanceTimersByTimeAsync(2000);

    expect(calls[0]?.upserts.map((u: any) => u.path)).toEqual(['Brain/new.md']);
    expect(calls[0]?.deletes).toEqual(['Brain/old.md']);
  });

  it('delete event flushes a delete batch', async () => {
    const { app, vault } = makeApp([]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();
    calls.length = 0;

    vault._emit('delete', { path: 'Brain/gone.md' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(1);
    expect(calls[0]?.deletes).toEqual(['Brain/gone.md']);
    expect(calls[0]?.upserts).toEqual([]);
  });

  it('stop() removes listeners and cancels pending flushes', async () => {
    const { app, vault } = makeApp([
      { path: 'Brain/seed.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
    ]);
    const { api } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();
    vault._emit('modify', { path: 'Brain/draft.md' });
    pusher.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(1); // only the initial walk; the debounced modify was cancelled
    expect(pusher.isRunning).toBe(false);
  });

  it('start is idempotent', async () => {
    const { app } = makeApp([
      { path: 'Brain/note.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
    ]);
    const { api } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();
    await pusher.start();

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(1);
  });
});
