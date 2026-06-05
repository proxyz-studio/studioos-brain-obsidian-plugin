import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeartbeatScheduler } from './HeartbeatScheduler';
import type { HeartbeatSchedulerOpts } from './HeartbeatScheduler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeTimer = {
  id: number;
  callback: () => void;
  intervalMs: number;
};

/** Synchronous fake timer pair — no real I/O, fully controllable in tests. */
function makeFakeTimers() {
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  const fakeSetInterval = vi.fn((cb: () => void, ms: number) => {
    const id = nextId++;
    timers.set(id, { id, callback: cb, intervalMs: ms });
    return id as unknown as ReturnType<typeof setInterval>;
  });

  const fakeClearInterval = vi.fn((id: ReturnType<typeof setInterval>) => {
    timers.delete(id as unknown as number);
  });

  const tick = (id?: number) => {
    if (id !== undefined) {
      timers.get(id)?.callback();
    } else {
      for (const t of timers.values()) t.callback();
    }
  };

  const activeCount = () => timers.size;

  return { fakeSetInterval, fakeClearInterval, tick, activeCount };
}

function makeApi(heartbeatResult: { ok: boolean; status: number }) {
  return {
    heartbeat: vi.fn().mockResolvedValue(heartbeatResult),
  };
}

function makeOpts(
  overrides: Partial<HeartbeatSchedulerOpts> = {},
  fakeTimers = makeFakeTimers(),
): HeartbeatSchedulerOpts & { _fakeTimers: ReturnType<typeof makeFakeTimers> } {
  const api = makeApi({ ok: true, status: 200 });
  const onUnauthorized = vi.fn().mockResolvedValue(undefined);
  return {
    api: api as never,
    onUnauthorized,
    intervalMs: 30_000,
    _setInterval: fakeTimers.fakeSetInterval as never,
    _clearInterval: fakeTimers.fakeClearInterval as never,
    ...overrides,
    _fakeTimers: fakeTimers,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HeartbeatScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // 1. start() fires a heartbeat immediately
  it('fires a heartbeat immediately on start()', async () => {
    const opts = makeOpts();
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();

    await new Promise<void>(r => setTimeout(r, 0));

    expect((opts.api as unknown as ReturnType<typeof makeApi>).heartbeat).toHaveBeenCalledOnce();
  });

  // 2. start() registers setInterval, and the callback fires another heartbeat
  it('registers an interval and fires heartbeats on interval ticks', async () => {
    const ft = makeFakeTimers();
    const opts = makeOpts({}, ft);
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();
    await new Promise<void>(r => setTimeout(r, 0)); // flush immediate tick

    // Simulate one interval fire
    ft.tick();
    await new Promise<void>(r => setTimeout(r, 0));

    expect((opts.api as unknown as ReturnType<typeof makeApi>).heartbeat).toHaveBeenCalledTimes(2);
  });

  // 3. 401 triggers onUnauthorized AND stops the scheduler
  it('calls onUnauthorized and stops on 401 heartbeat', async () => {
    const api = { heartbeat: vi.fn().mockResolvedValue({ ok: false, status: 401 }) };
    const ft = makeFakeTimers();
    const opts = makeOpts({ api: api as unknown as never }, ft);
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();

    await new Promise<void>(r => setTimeout(r, 0));

    expect(opts.onUnauthorized).toHaveBeenCalledOnce();
    expect(scheduler.running).toBe(false);
    expect(ft.fakeClearInterval).toHaveBeenCalled();
  });

  // 4. 200 does NOT trigger onUnauthorized
  it('does not call onUnauthorized on a 200 heartbeat', async () => {
    const opts = makeOpts();
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();

    await new Promise<void>(r => setTimeout(r, 0));

    expect(opts.onUnauthorized).not.toHaveBeenCalled();
    expect(scheduler.running).toBe(true);
  });

  // 5. Thrown error in heartbeat is swallowed; scheduler keeps running
  it('swallows network errors and keeps running', async () => {
    const api = { heartbeat: vi.fn().mockRejectedValue(new Error('network fail')) };
    const ft = makeFakeTimers();
    const opts = makeOpts({ api: api as unknown as never }, ft);
    const scheduler = new HeartbeatScheduler(opts);

    // Should not throw
    expect(() => scheduler.start()).not.toThrow();
    await new Promise<void>(r => setTimeout(r, 0));

    expect(opts.onUnauthorized).not.toHaveBeenCalled();
    expect(scheduler.running).toBe(true);
  });

  // 6. stop() clears the interval and stops subsequent calls
  it('clears the interval on stop()', async () => {
    const ft = makeFakeTimers();
    const opts = makeOpts({}, ft);
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();
    await new Promise<void>(r => setTimeout(r, 0));

    scheduler.stop();

    expect(ft.fakeClearInterval).toHaveBeenCalled();
    expect(scheduler.running).toBe(false);
    expect(ft.activeCount()).toBe(0);
  });

  // 7. start() is idempotent — calling twice doesn't double-schedule
  it('is idempotent — calling start() twice registers only one interval', async () => {
    const ft = makeFakeTimers();
    const opts = makeOpts({}, ft);
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();
    scheduler.start(); // second call should be no-op

    await new Promise<void>(r => setTimeout(r, 0));

    expect(ft.fakeSetInterval).toHaveBeenCalledOnce();
    expect(ft.activeCount()).toBe(1);
  });

  // 8. stop() is a no-op when not running
  it('stop() is safe to call when not started', () => {
    const ft = makeFakeTimers();
    const opts = makeOpts({}, ft);
    const scheduler = new HeartbeatScheduler(opts);

    expect(() => scheduler.stop()).not.toThrow();
    expect(ft.fakeClearInterval).not.toHaveBeenCalled();
  });

  // 9. stop() after 401 is safe (scheduler already stopped itself)
  it('stop() after onUnauthorized self-stop does not double-clear', async () => {
    const api = { heartbeat: vi.fn().mockResolvedValue({ ok: false, status: 401 }) };
    const ft = makeFakeTimers();
    const opts = makeOpts({ api: api as never }, ft);
    const scheduler = new HeartbeatScheduler(opts);
    scheduler.start();
    await new Promise<void>(r => setTimeout(r, 0)); // scheduler stops itself

    const clearCount = ft.fakeClearInterval.mock.calls.length;
    scheduler.stop(); // should be no-op since handle is already null

    expect(ft.fakeClearInterval.mock.calls.length).toBe(clearCount); // no extra call
  });
});
