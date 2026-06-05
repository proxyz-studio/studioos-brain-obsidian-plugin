import { describe, expect, it, vi } from 'vitest';
import { BrainApiClient } from './client';
import type { ChangeRow, ChangesResponse, ClaimError, ClaimSuccess, FileResponse, UploadConflict, UploadSuccess } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object that vitest's fetch mock returns. */
function makeResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const bodyStr = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyStr),
  } as unknown as Response;
}

function makeClient(fetchMock: ReturnType<typeof vi.fn>, opts?: { token?: string; vaultId?: string }) {
  return new BrainApiClient({
    baseUrl: 'https://studioos.proxyz.studio',
    token: opts?.token ?? null,
    vaultId: opts?.vaultId ?? null,
    _fetch: fetchMock as unknown as typeof fetch,
  });
}

function makeAuthedClient(fetchMock: ReturnType<typeof vi.fn>) {
  return makeClient(fetchMock, { token: 'tok_abc123', vaultId: 'vault_xyz' });
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

describe('BrainApiClient.claim', () => {
  it('returns ClaimSuccess on 200 with token', async () => {
    const mock = vi.fn().mockResolvedValue(
      makeResponse(200, {
        token: 'tok_abc',
        vault_id: 'vault_1',
        server_challenge: 'chall_abc',
      }),
    );
    const client = makeClient(mock);
    const result = await client.claim({
      code: '1234-5678',
      vault_id: 'vault_1',
      vault_name: 'My Vault',
      device_label: 'MacBook Pro',
    });
    expect(result.ok).toBe(true);
    const success = result as ClaimSuccess;
    expect(success.token).toBe('tok_abc');
    expect(success.vault_id).toBe('vault_1');
    expect(success.server_challenge).toBe('chall_abc');
  });

  it('returns ClaimError on 401 expired', async () => {
    const mock = vi.fn().mockResolvedValue(
      makeResponse(401, { ok: false, code: 'expired' }),
    );
    const client = makeClient(mock);
    const result = await client.claim({
      code: '0000-0000',
      vault_id: 'vault_1',
      vault_name: 'My Vault',
      device_label: 'iPad',
    });
    expect(result.ok).toBe(false);
    const err = result as ClaimError;
    expect(err.code).toBe('expired');
  });

  it('returns ClaimError with http_500 code on unexpected 500', async () => {
    const mock = vi.fn().mockResolvedValue(
      makeResponse(500, { message: 'Internal Server Error' }),
    );
    const client = makeClient(mock);
    const result = await client.claim({
      code: '1111-2222',
      vault_id: 'vault_1',
      vault_name: 'My Vault',
      device_label: 'Desktop',
    });
    expect(result.ok).toBe(false);
    const err = result as ClaimError;
    expect(err.code).toBe('http_500');
  });

  it('posts to correct URL without auth headers', async () => {
    const mock = vi.fn().mockResolvedValue(
      makeResponse(200, { token: 't', vault_id: 'v', server_challenge: 'c' }),
    );
    const client = makeClient(mock);
    await client.claim({ code: '1234-5678', vault_id: 'v', vault_name: 'n', device_label: 'd' });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://studioos.proxyz.studio/api/brain/sync/auth/claim');
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------

describe('BrainApiClient.heartbeat', () => {
  it('returns ok:true status:200 on success', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(200, { ok: true }));
    const client = makeAuthedClient(mock);
    const result = await client.heartbeat();
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('returns ok:false status:401 on unauthorized', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(401, { ok: false, code: 'unauthorized' }));
    const client = makeClient(mock); // no auth
    const result = await client.heartbeat();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('sends Authorization + X-Vault-Id headers when authed', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(200, { ok: true }));
    const client = makeAuthedClient(mock);
    await client.heartbeat();
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer tok_abc123');
    expect(h['X-Vault-Id']).toBe('vault_xyz');
  });
});

// ---------------------------------------------------------------------------
// getChanges
// ---------------------------------------------------------------------------

describe('BrainApiClient.getChanges', () => {
  const sampleChange: ChangeRow = {
    brain_id: 'brain_1',
    op: 'upsert',
    path: 'Notes/foo.md',
    content: '# Foo',
    content_hash: 'abc123',
    sync_version: 1,
    updated_at: '2026-06-06T00:00:00Z',
  };

  it('returns ChangesResponse on 200', async () => {
    const body: ChangesResponse = { changes: [sampleChange], etag: '"etag_1"' };
    const mock = vi.fn().mockResolvedValue(makeResponse(200, body));
    const client = makeAuthedClient(mock);
    const result = await client.getChanges();
    expect(result.notModified).toBe(false);
    expect(result.status).toBe(200);
    expect(result.data?.changes).toHaveLength(1);
    expect(result.data?.etag).toBe('"etag_1"');
  });

  it('returns notModified:true on 304', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(304, ''));
    const client = makeAuthedClient(mock);
    const result = await client.getChanges({ etag: '"etag_1"' });
    expect(result.notModified).toBe(true);
    expect(result.data).toBeNull();
    expect(result.status).toBe(304);
  });

  it('sends If-None-Match header when etag passed', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(304, ''));
    const client = makeAuthedClient(mock);
    await client.getChanges({ etag: '"etag_abc"' });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['If-None-Match']).toBe('"etag_abc"');
  });

  it('includes since param in URL when Date passed', async () => {
    const body: ChangesResponse = { changes: [], etag: '"e"' };
    const mock = vi.fn().mockResolvedValue(makeResponse(200, body));
    const client = makeAuthedClient(mock);
    const since = new Date('2026-06-01T00:00:00Z');
    await client.getChanges({ since });
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('since=2026-06-01T00%3A00%3A00.000Z');
  });

  it('returns data:null on 401 (not notModified)', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(401, { ok: false }));
    const client = makeClient(mock);
    const result = await client.getChanges();
    expect(result.data).toBeNull();
    expect(result.notModified).toBe(false);
    expect(result.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// getFile
// ---------------------------------------------------------------------------

describe('BrainApiClient.getFile', () => {
  it('returns FileResponse on 200', async () => {
    const body: FileResponse = {
      brain_id: 'brain_1',
      path: 'Notes/foo.md',
      content: '# Foo',
      content_hash: 'abc',
      sync_version: 1,
    };
    const mock = vi.fn().mockResolvedValue(makeResponse(200, body));
    const client = makeAuthedClient(mock);
    const result = await client.getFile('brain_1');
    expect(result).not.toBeNull();
    expect(result?.brain_id).toBe('brain_1');
    expect(result?.content_hash).toBe('abc');
  });

  it('returns null on 404', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(404, { ok: false, code: 'not_found' }));
    const client = makeAuthedClient(mock);
    const result = await client.getFile('brain_missing');
    expect(result).toBeNull();
  });

  it('URL-encodes the brainId', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(200, {
      brain_id: 'brain/special',
      path: 'p',
      content: 'c',
      content_hash: 'h',
      sync_version: 1,
    }));
    const client = makeAuthedClient(mock);
    await client.getFile('brain/special');
    const [url] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('brain%2Fspecial');
  });
});

// ---------------------------------------------------------------------------
// uploadFlowB
// ---------------------------------------------------------------------------

describe('BrainApiClient.uploadFlowB', () => {
  it('returns UploadSuccess on 201', async () => {
    const body = { ok: true, brain_id: 'brain_1', content_hash: 'hash_1', sync_version: 1 };
    const mock = vi.fn().mockResolvedValue(makeResponse(201, body));
    const client = makeAuthedClient(mock);
    const result = await client.uploadFlowB(
      { path: 'Notes/foo.md', content: '# Foo', source_type: 'note', content_hash: 'hash_1' },
      'idem-key-1',
    );
    expect(result.ok).toBe(true);
    const success = result as UploadSuccess;
    expect(success.brain_id).toBe('brain_1');
    expect(success.content_hash).toBe('hash_1');
  });

  it('returns UploadError on 401', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(401, { ok: false, code: 'unauthorized' }));
    const client = makeClient(mock);
    const result = await client.uploadFlowB(
      { path: 'Notes/foo.md', content: '# Foo', source_type: 'note', content_hash: 'hash_x' },
      'idem-key-2',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unauthorized');
  });

  it('sends x-idempotency-key header and content_hash in body', async () => {
    const body = { ok: true, brain_id: 'brain_1', content_hash: 'hash_1', sync_version: 1 };
    const mock = vi.fn().mockResolvedValue(makeResponse(201, body));
    const client = makeAuthedClient(mock);
    await client.uploadFlowB(
      { path: 'Notes/foo.md', content: '# Foo', source_type: 'note', content_hash: 'hash_1' },
      'my-idem-key',
    );
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['x-idempotency-key']).toBe('my-idem-key');
    const bodyParsed = JSON.parse(init.body as string);
    expect(bodyParsed.content_hash).toBe('hash_1');
    expect(bodyParsed.request_uuid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// uploadFlowC
// ---------------------------------------------------------------------------

describe('BrainApiClient.uploadFlowC', () => {
  it('returns UploadConflict on 409 hash_mismatch', async () => {
    const body: UploadConflict = {
      ok: false,
      code: 'hash_mismatch',
      canonical: {
        brain_id: 'brain_1',
        content: '# Server version',
        content_hash: 'server_hash',
        sync_version: 2,
      },
    };
    const mock = vi.fn().mockResolvedValue(makeResponse(409, body));
    const client = makeAuthedClient(mock);
    const result = await client.uploadFlowC({
      brain_id: 'brain_1',
      path: 'Notes/foo.md',
      content: '# Client version',
      content_hash: 'client_hash',
      last_known_server_hash: 'old_hash',
    });
    expect(result.ok).toBe(false);
    const conflict = result as UploadConflict;
    expect(conflict.code).toBe('hash_mismatch');
    expect(conflict.canonical.sync_version).toBe(2);
  });

  it('returns UploadSuccess on 200 applied', async () => {
    const body = { ok: true, brain_id: 'brain_1', content_hash: 'new_hash', sync_version: 3 };
    const mock = vi.fn().mockResolvedValue(makeResponse(200, body));
    const client = makeAuthedClient(mock);
    const result = await client.uploadFlowC({
      brain_id: 'brain_1',
      path: 'Notes/foo.md',
      content: '# Updated',
      content_hash: 'new_hash',
      last_known_server_hash: 'old_hash',
    });
    expect(result.ok).toBe(true);
    const success = result as UploadSuccess;
    expect(success.sync_version).toBe(3);
  });

  it('returns UploadError on 413 too_large', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(413, { ok: false, code: 'too_large' }));
    const client = makeAuthedClient(mock);
    const result = await client.uploadFlowC({
      brain_id: 'brain_1',
      path: 'Notes/foo.md',
      content: 'x'.repeat(300000),
      content_hash: 'h',
      last_known_server_hash: 'old',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_large');
  });

  it('sends path in body alongside brain_id', async () => {
    const body = { ok: true, brain_id: 'brain_1', content_hash: 'new_hash', sync_version: 3 };
    const mock = vi.fn().mockResolvedValue(makeResponse(200, body));
    const client = makeAuthedClient(mock);
    await client.uploadFlowC({
      brain_id: 'brain_1',
      path: '05-BRAIN/item.md',
      content: 'user notes',
      content_hash: 'new_hash',
      last_known_server_hash: 'old_hash',
    });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const bodyParsed = JSON.parse(init.body as string);
    expect(bodyParsed.path).toBe('05-BRAIN/item.md');
    expect(bodyParsed.brain_id).toBe('brain_1');
  });
});

// ---------------------------------------------------------------------------
// deleteItem
// ---------------------------------------------------------------------------

describe('BrainApiClient.deleteItem', () => {
  it('returns ok:true on 200', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(200, { ok: true }));
    const client = makeAuthedClient(mock);
    const result = await client.deleteItem('brain_1');
    expect(result.ok).toBe(true);
  });

  it('returns ok:false with code on error', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(401, { ok: false, code: 'unauthorized' }));
    const client = makeClient(mock);
    const result = await client.deleteItem('brain_1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unauthorized');
  });

  it('sends correct body with brain_id', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(200, { ok: true }));
    const client = makeAuthedClient(mock);
    await client.deleteItem('brain_abc');
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ brain_id: 'brain_abc' });
  });
});

// ---------------------------------------------------------------------------
// setAuth — mutates token + vaultId and subsequent calls include new headers
// ---------------------------------------------------------------------------

describe('BrainApiClient.setAuth', () => {
  it('updates auth and subsequent calls use the new token', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(200, { ok: true }));
    const client = makeClient(mock); // starts with no auth
    client.setAuth('new_token', 'new_vault');
    await client.heartbeat();
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer new_token');
    expect(h['X-Vault-Id']).toBe('new_vault');
  });
});

// ---------------------------------------------------------------------------
// Empty auth — no Authorization / X-Vault-Id headers sent
// ---------------------------------------------------------------------------

describe('BrainApiClient with no auth', () => {
  it('sends no Authorization or X-Vault-Id headers', async () => {
    const mock = vi.fn().mockResolvedValue(makeResponse(401, { ok: false }));
    const client = makeClient(mock); // no token, no vaultId
    await client.heartbeat();
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h['Authorization']).toBeUndefined();
    expect(h['X-Vault-Id']).toBeUndefined();
  });
});
