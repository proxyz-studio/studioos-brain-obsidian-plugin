import { describe, it, expect, beforeEach } from 'vitest';
import { SyncIndex, IndexEntry } from './SyncIndex';

describe('SyncIndex', () => {
  let idx: SyncIndex;

  beforeEach(() => {
    idx = new SyncIndex();
  });

  it('set + getByPath roundtrip', () => {
    const entry: IndexEntry = { brainId: 'brain-1', path: '05-BRAIN/foo.md', contentHash: 'hash-abc' };
    idx.set(entry);
    expect(idx.getByPath('05-BRAIN/foo.md')).toEqual(entry);
  });

  it('set + getByBrainId roundtrip', () => {
    const entry: IndexEntry = { brainId: 'brain-1', path: '05-BRAIN/foo.md', contentHash: 'hash-abc' };
    idx.set(entry);
    expect(idx.getByBrainId('brain-1')).toEqual(entry);
  });

  it('getHash returns contentHash for known brainId', () => {
    idx.set({ brainId: 'brain-1', path: '05-BRAIN/foo.md', contentHash: 'hash-xyz' });
    expect(idx.getHash('brain-1')).toBe('hash-xyz');
  });

  it('getHash returns null for unknown brainId', () => {
    expect(idx.getHash('unknown-brain')).toBeNull();
  });

  it('getByPath returns undefined for unknown path', () => {
    expect(idx.getByPath('05-BRAIN/missing.md')).toBeUndefined();
  });

  it('rename: set same brainId with new path removes old path entry', () => {
    idx.set({ brainId: 'brain-1', path: '05-BRAIN/old.md', contentHash: 'hash-1' });
    idx.set({ brainId: 'brain-1', path: '05-BRAIN/new.md', contentHash: 'hash-2' });

    // New path is reachable
    expect(idx.getByPath('05-BRAIN/new.md')).toEqual({ brainId: 'brain-1', path: '05-BRAIN/new.md', contentHash: 'hash-2' });
    // Old path is gone
    expect(idx.getByPath('05-BRAIN/old.md')).toBeUndefined();
    // brainId still maps to the new entry
    expect(idx.getByBrainId('brain-1')?.path).toBe('05-BRAIN/new.md');
  });

  it('deleteByPath returns the entry and clears both maps', () => {
    const entry: IndexEntry = { brainId: 'brain-2', path: '05-BRAIN/bar.md', contentHash: 'hash-def' };
    idx.set(entry);

    const removed = idx.deleteByPath('05-BRAIN/bar.md');
    expect(removed).toEqual(entry);
    expect(idx.getByPath('05-BRAIN/bar.md')).toBeUndefined();
    expect(idx.getByBrainId('brain-2')).toBeUndefined();
  });

  it('deleteByPath on unknown path returns undefined and leaves other entries intact', () => {
    idx.set({ brainId: 'brain-3', path: '05-BRAIN/keep.md', contentHash: 'hash-keep' });
    const removed = idx.deleteByPath('05-BRAIN/missing.md');
    expect(removed).toBeUndefined();
    expect(idx.getByBrainId('brain-3')).toBeDefined();
  });

  it('deleteByBrainId clears both maps', () => {
    idx.set({ brainId: 'brain-4', path: '05-BRAIN/baz.md', contentHash: 'hash-baz' });
    idx.deleteByBrainId('brain-4');
    expect(idx.getByBrainId('brain-4')).toBeUndefined();
    expect(idx.getByPath('05-BRAIN/baz.md')).toBeUndefined();
  });

  it('deleteByBrainId on unknown brainId is a no-op', () => {
    idx.set({ brainId: 'brain-5', path: '05-BRAIN/kept.md', contentHash: 'hash-5' });
    idx.deleteByBrainId('unknown-brain');
    expect(idx.getByBrainId('brain-5')).toBeDefined();
  });

  it('toJSON + fromJSON roundtrip preserves all entries', () => {
    const entries: IndexEntry[] = [
      { brainId: 'brain-a', path: '05-BRAIN/a.md', contentHash: 'hash-a' },
      { brainId: 'brain-b', path: '05-BRAIN/b.md', contentHash: 'hash-b' },
    ];
    for (const e of entries) idx.set(e);

    const json = idx.toJSON();
    const restored = SyncIndex.fromJSON(json);

    expect(restored.getByBrainId('brain-a')).toEqual(entries[0]);
    expect(restored.getByBrainId('brain-b')).toEqual(entries[1]);
    expect(restored.getByPath('05-BRAIN/a.md')).toEqual(entries[0]);
    expect(restored.getByPath('05-BRAIN/b.md')).toEqual(entries[1]);
  });

  it('fromJSON(null) returns an empty index', () => {
    const empty = SyncIndex.fromJSON(null);
    expect(empty.toJSON()).toEqual([]);
    expect(empty.getHash('any')).toBeNull();
  });

  it('fromJSON(undefined) returns an empty index', () => {
    const empty = SyncIndex.fromJSON(undefined);
    expect(empty.toJSON()).toEqual([]);
  });

  it('multiple entries coexist in the same index', () => {
    idx.set({ brainId: 'b1', path: '05-BRAIN/one.md', contentHash: 'h1' });
    idx.set({ brainId: 'b2', path: '05-BRAIN/two.md', contentHash: 'h2' });
    idx.set({ brainId: 'b3', path: '05-BRAIN/three.md', contentHash: 'h3' });

    expect(idx.getHash('b1')).toBe('h1');
    expect(idx.getHash('b2')).toBe('h2');
    expect(idx.getHash('b3')).toBe('h3');
    expect(idx.toJSON()).toHaveLength(3);
  });
});
