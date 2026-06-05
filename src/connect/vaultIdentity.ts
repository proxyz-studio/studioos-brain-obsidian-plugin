import { App } from 'obsidian';

/** Generate a fresh vault identifier (UUID v4 form). */
export function generateVaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback: random hex assembled into UUID shape
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Read the vault's user-facing name from Obsidian. */
export function getVaultName(app: App): string {
  return app.vault.getName();
}
