import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangesSyncer, ChangesSyncerOpts } from './ChangesSyncer';
import { MemoryVaultWriter } from './VaultWriter';
import type { ChangeRow, ChangesResponse } from '../api/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    brain_id: 'id-1',
    op: 'upsert',
    path: '05-BRAIN/note.md',
    content: '# Hello',
    content_hash: 'abc123',
    sync_version: 1,
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeChangesResult(
  overrides: Partial<{ data: ChangesResponse | null; notModified: boolean; status: number }> = {},
) {
  return {
    data: { changes: [makeRow()], pendingAttachments: [], pendingInits: [], etag: '"etag-1"' },
    notModified: false,
    status: 200,
    ...overrides,
  };
}

type FakeTimers = {
  fakeSetInterval: ReturnType<typeof vi.fn>;
  fakeClearInterval: ReturnType<typeof vi.fn>;
  tick: () => void;
  activeCount: () => number;
};

function makeFakeTimers(): FakeTimers {
  let nextId = 1;
  const timers = new Map<number, () => void>();

  const fakeSetInterval = vi.fn((cb: () => void, _ms: number) => {
    const id = nextId++;
    timers.set(id, cb);
    return id as unknown as ReturnType<typeof setInterval>;
  });

  const fakeClearInterval = vi.fn((id: ReturnType<typeof setInterval>) => {
    timers.delete(id as unknown as number);
  });

  const tick = () => {
    for (const cb of timers.values()) cb();
  };

  const activeCount = () => timers.size;

  return { fakeSetInterval, fakeClearInterval, tick, activeCount };
}

type TestOpts = ChangesSyncerOpts & { memWriter: MemoryVaultWriter; _ft: FakeTimers };

function makeOpts(
  apiResult: ReturnType<typeof makeChangesResult> | (() => ReturnType<typeof makeChangesResult>),
  overrides: Partial<ChangesSyncerOpts> = {},
  ft: FakeTimers = makeFakeTimers(),
): TestOpts {
  const memWriter = new MemoryVaultWriter();
  const getChanges =
    typeof apiResult === 'function'
      ? vi.fn(apiResult)
      : vi.fn().mockResolvedValue(apiResult);
  const api = { getChanges } as unknown as ChangesSyncerOpts['api'];

  const cursor = { since: null as string | null, etag: null as string | null };
  const loadCursor = vi.fn(() => ({ since: cursor.since, etag: cursor.etag }));
  const saveCursor = vi.fn(async (s: string | null, e: string | null) => {
    cursor.since = s;
    cursor.etag = e;
  });
  const onUnauthorized = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();

  return {
    api,
    writer: memWriter,
    loadCursor,
    saveCursor,
    onUnauthorized,
    onError,
    intervalMs: 30_000,
    _setInterval: ft.fakeSetInterval as never,
    _clearInterval: ft.fakeClearInterval as never,
    memWriter,
    _ft: ft,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChangesSyncer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. tick() calls api.getChanges with since but intentionally omits stale etag
  it('calls getChanges with since and omits stale etag so pending writes can retry', async () => {
    const opts = makeOpts(makeChangesResult());
    // Pre-seed cursor so we can assert the values forwarded
    (opts.loadCursor as ReturnType<typeof vi.fn>).mockReturnValue({
      since: '2026-05-01T00:00:00.000Z',
      etag: '"etag-0"',
    });
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    expect(opts.api.getChanges).toHaveBeenCalledWith({
      since: new Date('2026-05-01T00:00:00.000Z'),
      etag: undefined,
    });
  });

  // 2. 200 with 2 changes calls writer.write for each
  it('writes each non-deleted change to the vault', async () => {
    const row1 = makeRow({ brain_id: 'a', path: '05-BRAIN/a.md', content: 'content a' });
    const row2 = makeRow({ brain_id: 'b', path: '05-BRAIN/b.md', content: 'content b' });
    const opts = makeOpts(
      makeChangesResult({ data: { changes: [row1, row2], pendingAttachments: [], pendingInits: [], etag: '"e"' } }),
    );
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    expect(opts.memWriter.files.get('05-BRAIN/a.md')).toBe('content a');
    expect(opts.memWriter.files.get('05-BRAIN/b.md')).toBe('content b');
  });

  // 3. deleted change calls writer.delete
  it('deletes a file when op is delete', async () => {
    // Pre-seed a file so delete can remove it
    const w = new MemoryVaultWriter();
    await w.write('05-BRAIN/gone.md', 'old content');
    const deletedRow = makeRow({ path: '05-BRAIN/gone.md', op: 'delete' });
    const opts = makeOpts(
      makeChangesResult({ data: { changes: [deletedRow], pendingAttachments: [], pendingInits: [], etag: '"e"' } }),
      { writer: w },
    );
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    expect(w.files.has('05-BRAIN/gone.md')).toBe(false);
  });

  // 4. 200 calls saveCursor with max updated_at + new etag
  it('saves cursor with max updated_at and new etag after 200', async () => {
    const rows = [
      makeRow({ updated_at: '2026-06-01T00:00:01.000Z' }),
      makeRow({ brain_id: 'id-2', path: '05-BRAIN/b.md', updated_at: '2026-06-02T00:00:00.000Z' }),
      makeRow({ brain_id: 'id-3', path: '05-BRAIN/c.md', updated_at: '2026-05-30T00:00:00.000Z' }),
    ];
    const opts = makeOpts(
      makeChangesResult({ data: { changes: rows, pendingAttachments: [], pendingInits: [], etag: '"new-etag"' } }),
    );
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    expect(opts.saveCursor).toHaveBeenCalledWith('2026-06-02T00:00:00.000Z', '"new-etag"');
  });

  it('does not save cursor or etag when pending write application fails', async () => {
    const puller = { tick: vi.fn().mockResolvedValue(false) };
    const opts = makeOpts(
      makeChangesResult({
        data: {
          changes: [],
          pendingAttachments: [
            { id: 'a1', vaultPath: 'Brain/attachments/a.png', mime: 'image/png', sizeBytes: 1, contentHash: 'h1' },
          ],
          pendingInits: [],
          etag: '"pending-etag"',
        },
      }),
      { puller: puller as never },
    );
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    expect(puller.tick).toHaveBeenCalled();
    expect(opts.saveCursor).not.toHaveBeenCalled();
  });

  // 5. 304 (notModified) — no writer calls, no saveCursor
  it('does nothing on 304 notModified', async () => {
    const opts = makeOpts(makeChangesResult({ data: null, notModified: true, status: 304 }));
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    const writeCalls = opts.memWriter.calls.filter(c => c.op === 'write' || c.op === 'delete');
    expect(writeCalls).toHaveLength(0);
    expect(opts.saveCursor).not.toHaveBeenCalled();
  });

  // 6. 401 calls onUnauthorized AND stops the scheduler
  it('calls onUnauthorized and stops on 401', async () => {
    const ft = makeFakeTimers();
    const opts = makeOpts(makeChangesResult({ data: null, notModified: false, status: 401 }), {}, ft);
    const syncer = new ChangesSyncer(opts);
    syncer.start();

    await new Promise<void>(r => setTimeout(r, 0));

    expect(opts.onUnauthorized).toHaveBeenCalledOnce();
    expect(ft.fakeClearInterval).toHaveBeenCalled();
    expect(ft.activeCount()).toBe(0);
  });

  // 7. thrown error from getChanges calls onError, scheduler keeps running
  it('calls onError on thrown error but keeps running', async () => {
    const ft = makeFakeTimers();
    const err = new Error('network fail');
    const opts = makeOpts(() => { throw err; }, {}, ft);
    const syncer = new ChangesSyncer(opts);
    syncer.start();

    await new Promise<void>(r => setTimeout(r, 0));

    expect(opts.onError).toHaveBeenCalledWith(err);
    // interval still registered (scheduler not stopped)
    expect(ft.activeCount()).toBe(1);
  });

  // 8. start() fires immediate tick + schedules subsequent ticks
  it('fires an immediate tick and registers an interval on start()', async () => {
    const ft = makeFakeTimers();
    const opts = makeOpts(makeChangesResult(), {}, ft);
    const syncer = new ChangesSyncer(opts);
    syncer.start();

    await new Promise<void>(r => setTimeout(r, 0)); // flush immediate tick

    expect(opts.api.getChanges).toHaveBeenCalledOnce(); // immediate tick
    expect(ft.fakeSetInterval).toHaveBeenCalledOnce(); // interval registered

    // fire the interval callback
    ft.tick();
    await new Promise<void>(r => setTimeout(r, 0));

    expect(opts.api.getChanges).toHaveBeenCalledTimes(2); // interval tick
  });

  // 9. start() is idempotent
  it('start() is idempotent — double-calling registers only one interval', async () => {
    const ft = makeFakeTimers();
    const opts = makeOpts(makeChangesResult(), {}, ft);
    const syncer = new ChangesSyncer(opts);
    syncer.start();
    syncer.start(); // second call must be no-op

    await new Promise<void>(r => setTimeout(r, 0));

    expect(ft.fakeSetInterval).toHaveBeenCalledOnce();
    expect(ft.activeCount()).toBe(1);
  });

  // 10. running guard: concurrent tick is skipped
  it('running guard: a second tick that fires while the first is in-flight is a no-op', async () => {
    let resolveFirst!: () => void;
    const firstTick = new Promise<void>(r => { resolveFirst = r; });
    let callCount = 0;

    const api = {
      getChanges: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          // Block the first tick until we manually resolve
          await firstTick;
          return makeChangesResult();
        }
        return makeChangesResult();
      }),
    } as unknown as ChangesSyncerOpts['api'];

    const ft = makeFakeTimers();
    const opts = makeOpts(makeChangesResult(), { api }, ft);
    const syncer = new ChangesSyncer(opts);

    // Start the first tick (it will block inside getChanges)
    const firstTickPromise = syncer.tick();

    // The running flag is now true; a concurrent tick() should be a no-op
    const secondTickPromise = syncer.tick();
    await secondTickPromise; // resolves immediately (no-op)

    expect(callCount).toBe(1); // second tick skipped

    // Now let the first tick finish
    resolveFirst();
    await firstTickPromise;

    expect(callCount).toBe(1); // still only 1 actual API call
  });

  // 11. unstamped change (path: null) is skipped
  it('skips changes with null path (unstamped, defensive against D11)', async () => {
    const unstamped = makeRow({ path: null });
    const opts = makeOpts(makeChangesResult({ data: { changes: [unstamped], pendingAttachments: [], pendingInits: [], etag: '"e"' } }));
    const syncer = new ChangesSyncer(opts);
    await syncer.tick();

    const writeCalls = opts.memWriter.calls.filter(c => c.op === 'write' || c.op === 'delete');
    expect(writeCalls).toHaveLength(0);
  });
});
