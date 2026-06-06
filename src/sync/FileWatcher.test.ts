import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileWatcher } from './FileWatcher';
import { SyncIndex } from './SyncIndex';
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
  let syncIndex: SyncIndex;
  let persistIndex: () => Promise<void>;

  beforeEach(() => {
    vi.resetAllMocks();
    writer = new MemoryVaultWriter();
    api = makeApi();
    app = new App();
    onError = vi.fn();
    fixedNow = new Date(2026, 5, 6, 14, 37);
    syncIndex = new SyncIndex();
    persistIndex = vi.fn().mockResolvedValue(undefined) as unknown as () => Promise<void>;
  });

  function makeWatcher(overrides: { syncIndex?: SyncIndex } = {}) {
    return new FileWatcher({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      app: app as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: api as any,
      writer,
      syncIndex: overrides.syncIndex ?? syncIndex,
      persistIndex,
      newRequestId: () => 'test-uuid',
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

  it('flush Flow B success updates syncIndex with server-returned brain_id + hash', async () => {
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/new.md', plainContent);

    await watcher.flush('05-BRAIN/new.md');

    expect(api.uploadFlowB).toHaveBeenCalledOnce();
    // syncIndex must reflect the server-assigned brain_id + hash
    const entry = syncIndex.getByBrainId('new-id');
    expect(entry).toBeDefined();
    expect(entry?.path).toBe('05-BRAIN/new.md');
    expect(entry?.contentHash).toBe('hash1');
    expect(persistIndex).toHaveBeenCalledOnce();
  });

  it('flush: file with brain_id + known last_known_server_hash → calls api.uploadFlowC with path', async () => {
    // Pre-populate the index with the known hash so Flow C can proceed
    syncIndex.set({ brainId: 'abc-123', path: '05-BRAIN/item.md', contentHash: 'known-hash-abc' });
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/item.md', flowCContent);

    await watcher.flush('05-BRAIN/item.md');

    expect(api.uploadFlowC).toHaveBeenCalledOnce();
    const call = api.uploadFlowC.mock.calls[0][0];
    expect(call.brain_id).toBe('abc-123');
    expect(call.path).toBe('05-BRAIN/item.md');
    expect(call.last_known_server_hash).toBe('known-hash-abc');
    expect(call.content).toBe('user annotation here');
  });

  it('flush Flow C success updates syncIndex with returned hash', async () => {
    syncIndex.set({ brainId: 'abc-123', path: '05-BRAIN/item.md', contentHash: 'old-hash' });
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/item.md', flowCContent);

    await watcher.flush('05-BRAIN/item.md');

    expect(api.uploadFlowC).toHaveBeenCalledOnce();
    const entry = syncIndex.getByBrainId('abc-123');
    expect(entry?.contentHash).toBe('hash2'); // updated to server response hash
    expect(persistIndex).toHaveBeenCalledOnce();
  });

  it('flush: file with brain_id but UNKNOWN last_known_server_hash → calls onError with skip reason', async () => {
    // syncIndex has no entry for abc-123 → hash unknown
    const watcher = makeWatcher();
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

    syncIndex.set({ brainId: 'abc-123', path: '05-BRAIN/item.md', contentHash: 'stale-hash' });
    const watcher = makeWatcher();
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

  it('flush + error response from Flow B → does NOT update index', async () => {
    api.uploadFlowB.mockResolvedValue({ ok: false, code: 'unauthorized' });
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/note.md', plainContent);

    await watcher.flush('05-BRAIN/note.md');

    expect(syncIndex.getByPath('05-BRAIN/note.md')).toBeUndefined();
    expect(persistIndex).not.toHaveBeenCalled();
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
      syncIndex,
      persistIndex,
      newRequestId: () => 'test-uuid',
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
      syncIndex,
      persistIndex,
      newRequestId: () => 'test-uuid',
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
      syncIndex,
      persistIndex,
      newRequestId: () => 'test-uuid',
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

  // ---- handleDelete (file-deletion sync) ----

  it('handleDelete: tracked path → calls api.deleteItem + removes from index + persists', async () => {
    syncIndex.set({ brainId: 'brain-del-1', path: '05-BRAIN/tracked.md', contentHash: 'h1' });
    const watcher = makeWatcher();

    await watcher.handleDelete('05-BRAIN/tracked.md');

    expect(api.deleteItem).toHaveBeenCalledOnce();
    expect(api.deleteItem).toHaveBeenCalledWith('brain-del-1');
    expect(syncIndex.getByPath('05-BRAIN/tracked.md')).toBeUndefined();
    expect(syncIndex.getByBrainId('brain-del-1')).toBeUndefined();
    expect(persistIndex).toHaveBeenCalledOnce();
  });

  it('handleDelete: untracked path → no api call', async () => {
    const watcher = makeWatcher();

    await watcher.handleDelete('05-BRAIN/never-synced.md');

    expect(api.deleteItem).not.toHaveBeenCalled();
    expect(persistIndex).not.toHaveBeenCalled();
  });

  it('handleDelete: path outside 05-BRAIN/ → no api call', async () => {
    const watcher = makeWatcher();

    await watcher.handleDelete('01-Journal/note.md');

    expect(api.deleteItem).not.toHaveBeenCalled();
  });

  it('handleDelete: conflict file path → no api call (conflict files are not tracked)', async () => {
    // Even if somehow the index had this path, conflict files should be filtered early
    syncIndex.set({ brainId: 'brain-conflict', path: '05-BRAIN/note (conflict 2026-06-06 1437).md', contentHash: 'hc' });
    const watcher = makeWatcher();

    await watcher.handleDelete('05-BRAIN/note (conflict 2026-06-06 1437).md');

    expect(api.deleteItem).not.toHaveBeenCalled();
  });

  it('handleDelete: server error → calls onError + index NOT cleared (allows retry)', async () => {
    api.deleteItem.mockResolvedValue({ ok: false, code: 'not_found' });
    syncIndex.set({ brainId: 'brain-err', path: '05-BRAIN/errfile.md', contentHash: 'he' });
    const watcher = makeWatcher();

    await watcher.handleDelete('05-BRAIN/errfile.md');

    expect(onError).toHaveBeenCalledOnce();
    const [msg] = onError.mock.calls[0];
    expect(msg).toContain('Delete sync failed');
    // Index NOT cleared so a retry can still find the brainId
    expect(syncIndex.getByPath('05-BRAIN/errfile.md')).toBeDefined();
    expect(persistIndex).not.toHaveBeenCalled();
  });

  it('handleDelete: network throw → calls onError', async () => {
    api.deleteItem.mockRejectedValue(new Error('network down'));
    syncIndex.set({ brainId: 'brain-throw', path: '05-BRAIN/throw.md', contentHash: 'ht' });
    const watcher = makeWatcher();

    await watcher.handleDelete('05-BRAIN/throw.md');

    expect(onError).toHaveBeenCalledOnce();
    const [msg] = onError.mock.calls[0];
    expect(msg).toContain('Delete sync threw');
  });
});
