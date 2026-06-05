import { describe, it, expect } from 'vitest';
import { splitBodyAtDelimiter } from './bodySplit';
import { BRAIN_MANAGED_DELIMITER } from './frontmatter';

const DELIM = BRAIN_MANAGED_DELIMITER;

describe('splitBodyAtDelimiter', () => {
  it('returns hasDelimiter: false + whole body as userNotes when no delimiter', () => {
    const body = 'This is a plain note with no delimiter.';
    const result = splitBodyAtDelimiter(body);
    expect(result.hasDelimiter).toBe(false);
    expect(result.userNotes).toBe('This is a plain note with no delimiter.');
    expect(result.brainManaged).toBe('');
  });

  it('splits at delimiter: brainManaged above, userNotes below (stripping My notes header)', () => {
    const body = [
      '## Summary',
      'Server-generated content here.',
      '',
      DELIM,
      '## My notes',
      'my thoughts',
    ].join('\n');
    const result = splitBodyAtDelimiter(body);
    expect(result.hasDelimiter).toBe(true);
    expect(result.brainManaged).toContain('## Summary');
    expect(result.brainManaged).toContain('Server-generated content here.');
    expect(result.userNotes).toBe('my thoughts');
    expect(result.userNotes).not.toContain('## My notes');
  });

  it('returns empty userNotes when nothing below delimiter', () => {
    const body = `Server content.\n${DELIM}`;
    const result = splitBodyAtDelimiter(body);
    expect(result.hasDelimiter).toBe(true);
    expect(result.userNotes).toBe('');
  });

  it('returns empty userNotes when only blank lines below delimiter', () => {
    const body = `Server content.\n${DELIM}\n\n\n`;
    const result = splitBodyAtDelimiter(body);
    expect(result.hasDelimiter).toBe(true);
    expect(result.userNotes).toBe('');
  });

  it('preserves user content below the My notes header', () => {
    const body = [
      'Brain content.',
      DELIM,
      '## My notes',
      '',
      'line one',
      'line two',
    ].join('\n');
    const result = splitBodyAtDelimiter(body);
    expect(result.userNotes).toBe('line one\nline two');
  });

  it('handles user notes without a My notes header', () => {
    const body = `Brain stuff.\n${DELIM}\nJust some raw user notes.`;
    const result = splitBodyAtDelimiter(body);
    expect(result.hasDelimiter).toBe(true);
    expect(result.userNotes).toBe('Just some raw user notes.');
  });

  it('BRAIN_MANAGED_DELIMITER constant exactly matches server string', () => {
    expect(DELIM).toBe('<!-- ↑ Brain-managed. Edit your own notes below. ↓ -->');
  });

  it('multiple leading blank lines before My notes header → same output as server (aligned regex)', () => {
    // Server's extractUserNotesSection uses /^\s+/ which strips ALL leading whitespace including
    // multiple blank lines. Previously the plugin used /^\s*\n/ which only stripped ONE line.
    const body = [
      'Brain content.',
      DELIM,
      '',
      '',
      '## My notes',
      'user content here',
    ].join('\n');
    const result = splitBodyAtDelimiter(body);
    // Should strip ALL leading blank lines + the header, leaving only the user content
    expect(result.userNotes).toBe('user content here');
    expect(result.userNotes).not.toContain('## My notes');
  });

  it('does not include the delimiter itself in brainManaged or userNotes', () => {
    const body = `Above.\n${DELIM}\nBelow.`;
    const result = splitBodyAtDelimiter(body);
    expect(result.brainManaged).not.toContain(DELIM);
    expect(result.userNotes).not.toContain(DELIM);
  });
});
