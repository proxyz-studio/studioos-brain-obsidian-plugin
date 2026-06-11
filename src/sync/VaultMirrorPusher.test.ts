/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VaultMirrorPusher } from './VaultMirrorPusher';

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

  const vault: any = {
    getMarkdownFiles: () => Array.from(filesByPath.values()).filter(f => f.path.endsWith('.md')),
    read: vi.fn(async (file: any) => file.content ?? ''),
    on: vi.fn(),
    offref: vi.fn(),
    _setFile: (file: FakeFile) => filesByPath.set(file.path, file),
    _removeFile: (path: string) => filesByPath.delete(path),
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

describe('VaultMirrorPusher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('walks every markdown file on start and pushes index-only batches', async () => {
    const files: FakeFile[] = Array.from({ length: 5 }, (_, i) => ({
      path: `Brain/note-${i}.md`,
      stat: { mtime: Date.UTC(2026, 5, 6), size: 10 },
      content: `# note ${i}`,
    }));
    const { app, vault } = makeApp(files);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    expect(api.pushVaultFiles).toHaveBeenCalledOnce();
    expect(vault.read).not.toHaveBeenCalled();
    expect(calls[0]?.upserts).toHaveLength(5);
    expect(calls[0]?.upserts[0]).toMatchObject({
      path: 'Brain/note-0.md',
      size_bytes: 10,
    });
    expect(calls[0]?.upserts[0]?.content).toBeUndefined();
    expect(calls[0]?.upserts[0].mtime).toMatch(/^2026-06-06T/);
  });

  it('includes content for small daily notes so StudioOS Today can render them', async () => {
    const files: FakeFile[] = [
      {
        path: '01-DAILY/2026-06-10.md',
        stat: { mtime: Date.UTC(2026, 5, 10, 1), size: 24 },
        content: '# Wednesday\n\nReal note.',
      },
      {
        path: 'Daily Notes/2026-06-10.md',
        stat: { mtime: Date.UTC(2026, 5, 10, 1), size: 19 },
        content: '# Default daily.',
      },
      {
        path: '01-DAILY/2026/2026-06/2026-W24/2026-06-10.md',
        stat: { mtime: Date.UTC(2026, 5, 10, 1), size: 25 },
        content: '# Nested daily note.',
      },
      {
        path: 'Brain/note.md',
        stat: { mtime: Date.UTC(2026, 5, 10, 1), size: 8 },
        content: '# Normal',
      },
    ];
    const { app, vault } = makeApp(files);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    expect(vault.read).toHaveBeenCalledTimes(3);
    expect(calls[0]?.upserts).toHaveLength(4);
    expect(calls[0]?.upserts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '01-DAILY/2026-06-10.md',
        content: '# Wednesday\n\nReal note.',
        content_hash: expect.any(String),
      }),
      expect.objectContaining({
        path: 'Daily Notes/2026-06-10.md',
        content: '# Default daily.',
        content_hash: expect.any(String),
      }),
      expect.objectContaining({
        path: '01-DAILY/2026/2026-06/2026-W24/2026-06-10.md',
        content: '# Nested daily note.',
        content_hash: expect.any(String),
      }),
    ]));
    const normalNote = calls[0]?.upserts.find(u => u.path === 'Brain/note.md');
    expect(normalNote?.content).toBeUndefined();
    expect(normalNote?.content_hash).toBeUndefined();
  });

  it('pushes today\'s daily note content in a dedicated safety pass', async () => {
    const files: FakeFile[] = [
      {
        path: '01-DAILY/2026/2026-06/2026-W24/2026-06-11.md',
        stat: { mtime: Date.UTC(2026, 5, 11, 6, 36), size: 28 },
        content: '# Thursday\n\nToday matters.',
      },
      {
        path: 'Brain/note.md',
        stat: { mtime: Date.UTC(2026, 5, 11, 6, 37), size: 8 },
        content: '# Normal',
      },
    ];
    const { app } = makeApp(files);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({
      app: app as any,
      api,
      _now: () => new Date('2026-06-11T09:00:00.000Z'),
    });

    const result = await pusher.syncNow();

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(2);
    expect(result.batches).toBe(2);
    expect(calls[1]?.deletes).toEqual([]);
    expect(calls[1]?.upserts).toEqual([
      expect.objectContaining({
        path: '01-DAILY/2026/2026-06/2026-W24/2026-06-11.md',
        content: '# Thursday\n\nToday matters.',
        content_hash: expect.any(String),
      }),
    ]);
  });

  it('skips non-markdown files in the index walk', async () => {
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

  it('does not register vault create/modify/delete/rename listeners', async () => {
    const { app, vault } = makeApp([]);
    const { api } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();

    expect(vault.on).not.toHaveBeenCalled();
    expect(pusher.isRunning).toBe(true);
  });

  it('refreshes the index on the configured interval', async () => {
    const { app, vault } = makeApp([
      { path: 'Brain/seed.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
    ]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api, intervalMs: 1000 });

    await pusher.start();
    vault._setFile({ path: 'Brain/next.md', stat: { mtime: Date.UTC(2026, 5, 7), size: 2 }, content: 'b' });
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(2);
    expect(calls[1]?.upserts.map(u => u.path).sort()).toEqual(['Brain/next.md', 'Brain/seed.md']);
  });

  it('runs one delayed startup retry after Obsidian has hydrated files', async () => {
    const { app, vault } = makeApp([]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api, intervalMs: 60_000 });

    await pusher.start();
    vault._setFile({ path: 'Brain/loaded-after-start.md', stat: { mtime: Date.UTC(2026, 5, 11), size: 1 }, content: 'a' });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(1);
    expect(calls[0]?.upserts.map(u => u.path)).toEqual(['Brain/loaded-after-start.md']);
  });

  it('cancels the delayed startup retry on stop', async () => {
    const { app, vault } = makeApp([]);
    const { api } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api });

    await pusher.start();
    pusher.stop();
    vault._setFile({ path: 'Brain/loaded-after-stop.md', stat: { mtime: Date.UTC(2026, 5, 11), size: 1 }, content: 'a' });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(api.pushVaultFiles).not.toHaveBeenCalled();
  });

  it('syncNow runs a manual refresh and calls onSyncComplete', async () => {
    const { app } = makeApp([
      { path: 'Brain/manual.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
    ]);
    const { api } = makeApi();
    const onSyncComplete = vi.fn();
    const pusher = new VaultMirrorPusher({ app: app as any, api, onSyncComplete });

    const result = await pusher.syncNow();

    expect(result).toEqual({ batches: 1, upserted: 1, deleted: 0 });
    expect(onSyncComplete).toHaveBeenCalledWith({ batches: 1, upserted: 1, deleted: 0 });
  });

  it('sends deletes for paths missing from a later scheduled walk', async () => {
    const { app, vault } = makeApp([
      { path: 'Brain/keep.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
      { path: 'Brain/remove.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'b' },
    ]);
    const { api, calls } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api, intervalMs: 1000 });

    await pusher.start();
    calls.length = 0;
    vault._removeFile('Brain/remove.md');
    await vi.advanceTimersByTimeAsync(1000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(2);
    expect(calls[0]?.deletes).toEqual(['Brain/remove.md']);
  });

  it('stop cancels scheduled refreshes', async () => {
    const { app } = makeApp([
      { path: 'Brain/seed.md', stat: { mtime: Date.UTC(2026, 5, 6), size: 1 }, content: 'a' },
    ]);
    const { api } = makeApi();
    const pusher = new VaultMirrorPusher({ app: app as any, api, intervalMs: 1000 });

    await pusher.start();
    pusher.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(api.pushVaultFiles).toHaveBeenCalledTimes(1);
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
