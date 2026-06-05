export type IndexEntry = {
  brainId: string;
  path: string;
  contentHash: string;
};

/** Bidirectional path↔brainId index + content-hash store.
 *  Persisted as a plain object in plugin settings (data.json). Survives reloads.
 *  Needed because: (1) DELETE sync requires brain_id lookup for a path whose file is gone;
 *  (2) Flow C uploads need last_known_server_hash for a brain_id after a plugin restart. */
export class SyncIndex {
  private byPath = new Map<string, IndexEntry>();
  private byBrainId = new Map<string, IndexEntry>();

  /** Hydrate from persisted settings (array form for JSON-friendliness). */
  static fromJSON(entries: IndexEntry[] | undefined | null): SyncIndex {
    const idx = new SyncIndex();
    for (const e of entries ?? []) idx.set(e);
    return idx;
  }

  toJSON(): IndexEntry[] {
    return [...this.byBrainId.values()];
  }

  set(entry: IndexEntry): void {
    // Remove any stale path mapping if this brainId moved paths (rename)
    const prior = this.byBrainId.get(entry.brainId);
    if (prior && prior.path !== entry.path) this.byPath.delete(prior.path);
    this.byPath.set(entry.path, entry);
    this.byBrainId.set(entry.brainId, entry);
  }

  getByPath(path: string): IndexEntry | undefined {
    return this.byPath.get(path);
  }

  getByBrainId(brainId: string): IndexEntry | undefined {
    return this.byBrainId.get(brainId);
  }

  getHash(brainId: string): string | null {
    return this.byBrainId.get(brainId)?.contentHash ?? null;
  }

  deleteByPath(path: string): IndexEntry | undefined {
    const entry = this.byPath.get(path);
    if (entry) {
      this.byPath.delete(path);
      this.byBrainId.delete(entry.brainId);
    }
    return entry;
  }

  deleteByBrainId(brainId: string): void {
    const entry = this.byBrainId.get(brainId);
    if (entry) {
      this.byBrainId.delete(brainId);
      this.byPath.delete(entry.path);
    }
  }
}
