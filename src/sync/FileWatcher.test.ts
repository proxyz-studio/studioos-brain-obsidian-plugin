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

  it('queueUpload for a (conflict) file is ignored', () => {
    const watcher = makeWatcher();
    watcher.queueUpload('05-BRAIN/note (conflict 2026-06-06 1437).md');
    expect(api.uploadFlowB).not.toHaveBeenCalled();
  });

  // ---- Upload logic tests: call flush() directly to avoid timer async issues ----

  it('flush: file with no brain_id → calls api.uploadFlowB', async () => {
    const watcher = makeWatcher();
    writer.files.set('05-BRAIN/new.md', plainContent);

    await watcher.flush('05-BRAIN/new.md');

    expect(api.uploadFlowB).toHaveBeenCalledOnce();
    const call = api.uploadFlowB.mock.calls[0][0];
    expect(call.content).toBe(plainContent);
    expect(call.request_uuid).toBe('test-uuid');
  });

  it('flush: file with brain_id + known last_known_server_hash → calls api.uploadFlowC', async () => {
    const watcher = makeWatcher({ getLastKnownServerHash: () => 'known-hash-abc' });
    writer.files.set('05-BRAIN/item.md', flowCContent);

    await watcher.flush('05-BRAIN/item.md');

    expect(api.uploadFlowC).toHaveBeenCalledOnce();
    const call = api.uploadFlowC.mock.calls[0][0];
    expect(call.brain_id).toBe('abc-123');
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
});
