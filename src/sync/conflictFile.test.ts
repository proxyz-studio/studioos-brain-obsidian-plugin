import { describe, it, expect } from 'vitest';
import { buildConflictFile } from './conflictFile';

const fixedDate = new Date(2026, 5, 6, 14, 37); // 2026-06-06 14:37

describe('buildConflictFile', () => {
  it('builds conflict path with correct stamp format', () => {
    const { conflictPath } = buildConflictFile({
      originalPath: '05-BRAIN/my-note.md',
      loserContent: '---\ntitle: Test\n---\nContent.',
      now: fixedDate,
    });
    expect(conflictPath).toBe('05-BRAIN/my-note (conflict 2026-06-06 1437).md');
  });

  it('preserves the file extension', () => {
    const { conflictPath } = buildConflictFile({
      originalPath: '05-BRAIN/doc.md',
      loserContent: 'Body.',
      now: fixedDate,
    });
    expect(conflictPath.endsWith('.md')).toBe(true);
  });

  it('handles files without an extension', () => {
    const { conflictPath } = buildConflictFile({
      originalPath: '05-BRAIN/no-ext',
      loserContent: 'Body.',
      now: fixedDate,
    });
    expect(conflictPath).toBe('05-BRAIN/no-ext (conflict 2026-06-06 1437)');
  });

  it('strips brain_id from conflict content frontmatter', () => {
    const content = '---\nbrain_id: abc-123\ntitle: My Note\n---\nBody.';
    const { conflictContent } = buildConflictFile({
      originalPath: '05-BRAIN/note.md',
      loserContent: content,
      now: fixedDate,
    });
    expect(conflictContent).not.toContain('brain_id');
    expect(conflictContent).toContain('title: My Note');
    expect(conflictContent).toContain('Body.');
  });

  it('strips content_hash and sync_version from conflict content', () => {
    const content = [
      '---',
      'brain_id: abc-123',
      'content_hash: deadbeef',
      'sync_version: 7',
      'title: My Note',
      '---',
      'Body.',
    ].join('\n');
    const { conflictContent } = buildConflictFile({
      originalPath: '05-BRAIN/note.md',
      loserContent: content,
      now: fixedDate,
    });
    expect(conflictContent).not.toContain('content_hash');
    expect(conflictContent).not.toContain('sync_version');
    expect(conflictContent).toContain('title: My Note');
  });

  it('pads month, day, hour, minute with leading zeros', () => {
    const earlyDate = new Date(2026, 0, 5, 9, 4); // 2026-01-05 09:04
    const { conflictPath } = buildConflictFile({
      originalPath: '05-BRAIN/note.md',
      loserContent: 'Body.',
      now: earlyDate,
    });
    expect(conflictPath).toContain('2026-01-05 0904');
  });

  it('loser content without frontmatter is returned as-is (no strip)', () => {
    const content = 'Plain body with brain_id: abc-123 in the text.';
    const { conflictContent } = buildConflictFile({
      originalPath: '05-BRAIN/note.md',
      loserContent: content,
      now: fixedDate,
    });
    // No frontmatter — stripBrainIdFromFrontmatter leaves it untouched
    expect(conflictContent).toBe(content);
  });
});
