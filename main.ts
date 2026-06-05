import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { BrainApiClient } from './src/api/client';
import { ConnectModal } from './src/connect/ConnectModal';
import { HeartbeatScheduler } from './src/lifecycle/HeartbeatScheduler';

type StudioOsBrainSettings = {
  apiBaseUrl: string;
  token: string | null;
  vaultId: string | null;
  vaultName: string | null;
  deviceLabel: string;
};

const DEFAULT_SETTINGS: StudioOsBrainSettings = {
  apiBaseUrl: 'https://studioos.proxyz.studio',
  token: null,
  vaultId: null,
  vaultName: null,
  deviceLabel: 'Unknown device',
};

export default class StudioOsBrainPlugin extends Plugin {
  settings!: StudioOsBrainSettings;
  api!: BrainApiClient;
  private heartbeat: HeartbeatScheduler | null = null;

  async onload() {
    await this.loadSettings();

    this.api = new BrainApiClient({
      baseUrl: this.settings.apiBaseUrl,
      token: this.settings.token,
      vaultId: this.settings.vaultId,
    });

    // If already connected, start heartbeat immediately
    if (this.settings.token) {
      this.startHeartbeat();
    }

    this.addSettingTab(new StudioOsBrainSettingTab(this.app, this));

    this.addRibbonIcon('brain', 'StudioOS Brain', () => {
      new Notice(
        this.settings.token
          ? 'StudioOS Brain is connected. Open Settings → StudioOS Brain to manage.'
          : 'StudioOS Brain — open Settings → StudioOS Brain to connect your vault.',
      );
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
    console.log('[StudioOS Brain] unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
              this.plugin.settings.token = null;
              this.plugin.settings.vaultId = null;
              this.plugin.settings.vaultName = null;
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
              new ConnectModal({
                app: this.app,
                api: this.plugin.api,
                deviceLabel: this.plugin.settings.deviceLabel,
                existingVaultId: this.plugin.settings.vaultId,
                onSuccess: async ({ token, vaultId, vaultName }) => {
                  this.plugin.settings.token = token;
                  this.plugin.settings.vaultId = vaultId;
                  this.plugin.settings.vaultName = vaultName;
                  await this.plugin.saveSettings();
                  this.plugin.api.setAuth(token, vaultId);
                  this.plugin.startHeartbeat();
                  this.display(); // re-render the tab
                },
              }).open();
            });
        }
      });

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
