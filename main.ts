import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

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

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new StudioOsBrainSettingTab(this.app, this));

    this.addRibbonIcon('brain', 'StudioOS Brain', () => {
      new Notice('StudioOS Brain — open Settings → StudioOS Brain to connect your vault.');
    });

    this.addCommand({
      id: 'studioos-brain-open-settings',
      name: 'Open StudioOS Brain settings',
      callback: () => {
        // Opens the Obsidian settings modal at this plugin's tab
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.app as any).setting?.open?.();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.app as any).setting?.openTabById?.(this.manifest.id);
      },
    });

    console.log('[StudioOS Brain] loaded');
  }

  onunload() {
    console.log('[StudioOS Brain] unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
      text: 'Sync your MY 2nd BRAIN between StudioOS and this Obsidian vault. Sync engine ships in PR-4b.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Connection status')
      .setDesc(this.plugin.settings.token ? 'Connected to StudioOS' : 'Not connected')
      .addButton(btn => btn
        .setButtonText(this.plugin.settings.token ? 'Disconnect' : 'Connect with code')
        .setCta()
        .onClick(() => {
          new Notice('Connect-with-code flow ships in PR-4b.');
        }));

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('Where to sync brain items.')
      .addText(text => text
        .setPlaceholder('https://studioos.proxyz.studio')
        .setValue(this.plugin.settings.apiBaseUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiBaseUrl = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Device label')
      .setDesc('Friendly name shown in StudioOS Settings → Connected Devices.')
      .addText(text => text
        .setPlaceholder('MacBook Pro')
        .setValue(this.plugin.settings.deviceLabel)
        .onChange(async (value) => {
          this.plugin.settings.deviceLabel = value.trim() || 'Unknown device';
          await this.plugin.saveSettings();
        }));
  }
}
