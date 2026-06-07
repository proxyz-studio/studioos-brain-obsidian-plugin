import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { BrainApiClient } from './src/api/client';
import { ConnectModal } from './src/connect/ConnectModal';
import { HeartbeatScheduler } from './src/lifecycle/HeartbeatScheduler';
import { ChangesSyncer } from './src/sync/ChangesSyncer';
import { FileWatcher } from './src/sync/FileWatcher';
import { PendingWritesPuller } from './src/sync/PendingWritesPuller';
import { IndexEntry, SyncIndex } from './src/sync/SyncIndex';
import { VaultMirrorPusher } from './src/sync/VaultMirrorPusher';
import { ObsidianVaultWriter } from './src/sync/VaultWriter';

type StudioOsBrainSettings = {
  apiBaseUrl: string;
  token: string | null;
  vaultId: string | null;
  vaultName: string | null;
  deviceLabel: string;
  lastChangesSince: string | null;
  lastChangesEtag: string | null;
  lastVaultMirrorSyncedAt: string | null;
  /** Persisted form of the bidirectional path↔brainId↔hash index. Survives plugin reloads. */
  syncIndexEntries: IndexEntry[];
};

const DEFAULT_SETTINGS: StudioOsBrainSettings = {
  apiBaseUrl: 'https://studioos.proxyz.studio',
  token: null,
  vaultId: null,
  vaultName: null,
  deviceLabel: 'Unknown device',
  lastChangesSince: null,
  lastChangesEtag: null,
  lastVaultMirrorSyncedAt: null,
  syncIndexEntries: [],
};

export default class StudioOsBrainPlugin extends Plugin {
  settings!: StudioOsBrainSettings;
  api!: BrainApiClient;
  private heartbeat: HeartbeatScheduler | null = null;
  private changesSyncer: ChangesSyncer | null = null;
  private fileWatcher: FileWatcher | null = null;
  private vaultMirror: VaultMirrorPusher | null = null;
  /** Persistent bidirectional path↔brainId↔hash index. Hydrated from settings on load. */
  private syncIndex!: SyncIndex;

  async onload() {
    await this.loadSettings();
    this.syncIndex = SyncIndex.fromJSON(this.settings.syncIndexEntries);

    this.api = new BrainApiClient({
      baseUrl: this.settings.apiBaseUrl,
      token: this.settings.token,
      vaultId: this.settings.vaultId,
    });

    // If already connected, start heartbeat + changes syncer + file watcher
    // + vault-mirror pusher immediately
    if (this.settings.token) {
      this.startHeartbeat();
      this.startChangesSyncer();
      this.startFileWatcher();
      void this.startVaultMirror();
    }

    this.addSettingTab(new StudioOsBrainSettingTab(this.app, this));

    this.addRibbonIcon('brain', 'StudioOS Brain', () => {
      if (this.settings.token) {
        new Notice(`StudioOS Brain connected to "${this.settings.vaultName ?? 'your vault'}". Notes sync to 05-BRAIN/.`);
      } else {
        this.openConnectModal();
      }
    });

    this.addCommand({
      id: 'studioos-brain-open-settings',
      name: 'Open StudioOS Brain settings',
      callback: () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.app as any).setting?.open?.();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.app as any).setting?.openTabById?.(this.manifest.id);
      },
    });

    console.log('[StudioOS Brain] loaded');
  }

  onunload() {
    this.heartbeat?.stop();
    this.changesSyncer?.stop();
    this.fileWatcher?.stop();
    this.vaultMirror?.stop();
    console.log('[StudioOS Brain] unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async persistIndex(): Promise<void> {
    this.settings.syncIndexEntries = this.syncIndex.toJSON();
    await this.saveSettings();
  }

  startHeartbeat() {
    if (this.heartbeat) return; // idempotent
    this.heartbeat = new HeartbeatScheduler({
      api: this.api,
      onUnauthorized: async () => {
        this.settings.token = null;
        this.settings.vaultId = null;
        this.settings.vaultName = null;
        await this.saveSettings();
        this.api.setAuth('', '');
        this.heartbeat = null;
        new Notice('StudioOS Brain: connection expired. Please reconnect in Settings.');
      },
    });
    this.heartbeat.start();
  }

  stopHeartbeat() {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }

  startChangesSyncer() {
    if (this.changesSyncer) return; // idempotent
    const writer = new ObsidianVaultWriter(this.app);
    this.changesSyncer = new ChangesSyncer({
      api: this.api,
      writer,
      puller: new PendingWritesPuller({
        api: this.api,
        writer,
        onError: (err) => {
          console.error('[StudioOS Brain] pending writes error:', err);
        },
      }),
      loadCursor: () => ({
        since: this.settings.lastChangesSince,
        etag: this.settings.lastChangesEtag,
      }),
      saveCursor: async (since, etag) => {
        this.settings.lastChangesSince = since;
        this.settings.lastChangesEtag = etag;
        await this.saveSettings();
      },
      onUnauthorized: async () => {
        this.settings.token = null;
        this.settings.vaultId = null;
        this.settings.vaultName = null;
        await this.saveSettings();
        this.api.setAuth('', '');
        this.stopHeartbeat();
        this.changesSyncer = null;
        new Notice('StudioOS Brain: connection expired. Please reconnect in Settings.');
      },
      onError: (err) => {
        console.error('[StudioOS Brain] sync error:', err);
      },
      onChangeApplied: (change) => {
        // Update the persistent index so FileWatcher has hash+brainId after reloads.
        if (change.op === 'upsert' && change.path) {
          this.syncIndex.set({ brainId: change.brain_id, path: change.path, contentHash: change.content_hash });
        } else {
          this.syncIndex.deleteByBrainId(change.brain_id);
        }
        void this.persistIndex();
        // Suppress re-upload of the path ChangesSyncer just wrote to break the sync loop (M2).
        if (change.path) this.fileWatcher?.suppressPath(change.path);
      },
    });
    this.changesSyncer.start();
  }

  stopChangesSyncer() {
    this.changesSyncer?.stop();
    this.changesSyncer = null;
  }

  startFileWatcher() {
    if (this.fileWatcher) return; // idempotent
    this.fileWatcher = new FileWatcher({
      app: this.app,
      api: this.api,
      writer: new ObsidianVaultWriter(this.app),
      syncIndex: this.syncIndex,
      persistIndex: () => this.persistIndex(),
      newRequestId: () => crypto.randomUUID(),
      onError: (msg, err) => {
        console.warn('[StudioOS Brain] upload skipped:', msg, err);
      },
    });
    this.fileWatcher.start();
  }

  stopFileWatcher() {
    this.fileWatcher?.stop();
    this.fileWatcher = null;
  }

  /**
   * Start the vault-mirror pusher (PR H). Walks every markdown file once
   * and registers vault listeners so subsequent edits flow into the
   * server's `obsidian_vault_files` cache. Idempotent.
   */
  async startVaultMirror() {
    if (this.vaultMirror) return;
    this.vaultMirror = new VaultMirrorPusher({
      app: this.app,
      api: this.api,
      onSyncComplete: async () => {
        this.settings.lastVaultMirrorSyncedAt = new Date().toISOString();
        await this.saveSettings();
      },
      log: (msg, ...rest) => console.warn('[StudioOS Brain]', msg, ...rest),
    });
    try {
      await this.vaultMirror.start();
    } catch (err) {
      console.warn('[StudioOS Brain] vault mirror failed to start:', err);
    }
  }

  stopVaultMirror() {
    this.vaultMirror?.stop();
    this.vaultMirror = null;
  }

  async syncVaultMirrorNow(): Promise<void> {
    if (!this.settings.token) {
      new Notice('StudioOS Brain is not connected.');
      return;
    }
    if (!this.vaultMirror) {
      await this.startVaultMirror();
      return;
    }
    const result = await this.vaultMirror.syncNow();
    new Notice(`StudioOS Brain synced ${result.upserted} vault files.`);
  }

  /** Open the ConnectModal. Called from both the ribbon icon and the Settings tab. */
  openConnectModal() {
    new ConnectModal({
      app: this.app,
      api: this.api,
      deviceLabel: this.settings.deviceLabel,
      existingVaultId: this.settings.vaultId,
      onSuccess: async ({ token, vaultId, vaultName }) => {
        this.settings.token = token;
        this.settings.vaultId = vaultId;
        this.settings.vaultName = vaultName;
        await this.saveSettings();
        this.api.setAuth(token, vaultId);
        this.startHeartbeat();
        this.startChangesSyncer();
        this.startFileWatcher();
        void this.startVaultMirror();
      },
    }).open();
  }
}

class StudioOsBrainSettingTab extends PluginSettingTab {
  plugin: StudioOsBrainPlugin;

  constructor(app: App, plugin: StudioOsBrainPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'StudioOS Brain' });
    containerEl.createEl('p', {
      text: 'Sync your MY 2nd BRAIN between StudioOS and this Obsidian vault.',
      cls: 'setting-item-description',
    });

    const isConnected = !!this.plugin.settings.token;

    new Setting(containerEl)
      .setName('Connection status')
      .setDesc(
        isConnected
          ? `Connected${this.plugin.settings.vaultName ? ` · ${this.plugin.settings.vaultName}` : ''}`
          : 'Not connected',
      )
      .addButton((btn) => {
        if (isConnected) {
          // Disconnect button
          btn
            .setButtonText('Disconnect')
            .onClick(async () => {
              this.plugin.stopHeartbeat();
              this.plugin.stopChangesSyncer();
              this.plugin.stopFileWatcher();
              this.plugin.stopVaultMirror();
              this.plugin.settings.token = null;
              this.plugin.settings.vaultId = null;
              this.plugin.settings.vaultName = null;
              this.plugin.settings.lastChangesSince = null;
              this.plugin.settings.lastChangesEtag = null;
              this.plugin.settings.lastVaultMirrorSyncedAt = null;
              this.plugin.settings.syncIndexEntries = [];
              // Reset in-memory index so stale entries don't persist across re-connect
              this.plugin['syncIndex'] = new SyncIndex();
              await this.plugin.saveSettings();
              new Notice('StudioOS Brain disconnected.');
              this.display(); // re-render the tab
            });
        } else {
          // Connect button
          btn
            .setButtonText('Connect with code')
            .setCta()
            .onClick(() => {
              this.plugin.openConnectModal();
            });
        }
      });

    if (isConnected) {
      new Setting(containerEl)
        .setName('Vault index')
        .setDesc(`Refreshes every 5 minutes. Last sync: ${formatLastSync(this.plugin.settings.lastVaultMirrorSyncedAt)}.`)
        .addButton((btn) =>
          btn
            .setButtonText('Sync now')
            .onClick(async () => {
              btn.setDisabled(true).setButtonText('Syncing...');
              try {
                await this.plugin.syncVaultMirrorNow();
              } finally {
                this.display();
              }
            }),
        );
    }

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Where to sync brain items.')
      .addText((text) =>
        text
          .setPlaceholder('https://studioos.proxyz.studio')
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.apiBaseUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Device label')
      .setDesc('Friendly name shown in StudioOS Settings → Connected Devices.')
      .addText((text) =>
        text
          .setPlaceholder('MacBook Pro')
          .setValue(this.plugin.settings.deviceLabel)
          .onChange(async (value) => {
            this.plugin.settings.deviceLabel = value.trim() || 'Unknown device';
            await this.plugin.saveSettings();
          }),
      );
  }
}

function formatLastSync(value: string | null): string {
  if (!value) {
    return 'never';
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
