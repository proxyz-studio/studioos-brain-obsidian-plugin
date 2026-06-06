import { App, ButtonComponent, Modal, Notice, Setting, TextComponent } from 'obsidian';
import { BrainApiClient } from '../api/client';
import { generateVaultId, getVaultName } from './vaultIdentity';

export type ConnectModalDeps = {
  app: App;
  api: BrainApiClient;
  deviceLabel: string;
  existingVaultId: string | null;
  onSuccess: (claim: { token: string; vaultId: string; vaultName: string }) => Promise<void> | void;
};

export class ConnectModal extends Modal {
  private deps: ConnectModalDeps;
  private codeInput!: TextComponent;
  private submitBtn!: ButtonComponent;
  private statusEl!: HTMLElement;

  constructor(deps: ConnectModalDeps) {
    super(deps.app);
    this.deps = deps;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Connect StudioOS Brain' });
    contentEl.createEl('p', {
      text: 'Open StudioOS in your browser at the brain setup page, then paste the 8-digit code here.',
    });

    new Setting(contentEl)
      .setName('Pairing code')
      .setDesc('Format: NNNN-NNNN (the dash is optional)')
      .addText((text) => {
        this.codeInput = text;
        text.setPlaceholder('4829-1573');
        text.inputEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') void this.submit();
        });
      });

    this.statusEl = contentEl.createEl('p', {
      text: '',
      cls: 'setting-item-description',
    });
    this.statusEl.style.minHeight = '1.2em';

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Cancel').onClick(() => this.close());
      })
      .addButton((btn) => {
        this.submitBtn = btn;
        btn.setButtonText('Connect').setCta().onClick(() => void this.submit());
      });
  }

  onClose() {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const raw = this.codeInput.getValue().trim();
    if (!raw) {
      this.setStatus('Enter a pairing code first.', 'warn');
      return;
    }

    this.setStatus('Connecting…', 'info');
    this.submitBtn.setDisabled(true);

    try {
      const vaultId = this.deps.existingVaultId ?? generateVaultId();
      const vaultName = getVaultName(this.deps.app);

      const r = await this.deps.api.claim({
        code: raw,
        vault_id: vaultId,
        vault_name: vaultName,
        device_label: this.deps.deviceLabel,
      });

      if (r.ok) {
        await this.deps.onSuccess({ token: r.token, vaultId: r.vault_id, vaultName });
        new Notice('Connected to StudioOS Brain.');
        this.close();
        return;
      }

      this.submitBtn.setDisabled(false);
      this.setStatus(this.errorMessageFor(r.code), 'error');
    } catch (err) {
      this.submitBtn.setDisabled(false);
      this.setStatus('Connection failed — check your internet and the server URL in settings, then try again.', 'error');
      console.error('[StudioOS Brain] connect failed:', err);
    }
  }

  private setStatus(msg: string, level: 'info' | 'warn' | 'error') {
    this.statusEl.setText(msg);
    this.statusEl.style.color =
      level === 'error'
        ? 'var(--text-error)'
        : level === 'warn'
          ? 'var(--text-warning)'
          : 'var(--text-muted)';
  }

  private errorMessageFor(code: string): string {
    switch (code) {
      case 'invalid_code':
      case 'malformed_body':
      case 'invalid_body':
        return "That code didn't work. Check the digits and try again.";
      case 'expired':
        return 'This code has expired. Generate a new one on the StudioOS web page.';
      case 'wrong_vault':
        return "You're already connected to a different vault. Disconnect those devices first via StudioOS Settings.";
      case 'attempts_exceeded':
        return 'Too many attempts on this code. Generate a new one on the StudioOS web page.';
      default:
        return `Couldn't connect (error: ${code}).`;
    }
  }
}
