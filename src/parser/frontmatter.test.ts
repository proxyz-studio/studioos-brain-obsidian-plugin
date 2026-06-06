import { describe, it, expect } from 'vitest';
import { parseFrontmatter, stripBrainIdFromFrontmatter, BRAIN_MANAGED_DELIMITER } from './frontmatter';

describe('parseFrontmatter', () => {
  it('parses simple key: value lines', () => {
    const content = '---\ntitle: My Note\nauthor: Tew\n---\nBody here.';
    const result = parseFrontmatter(content);
    expect(result.hasFrontmatter).toBe(true);
    expect(result.frontmatter.title).toBe('My Note');
    expect(result.frontmatter.author).toBe('Tew');
    expect(result.body).toBe('Body here.');
  });

  it('parses number values as numbers', () => {
    const content = '---\ncount: 42\nprice: 3.14\nneg: -7\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.count).toBe(42);
    expect(result.frontmatter.price).toBe(3.14);
    expect(result.frontmatter.neg).toBe(-7);
  });

  it('parses boolean values', () => {
    const content = '---\nactive: true\ndraft: false\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.active).toBe(true);
    expect(result.frontmatter.draft).toBe(false);
  });

  it('parses flow-style lists', () => {
    const content = '---\ntags: [ai, research, brain]\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.tags).toEqual(['ai', 'research', 'brain']);
  });

  it('parses an empty flow-style list', () => {
    const content = '---\ntags: []\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.tags).toEqual([]);
  });

  it('returns hasFrontmatter: false when no opening ---', () => {
    const content = 'title: My Note\nBody here.';
    const result = parseFrontmatter(content);
    expect(result.hasFrontmatter).toBe(false);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it('returns hasFrontmatter: false when no closing ---', () => {
    const content = '---\ntitle: My Note\nBody without close.';
    const result = parseFrontmatter(content);
    expect(result.hasFrontmatter).toBe(false);
  });

  it('unquotes double-quoted strings', () => {
    const content = '---\ntitle: "hello world"\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.title).toBe('hello world');
  });

  it('handles escaped quotes inside quoted strings', () => {
    const content = '---\ntitle: "he said \\"hi\\""\n---\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.title).toBe('he said "hi"');
  });

  it('trims leading newline from body after frontmatter', () => {
    const content = '---\ntitle: Test\n---\n\nBody paragraph.';
    const result = parseFrontmatter(content);
    // Leading newline after close --- should be trimmed
    expect(result.body).toBe('Body paragraph.');
  });

  it('handles brain_id as a UUID string', () => {
    const content = '---\nbrain_id: abc-123-def\nsync_version: 5\n---\nSome content.';
    const result = parseFrontmatter(content);
    expect(result.frontmatter.brain_id).toBe('abc-123-def');
    expect(result.frontmatter.sync_version).toBe(5);
  });
});

describe('stripBrainIdFromFrontmatter', () => {
  it('removes brain_id, content_hash, and sync_version lines from frontmatter', () => {
    const content = [
      '---',
      'title: My Note',
      'brain_id: abc-123',
      'content_hash: deadbeef',
      'sync_version: 3',
      'tags: [ai]',
      '---',
      'Body text here.',
    ].join('\n');

    const result = stripBrainIdFromFrontmatter(content);
    expect(result).not.toContain('brain_id');
    expect(result).not.toContain('content_hash');
    expect(result).not.toContain('sync_version');
    expect(result).toContain('title: My Note');
    expect(result).toContain('tags: [ai]');
    expect(result).toContain('Body text here.');
  });

  it('leaves files without frontmatter unchanged', () => {
    const content = 'No frontmatter here.\nbrain_id: this is just body text.';
    expect(stripBrainIdFromFrontmatter(content)).toBe(content);
  });

  it('preserves other frontmatter fields', () => {
    const content = '---\nauthor: Tew\nbrain_id: xyz\ntags: [a, b]\n---\nBody.';
    const result = stripBrainIdFromFrontmatter(content);
    expect(result).toContain('author: Tew');
    expect(result).toContain('tags: [a, b]');
    expect(result).not.toContain('brain_id');
  });

  it('BRAIN_MANAGED_DELIMITER constant exactly matches expected server string', () => {
    expect(BRAIN_MANAGED_DELIMITER).toBe(
      '<!-- ↑ Brain-managed. Edit your own notes below. ↓ -->',
    );
  });
});
