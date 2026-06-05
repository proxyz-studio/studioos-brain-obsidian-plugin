import { describe, it, expect } from 'vitest';
import { buildUploadPayload } from './uploadPayload';
import { sha256Hex } from './contentHash';
import { BRAIN_MANAGED_DELIMITER } from '../parser/frontmatter';

const DELIM = BRAIN_MANAGED_DELIMITER;

describe('buildUploadPayload', () => {
  it('file with no frontmatter → Flow B with full content + content_hash + idempotencyKey', async () => {
    const content = 'Just a plain note with no frontmatter.';
    const result = await buildUploadPayload({
      path: '05-BRAIN/note.md',
      content,
      requestUuid: 'uuid-1',
      lastKnownServerHash: null,
    });
    expect(result.kind).toBe('flowB');
    if (result.kind === 'flowB') {
      expect(result.payload.content).toBe(content);
      expect(result.payload.path).toBe('05-BRAIN/note.md');
      expect(result.payload.source_type).toBe('note');
      // content_hash = SHA256(content) for fresh uploads
      const expectedHash = await sha256Hex(content);
      expect(result.payload.content_hash).toBe(expectedHash);
      // idempotencyKey lives on the decision, not the payload body
      expect(result.idempotencyKey).toBe('uuid-1');
      expect((result.payload as Record<string, unknown>).request_uuid).toBeUndefined();
    }
  });

  it('file with frontmatter but no brain_id → Flow B', async () => {
    const content = '---\ntitle: My Note\ntags: [ai]\n---\nContent here.';
    const result = await buildUploadPayload({
      path: '05-BRAIN/note.md',
      content,
      requestUuid: 'uuid-2',
      lastKnownServerHash: null,
    });
    expect(result.kind).toBe('flowB');
    if (result.kind === 'flowB') {
      expect(result.payload.content).toBe(content);
    }
  });

  it('file with brain_id + known last_known_server_hash → Flow C with path + extracted userNotes + hash', async () => {
    const userNotes = 'my personal notes here';
    const content = [
      '---',
      'brain_id: abc-123',
      'title: Test Item',
      '---',
      '## Summary',
      'Server content.',
      DELIM,
      '## My notes',
      userNotes,
    ].join('\n');

    const result = await buildUploadPayload({
      path: '05-BRAIN/item.md',
      content,
      requestUuid: 'uuid-3',
      lastKnownServerHash: 'prev-hash-abc',
    });

    expect(result.kind).toBe('flowC');
    if (result.kind === 'flowC') {
      expect(result.payload.brain_id).toBe('abc-123');
      expect(result.payload.path).toBe('05-BRAIN/item.md');
      expect(result.payload.content).toBe(userNotes);
      expect(result.payload.last_known_server_hash).toBe('prev-hash-abc');
      // Hash should be SHA-256 of userNotes only
      const expectedHash = await sha256Hex(userNotes);
      expect(result.payload.content_hash).toBe(expectedHash);
    }
  });

  it('file with brain_id but no last_known_server_hash → skip', async () => {
    const content = '---\nbrain_id: xyz-456\n---\nContent.';
    const result = await buildUploadPayload({
      path: '05-BRAIN/item.md',
      content,
      requestUuid: 'uuid-4',
      lastKnownServerHash: null,
    });
    expect(result.kind).toBe('skip');
    if (result.kind === 'skip') {
      expect(result.reason).toContain('last_known_server_hash unknown');
    }
  });

  it('Flow C content_hash is SHA-256 of userNotes ONLY, not the whole file', async () => {
    const userNotes = 'just my annotation';
    const fullContent = [
      '---',
      'brain_id: def-789',
      '---',
      '## A lot of server generated content that should not affect the hash',
      'Paragraph one. Paragraph two.',
      DELIM,
      '## My notes',
      userNotes,
    ].join('\n');

    const result = await buildUploadPayload({
      path: '05-BRAIN/item.md',
      content: fullContent,
      requestUuid: 'uuid-5',
      lastKnownServerHash: 'some-prev-hash',
    });

    expect(result.kind).toBe('flowC');
    if (result.kind === 'flowC') {
      const wholeFileHash = await sha256Hex(fullContent);
      const userNotesHash = await sha256Hex(userNotes);
      // Must match userNotes hash, not the whole-file hash
      expect(result.payload.content_hash).toBe(userNotesHash);
      expect(result.payload.content_hash).not.toBe(wholeFileHash);
    }
  });
});
