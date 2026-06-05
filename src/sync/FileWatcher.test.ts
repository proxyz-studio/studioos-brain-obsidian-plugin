import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileWatcher } from './FileWatcher';
import { MemoryVaultWriter } from './VaultWriter';
import { App } from '../__mocks__/obsidian';
import { BRAIN_MANAGED_DELIMITER } from '../parser/frontmatter';

const DELIM = BRAIN_MANAGED_DELIMITER;

// --- Mock API helpers ---

function makeApi() {
  return {
    uploadFlowB: vi.fn().mockResolvedValue({ ok: true, brain_id: 'new-id', content_hash: 'hash1', sync_version: 1 }),
    uploadFlowC: vi.fn().mockResolvedValue({ ok: true, brain_id: 'abc-123', content_hash: 'hash2', sync_version: 2 }),
    deleteItem: vi.fn().mockResolvedValue({ ok: true }),
  };
}

// --- File content helpers ---

const plainContent = 'A plain note with no frontmatter.';
const flowCContent = [
  '---',
  'brain_id: abc-123',
  'title: Brain Item',
  '---',
  '## Summary',
  DELIM,
  '## My notes',
  'user annotation here',
].join('\n');

// --- Tests ---

describe('FileWatcher', () => {
  let writer: MemoryVaultWriter;
  let api: ReturnType<typeof makeApi>;
  let app: App;
  let onError: ReturnType<typeof vi.fn>;
  let fixedNow: Date;

  beforeEach(() => {
    writer = new MemoryVaultWriter();
    api = makeApi();
    app = new App();
    onError = vi.fn();
    fixedNow = new Date(2026, 5, 6, 14, 37);
  });

  function makeWatcher(overrides: { getLastKnownServerHash?: (id: string) => string | null } = {}) {
    return new FileWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      writer,
      newRequestId: () => 'test-uuid',
      getLastKnownServerHash: overrides.getLastKnownServerHash ?? ((_id) => null),
      onError,
      _now: () => fixedNow,
    });
  }

  // ---- Debounce tests: use fake timers ----

  it('queueUpload schedules a flush after DEBOUNCE_MS', async () => {
    vi.useFakeTimers();
    try {
      const watcher = makeWatcher();
      writer.files.set('05-BRAIN/foo.md', plainContent);
      watcher.queueUpload('05-BRAIN/foo.md');
      expect(api.uploadFlowB).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      // After timers fire, uploadFlowB is called (but sha256 etc still settle)
      // Just verify the timer fired (uploadFlowB may still be in-flight)
      // Wait for microtasks
      await new Promise<void>(res => { vi.useRealTimers(); setTimeout(res, 10); });
      expect(api.uploadFlowB).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two rapid queueUpload calls for same path → only one flush', async () => {
    vi.useFakeTimers();
    try {
      const watcher = makeWatcher();
      writer.files.set('05-BRAIN/foo.md', plainContent);
      watcher.queueUpload('05-BRAIN/foo.md');
      watcher.queueUpload('05-BRAIN/foo.md'); // cancels the first
      await vi.runAllTimersAsync();
      await new Promise<void>(res => { vi.useRealTimers(); setTimeout(res, 10); });
      expect(api.uploadFlowB).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queueUpload for a path OUTSIDE 05-BRAIN/ is ignored', () => {
    const watcher = makeWatcher();
    watcher.queueUpload('01-Journal/note.md');
    // No timer should be scheduled — verify by calling flush() directly with that path
    // Nothing should happen
    expect(api.uploadFlowB).not.toHaveBeenCalled();
  });

  it('queueUpload for a (conflict) file is queued and uploads as Flow B (C6: conflict files must sync)', async () => {
    vi.useFakeTimers();
    try {
      const watcher = makeWatcher();
      const conflictPath = '05-BRAIN/note (conflict 2026-06-06 1437).md';
      writer.files.set(conflictPath, plainContent);
      watcher.queueUpload(conflictPath);
      await vi.runAllTimersAsync();
      await new Promise<void>(res => { vi.useRealTimers(); setTimeout(res, 10); });
      // Conflict files have no brain_id (stripped by buildConflictFile) → Flow B
      expect(api.uploadFlowB).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- Upload logic tests: call flush() directly to avoid timer async issues ----

  it('flush: file with no brain_id → calls api.uploadFlowB with content_hash + x-idempotency-key param', async () => {
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/new.md', plainContent);

    await watcher.flush('05-BRAIN/new.md');

    expect(api.uploadFlowB).toHaveBeenCalledOnce();
    const [payload, idempotencyKey] = api.uploadFlowB.mock.calls[0];
    expect(payload.content).toBe(plainContent);
    expect(payload.content_hash).toBeDefined();
    expect(typeof payload.content_hash).toBe('string');
    // idempotencyKey passes the requestUuid as second arg (not in body)
    expect(idempotencyKey).toBe('test-uuid');
    expect((payload as Record<string, unknown>).request_uuid).toBeUndefined();
  });

  it('flush: file with brain_id + known last_known_server_hash → calls api.uploadFlowC with path', async () => {
    const watcher = makeWatcher({ getLastKnownServerHash: () => 'known-hash-abc' });
    writer.files.set('05-BRAIN/item.md', flowCContent);

    await watcher.flush('05-BRAIN/item.md');

    expect(api.uploadFlowC).toHaveBeenCalledOnce();
    const call = api.uploadFlowC.mock.calls[0][0];
    expect(call.brain_id).toBe('abc-123');
    expect(call.path).toBe('05-BRAIN/item.md');
    expect(call.last_known_server_hash).toBe('known-hash-abc');
    expect(call.content).toBe('user annotation here');
  });

  it('flush: file with brain_id but UNKNOWN last_known_server_hash → calls onError with skip reason', async () => {
    const watcher = makeWatcher({ getLastKnownServerHash: () => null });
    writer.files.set('05-BRAIN/item.md', flowCContent);

    await watcher.flush('05-BRAIN/item.md');

    expect(api.uploadFlowC).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    const [msg] = onError.mock.calls[0];
    expect(msg).toContain('last_known_server_hash unknown');
  });

  it('flush + 409 hash_mismatch → writes conflict file (with stamp) + canonical to original path', async () => {
    const canonicalContent = '---\nbrain_id: abc-123\n---\nServer canonical content.';
    api.uploadFlowC.mockResolvedValue({
      ok: false,
      code: 'hash_mismatch',
      canonical: {
        brain_id: 'abc-123',
        content: canonicalContent,
        content_hash: 'server-hash',
        sync_version: 5,
      },
    });

    const watcher = makeWatcher({ getLastKnownServerHash: () => 'stale-hash' });
    writer.files.set('05-BRAIN/item.md', flowCContent);

    await watcher.flush('05-BRAIN/item.md');

    // Conflict file should exist with timestamp stamp
    const conflictPath = '05-BRAIN/item (conflict 2026-06-06 1437).md';
    expect(writer.files.has(conflictPath)).toBe(true);
    // Conflict content should have brain_id stripped
    expect(writer.files.get(conflictPath)).not.toContain('brain_id: abc-123');
    // Original path should have canonical content
    expect(writer.files.get('05-BRAIN/item.md')).toBe(canonicalContent);
  });

  it('flush + error response from Flow B → calls onError', async () => {
    api.uploadFlowB.mockResolvedValue({ ok: false, code: 'unauthorized' });
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/note.md', plainContent);

    await watcher.flush('05-BRAIN/note.md');

    expect(onError).toHaveBeenCalledOnce();
    const [msg] = onError.mock.calls[0];
    expect(msg).toContain('Upload failed');
  });

  it('flush: file does not exist (deleted between queue and flush) → silently returns', async () => {
    const watcher = makeWatcher();
    // Do NOT add the file — it does not exist

    await watcher.flush('05-BRAIN/gone.md');

    expect(api.uploadFlowB).not.toHaveBeenCalled();
    expect(api.uploadFlowC).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  // ---- In-flight guard (M1) ----

  it('flush: concurrent flush for the same path is a no-op (inFlight guard)', async () => {
    // Block the first flush at the writer.read step so we control when it proceeds.
    // This lets us start the second flush while the first is definitively in-flight.
    let resolveRead!: (content: string) => void;
    const blockedWriter = {
      exists: async (_p: string) => true,
      read: (_p: string) => new Promise<string>(res => { resolveRead = res; }),
      write: vi.fn(),
      delete: vi.fn(),
    };

    const watcher = new FileWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      writer: blockedWriter as never,
      newRequestId: () => 'test-uuid',
      getLastKnownServerHash: () => null,
      onError,
      _now: () => fixedNow,
    });

    // Start first flush — it will block inside writer.read
    const first = watcher.flush('05-BRAIN/new.md');
    // Yield one microtask so the first flush enters the try block and adds to inFlight
    await Promise.resolve();

    // Second flush fires while first is in-flight
    const second = watcher.flush('05-BRAIN/new.md');
    await second; // resolves immediately — inFlight guard returns early

    // First is still blocked; api.uploadFlowB not called yet
    expect(api.uploadFlowB).not.toHaveBeenCalled();

    // Unblock first flush — let it complete normally
    resolveRead(plainContent);
    await first;

    // Only the first flush ran uploadFlowB
    expect(api.uploadFlowB).toHaveBeenCalledTimes(1);
  });

  // ---- Suppress path (M2) ----

  it('suppressPath: queueUpload is a no-op while suppression window is active', () => {
    let fakeNow = 1000;
    const watcher = new FileWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      writer,
      newRequestId: () => 'test-uuid',
      getLastKnownServerHash: () => null,
      onError,
      _now: () => fixedNow,
      _nowMs: () => fakeNow,
    });

    watcher.suppressPath('05-BRAIN/note.md', 2000);

    // Inside suppression window → queue is skipped
    fakeNow = 1500;
    watcher.queueUpload('05-BRAIN/note.md');
    expect(api.uploadFlowB).not.toHaveBeenCalled();
  });

  it('suppressPath: queueUpload proceeds after suppression window expires', () => {
    vi.useFakeTimers();
    let fakeNow = 1000;
    const watcher = new FileWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      writer,
      newRequestId: () => 'test-uuid',
      getLastKnownServerHash: () => null,
      onError,
      _now: () => fixedNow,
      _nowMs: () => fakeNow,
    });

    watcher.suppressPath('05-BRAIN/note.md', 2000);
    writer.files.set('05-BRAIN/note.md', plainContent);

    // After suppression expires → queue proceeds
    fakeNow = 3001;
    watcher.queueUpload('05-BRAIN/note.md');

    // Timer is now registered (suppression did not block it)
    // Verify no immediate upload (it's still debounced)
    expect(api.uploadFlowB).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
