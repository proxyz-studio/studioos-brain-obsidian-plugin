/**
 * Minimal Obsidian API stub for vitest.
 *
 * obsidian's package.json has `"main": ""` so vite cannot resolve it in the
 * test environment. vitest.config.mjs aliases `obsidian` → this file.
 *
 * Tests that need different behaviour can override individual exports with
 * `vi.mock('obsidian', () => ({ ... }))` — vitest honours that override even
 * when the alias is in place.
 */

type StyleMap = Record<string, string>;

export interface ElStub {
  tagName: string;
  textContent: string;
  style: StyleMap;
  children: ElStub[];
  empty(): void;
  createEl(tag: string, attrs?: { text?: string; cls?: string }): ElStub;
  setText(t: string): void;
  addEventListener(evt: string, handler: (e: Record<string, unknown>) => void): void;
  _handlers: Record<string, Array<(e: Record<string, unknown>) => void>>;
  _trigger(evt: string, e?: Record<string, unknown>): void;
}

export function mkEl(tag: string): ElStub {
  const el: ElStub = {
    tagName: tag,
    textContent: '',
    style: {} as StyleMap,
    children: [],
    _handlers: {},
    empty() { this.children = []; },
    createEl(t, attrs) {
      const child = mkEl(t);
      if (attrs?.text) child.textContent = attrs.text;
      this.children.push(child);
      return child;
    },
    setText(t) { this.textContent = t; },
    addEventListener(evt, handler) {
      if (!this._handlers[evt]) this._handlers[evt] = [];
      this._handlers[evt].push(handler);
    },
    _trigger(evt, e = {}) {
      for (const h of (this._handlers[evt] ?? [])) h(e);
    },
  };
  return el;
}

export class Modal {
  contentEl: ElStub = mkEl('div');
  constructor(public app: unknown) {}
  open() { this.onOpen(); }
  close() { this.onClose(); }
  onOpen() {}
  onClose() {}
}

export class TextComponent {
  inputEl: ElStub = mkEl('input');
  setPlaceholder(_s: string) { return this; }
  setValue(v: string) { this.inputEl.textContent = v; return this; }
  getValue() { return this.inputEl.textContent; }
}

export class ButtonComponent {
  _text = '';
  _disabled = false;
  _cta = false;
  _clickHandler: (() => void) | null = null;
  setButtonText(s: string) { this._text = s; return this; }
  setCta() { this._cta = true; return this; }
  setDisabled(b: boolean) { this._disabled = b; return this; }
  onClick(fn: () => void) { this._clickHandler = fn; return this; }
}

export class Setting {
  constructor(public containerEl: ElStub) {}
  setName(_s: string) { return this; }
  setDesc(_s: string) { return this; }
  addText(cb: (t: TextComponent) => void) {
    const t = new TextComponent();
    cb(t);
    return this;
  }
  addButton(cb: (b: ButtonComponent) => void) {
    const b = new ButtonComponent();
    cb(b);
    return this;
  }
}

export class Notice {
  constructor(public message: string) {}
}

/** No-op path normalizer. Production Obsidian replaces this with platform-aware logic. */
export const normalizePath = (s: string): string => s;

/**
 * requestUrl stub — fails loudly if a test accidentally hits it without injecting _request.
 * Tests that exercise BrainApiClient should always inject _request; this stub exists only
 * so the import resolves in the test environment.
 */
export async function requestUrl(_params: unknown): Promise<never> {
  throw new Error('requestUrl not mocked — inject _request in BrainApiClient constructor for tests');
}

/** Minimal TFile stub — only the `path` property is required by FileWatcher. */
export class TFile {
  constructor(public path: string) {}
}

/** Opaque event reference returned by vault.on(). */
export type EventRef = { event: string; id: number };

/** Minimal vault stub that supports on/offref for FileWatcher tests. */
export class VaultStub {
  getName() { return 'TestVault'; }
  /** No-op: tests call FileWatcher.queueUpload() directly, not via vault events. */
  on(event: string, _cb: (file: unknown) => void): EventRef {
    return { event, id: Math.random() };
  }
  offref(_ref: EventRef): void { /* no-op */ }
}

// Minimal App stub
export class App {
  vault: VaultStub = new VaultStub();
}

// Minimal Plugin stub
export class Plugin {
  app: App = new App();
  manifest = { id: 'studioos-brain', name: 'StudioOS Brain', version: '0.1.0' };
  async loadData() { return {}; }
  async saveData(_data: unknown) {}
  addSettingTab(_tab: unknown) {}
  addRibbonIcon(_icon: string, _title: string, _cb: () => void) {}
  addCommand(_cmd: { id: string; name: string; callback: () => void }) {}
  async onload() {}
  onunload() {}
  registerInterval(_handle: ReturnType<typeof setInterval>) {}
}

export class PluginSettingTab {
  containerEl: ElStub = mkEl('div');
  constructor(public app: App, public plugin: unknown) {}
  display() {}
  hide() {}
}
