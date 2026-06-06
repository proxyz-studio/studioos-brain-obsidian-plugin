import { BrainApiClient } from '../api/client';

export type HeartbeatSchedulerOpts = {
  api: BrainApiClient;
  /** Called when heartbeat returns 401 — caller should clear token + show user notice. */
  onUnauthorized: () => Promise<void> | void;
  /** Interval in ms between heartbeats. Default 5 minutes. */
  intervalMs?: number;
  /** Test-only setInterval/clearInterval injection. */
  _setInterval?: typeof setInterval;
  _clearInterval?: typeof clearInterval;
};

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class HeartbeatScheduler {
  private opts: HeartbeatSchedulerOpts;
  private handle: ReturnType<typeof setInterval> | null = null;
  private setIntervalFn: typeof setInterval;
  private clearIntervalFn: typeof clearInterval;

  constructor(opts: HeartbeatSchedulerOpts) {
    this.opts = opts;
    // .bind(globalThis) is mandatory. setInterval/clearInterval are methods of
    // the global object and require their original `this` binding. Storing
    // them as instance properties and calling `this.setIntervalFn(...)` strips
    // that binding and the runtime throws TypeError: Illegal invocation at
    // load time. The unit tests in HeartbeatScheduler.test.ts inject
    // `_setInterval`/`_clearInterval`, so they skip the native call entirely
    // and never caught this — a live install regression in v0.2.0/v0.3.0.
    this.setIntervalFn = opts._setInterval ?? setInterval.bind(globalThis);
    this.clearIntervalFn = opts._clearInterval ?? clearInterval.bind(globalThis);
  }

  start() {
    if (this.handle) return;
    // Fire immediately, then on interval
    void this.tick();
    this.handle = this.setIntervalFn(
      () => void this.tick(),
      this.opts.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
  }

  stop() {
    if (this.handle) {
      this.clearIntervalFn(this.handle);
      this.handle = null;
    }
  }

  /** Expose running state for tests. */
  get running(): boolean {
    return this.handle !== null;
  }

  private async tick(): Promise<void> {
    try {
      const r = await this.opts.api.heartbeat();
      if (r.status === 401) {
        await this.opts.onUnauthorized();
        this.stop();
      }
    } catch {
      // Network errors: swallow + try again next tick
    }
  }
}
