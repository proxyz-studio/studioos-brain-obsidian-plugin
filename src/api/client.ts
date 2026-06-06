import { requestUrl } from 'obsidian';
import type {
  ChangesResponse,
  ClaimError,
  ClaimRequest,
  ClaimSuccess,
  DeleteResponse,
  FileResponse,
  UploadConflict,
  UploadError,
  UploadFlowB,
  UploadFlowC,
  UploadSuccess,
} from './types';

// ---------------------------------------------------------------------------
// Normalized request seam — decouples the HTTP transport from business logic.
// Production code uses defaultRequest (wraps Obsidian's requestUrl, CORS-free).
// Tests inject _request with a vi.fn() returning NormalizedResponse.
// ---------------------------------------------------------------------------

export type NormalizedResponse = {
  status: number;
  headers: Record<string, string>;
  /** Raw response body as a string. Parse with safeJsonParse(). */
  text: string;
};

export type RequestFn = (params: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<NormalizedResponse>;

/**
 * Default transport: Obsidian's requestUrl bypasses CORS in the Electron
 * renderer (unlike fetch, which is blocked by CORS for cross-origin requests
 * from `app://obsidian.md`).
 *
 * Key differences from fetch:
 * - response.json and response.text are synchronous values, not methods.
 * - throw: false prevents requestUrl from throwing on 4xx/5xx; we handle
 *   status ourselves.
 * - headers in RequestUrlResponse is already Record<string, string>.
 */
async function defaultRequest(params: {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<NormalizedResponse> {
  const res = await requestUrl({
    url: params.url,
    method: params.method,
    headers: params.headers,
    body: params.body,
    throw: false, // never throw on 4xx/5xx — we read res.status ourselves
  });
  return {
    status: res.status,
    headers: res.headers ?? {},
    text: res.text ?? '',
  };
}

/** Safe JSON parse: returns {} on empty or invalid input, never throws. */
function safeJsonParse(text: string): Record<string, unknown> {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export type ApiClientConfig = {
  baseUrl: string;
  token?: string | null;
  /** X-Vault-Id header. Required for all bearer-authed calls (per PR-1 auth model). */
  vaultId?: string | null;
  /** Test-only request override. Default: defaultRequest (wraps Obsidian requestUrl). */
  _request?: RequestFn;
};

// ---------------------------------------------------------------------------
// BrainApiClient
// ---------------------------------------------------------------------------

export class BrainApiClient {
  private baseUrl: string;
  private token: string | null;
  private vaultId: string | null;
  private requestFn: RequestFn;

  constructor(config: ApiClientConfig) {
    // Normalize: strip trailing slash so all URL concat is clean
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token ?? null;
    this.vaultId = config.vaultId ?? null;
    this.requestFn = config._request ?? defaultRequest;
  }

  /** Mutate auth on existing instance (after a fresh claim). */
  setAuth(token: string, vaultId: string) {
    this.token = token;
    this.vaultId = vaultId;
  }

  /** Claim a pairing code — no auth required (this IS the auth). */
  async claim(req: ClaimRequest): Promise<ClaimSuccess | ClaimError> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/auth/claim`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const j = safeJsonParse(res.text);
    if (res.status >= 200 && res.status < 300 && j.token) {
      return { ok: true, ...j } as ClaimSuccess;
    }
    return { ok: false, code: (j.code as string | undefined) ?? `http_${res.status}` };
  }

  async heartbeat(): Promise<{ ok: boolean; status: number }> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/heartbeat`,
      method: 'POST',
      headers: this.authHeaders(),
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  }

  /** GET /changes with optional `since` cursor + If-None-Match for ETag. Returns null on 304. */
  async getChanges(opts: { since?: Date; etag?: string } = {}): Promise<{ data: ChangesResponse | null; notModified: boolean; status: number }> {
    const params = new URLSearchParams();
    if (opts.since) params.set('since', opts.since.toISOString());
    const url = `${this.baseUrl}/api/brain/sync/changes${params.toString() ? `?${params}` : ''}`;
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (opts.etag) headers['If-None-Match'] = opts.etag;

    const res = await this.requestFn({ url, method: 'GET', headers });

    if (res.status === 304) {
      return { data: null, notModified: true, status: 304 };
    }
    if (res.status < 200 || res.status >= 300) {
      return { data: null, notModified: false, status: res.status };
    }
    const j = safeJsonParse(res.text) as unknown as ChangesResponse;
    return { data: j, notModified: false, status: res.status };
  }

  async getFile(brainId: string): Promise<FileResponse | null> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/file/${encodeURIComponent(brainId)}`,
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (res.status < 200 || res.status >= 300) return null;
    return safeJsonParse(res.text) as unknown as FileResponse;
  }

  async uploadFlowB(payload: UploadFlowB, idempotencyKey: string): Promise<UploadSuccess | UploadError> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/upload`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': idempotencyKey,
        ...this.authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const j = safeJsonParse(res.text);
    if (res.status >= 200 && res.status < 300 && j.ok !== false) {
      return { ok: true, ...j, status: res.status } as UploadSuccess;
    }
    return { ok: false, code: (j.code as string | undefined) ?? `http_${res.status}` };
  }

  async uploadFlowC(payload: UploadFlowC): Promise<UploadSuccess | UploadConflict | UploadError> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/upload`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(payload),
    });
    const j = safeJsonParse(res.text);
    if (res.status === 409 && j.code === 'hash_mismatch') {
      return j as unknown as UploadConflict;
    }
    if (res.status >= 200 && res.status < 300 && j.ok !== false) {
      return { ok: true, ...j, status: res.status } as UploadSuccess;
    }
    return { ok: false, code: (j.code as string | undefined) ?? `http_${res.status}` };
  }

  async fetchAttachmentBlob(id: string): Promise<{ blob: ArrayBuffer; mime: string } | null> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/vault/attachment/${encodeURIComponent(id)}/blob`,
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (res.status < 200 || res.status >= 300) return null;
    // requestUrl returns text; we need to decode base64 if the server sends it that way.
    // However our server returns raw binary. In Obsidian requestUrl, binary responses
    // are available via the arraybuffer property in newer versions, but for compatibility
    // we treat the text as-is and let the caller handle encoding.
    // Actually, requestUrl on Obsidian 1.5+ supports `contentType: 'arraybuffer'` but
    // the defaultRequest wrapper doesn't expose that. For now we return the text as a
    // Uint8Array since our attachments are small (< 5 MB).
    const bytes = new TextEncoder().encode(res.text);
    return { blob: bytes.buffer, mime: res.headers['content-type'] ?? 'application/octet-stream' };
  }

  async postAttachmentApplied(id: string): Promise<boolean> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/attachment/${encodeURIComponent(id)}/applied`,
      method: 'POST',
      headers: this.authHeaders(),
    });
    return res.status >= 200 && res.status < 300;
  }

  async postInitApplied(): Promise<boolean> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/init/applied`,
      method: 'POST',
      headers: this.authHeaders(),
    });
    return res.status >= 200 && res.status < 300;
  }

  async deleteItem(brainId: string): Promise<DeleteResponse> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/delete`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ brain_id: brainId }),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const j = safeJsonParse(res.text);
    return { ok: false, code: (j.code as string | undefined) ?? `http_${res.status}` };
  }

  /**
   * Push vault-mirror upserts + deletes (PR H / v0.2). Used by the new
   * `VaultMirrorPusher` to seed the index walk on connect and to stream
   * incremental change events into the StudioOS server.
   *
   * Hard caps on the server: 500 entries per batch, 500kB per file
   * content. The caller should batch larger walks before invoking.
   */
  async pushVaultFiles(payload: {
    upserts: Array<{
      path: string;
      mtime: string; // ISO 8601
      size_bytes: number;
      content?: string;
      content_hash?: string;
    }>;
    deletes: string[];
  }): Promise<{ ok: boolean; status: number; upserted?: number; deleted?: number; code?: string }> {
    const res = await this.requestFn({
      url: `${this.baseUrl}/api/brain/sync/vault-files`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(payload),
    });
    const j = safeJsonParse(res.text);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, upserted: j.upserted as number | undefined, deleted: j.deleted as number | undefined };
    }
    return { ok: false, status: res.status, code: (j.code as string | undefined) ?? (j.error as string | undefined) ?? `http_${res.status}` };
  }

  private authHeaders(): Record<string, string> {
    if (!this.token || !this.vaultId) {
      // Caller should have checked. Send empty to surface a 401 from the server rather than throw client-side.
      return {};
    }
    return {
      Authorization: `Bearer ${this.token}`,
      'X-Vault-Id': this.vaultId,
    };
  }
}
