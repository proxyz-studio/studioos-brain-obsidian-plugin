import { App, normalizePath } from 'obsidian';

/** Filesystem-style operations the sync engine needs against Obsidian's vault. */
export interface VaultWriter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

/** Production implementation backed by Obsidian's DataAdapter. */
export class ObsidianVaultWriter implements VaultWriter {
  constructor(private app: App) {}

  exists(path: string) {
    return this.app.vault.adapter.exists(normalizePath(path));
  }

  read(path: string) {
    return this.app.vault.adapter.read(normalizePath(path));
  }

  async write(path: string, content: string) {
    const normalized = normalizePath(path);
    await this.ensureParentDir(normalized);
    await this.app.vault.adapter.write(normalized, content);
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    const normalized = normalizePath(path);
    await this.ensureParentDir(normalized);
    await this.app.vault.adapter.writeBinary(normalized, data);
  }

  async delete(path: string) {
    const normalized = normalizePath(path);
    if (await this.app.vault.adapter.exists(normalized)) {
      await this.app.vault.adapter.remove(normalized);
    }
  }

  async mkdir(path: string) {
    const normalized = normalizePath(path);
    if (!(await this.app.vault.adapter.exists(normalized))) {
      await this.app.vault.adapter.mkdir(normalized);
    }
  }

  private async ensureParentDir(path: string): Promise<void> {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash <= 0) return; // root-level file
    const parent = path.slice(0, lastSlash);
    if (!(await this.app.vault.adapter.exists(parent))) {
      // Obsidian's mkdir is recursive
      await this.app.vault.adapter.mkdir(parent);
    }
  }
}

/** In-memory implementation for tests. Tracks file contents + call log. */
export class MemoryVaultWriter implements VaultWriter {
  files = new Map<string, string>();
  calls: { op: string; path: string; content?: string }[] = [];

  async exists(path: string) {
    this.calls.push({ op: 'exists', path });
    return this.files.has(path);
  }

  async read(path: string) {
    this.calls.push({ op: 'read', path });
    const f = this.files.get(path);
    if (f === undefined) throw new Error(`Not found: ${path}`);
    return f;
  }

  async write(path: string, content: string) {
    this.calls.push({ op: 'write', path, content });
    this.files.set(path, content);
  }

  async writeBinary(path: string, data: ArrayBuffer) {
    this.calls.push({ op: 'writeBinary', path, content: String(data.byteLength) });
    this.files.set(path, Array.from(new Uint8Array(data)).join(','));
  }

  async delete(path: string) {
    this.calls.push({ op: 'delete', path });
    this.files.delete(path);
  }

  async mkdir(path: string) {
    this.calls.push({ op: 'mkdir', path });
    // memory writer doesn't track dirs separately
  }
}
