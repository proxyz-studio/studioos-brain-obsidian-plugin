import { describe, expect, it } from 'vitest';
import { generateVaultId } from './vaultIdentity';

describe('generateVaultId', () => {
  it('returns a UUID-like string', () => {
    const id = generateVaultId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns different ids on each call', () => {
    const a = generateVaultId();
    const b = generateVaultId();
    expect(a).not.toBe(b);
  });
});
