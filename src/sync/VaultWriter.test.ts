import { describe, expect, it } from 'vitest';
import { MemoryVaultWriter } from './VaultWriter';

describe('MemoryVaultWriter', () => {
  it('write then read round-trips', async () => {
    const w = new MemoryVaultWriter();
    await w.write('05-BRAIN/foo.md', 'hello');
    expect(await w.read('05-BRAIN/foo.md')).toBe('hello');
  });

  it('exists returns false before write, true after', async () => {
    const w = new MemoryVaultWriter();
    expect(await w.exists('x')).toBe(false);
    await w.write('x', 'y');
    expect(await w.exists('x')).toBe(true);
  });

  it('delete removes a file', async () => {
    const w = new MemoryVaultWriter();
    await w.write('a', '1');
    await w.delete('a');
    expect(await w.exists('a')).toBe(false);
  });

  it('records call log for assertion', async () => {
    const w = new MemoryVaultWriter();
    await w.write('a', '1');
    await w.delete('a');
    expect(w.calls).toEqual([
      { op: 'write', path: 'a', content: '1' },
      { op: 'delete', path: 'a' },
    ]);
  });
});
