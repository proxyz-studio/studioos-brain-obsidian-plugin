import { describe, it, expect } from 'vitest';
import { sha256Hex } from './contentHash';

describe('sha256Hex', () => {
  it('returns the SHA-256 of an empty string', async () => {
    const result = await sha256Hex('');
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('returns the SHA-256 of "hello"', async () => {
    const result = await sha256Hex('hello');
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns a 64-character hex string', async () => {
    const result = await sha256Hex('some content');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('different inputs produce different hashes', async () => {
    const a = await sha256Hex('content A');
    const b = await sha256Hex('content B');
    expect(a).not.toBe(b);
  });

  it('same input always produces same hash', async () => {
    const input = 'deterministic test';
    const a = await sha256Hex(input);
    const b = await sha256Hex(input);
    expect(a).toBe(b);
  });
});
