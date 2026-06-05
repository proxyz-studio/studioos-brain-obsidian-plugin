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

export type ApiClientConfig = {
  baseUrl: string;
  token?: string | null;
  /** X-Vault-Id header. Required for all bearer-authed calls (per PR-1 auth model). */
  vaultId?: string | null;
  /** Test-only fetch override. Default: globalThis.fetch */
  _fetch?: typeof fetch;
};

export class BrainApiClient {
  private baseUrl: string;
  private token: string | null;
  private vaultId: string | null;
  private fetcher: typeof fetch;

  constructor(config: ApiClientConfig) {
    // Normalize: strip trailing slash so all URL concat is clean
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.token = config.token ?? null;
    this.vaultId = config.vaultId ?? null;
    this.fetcher = config._fetch ?? fetch;
  }

  /** Mutate auth on existing instance (after a fresh claim). */
  setAuth(token: string, vaultId: string) {
    this.token = token;
    this.vaultId = vaultId;
  }

  /** Claim a pairing code — no auth required (this IS the auth). */
  async claim(req: ClaimRequest): Promise<ClaimSuccess | ClaimError> {
    const r = await this.fetcher(`${this.baseUrl}/api/brain/sync/auth/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) {
      return { ok: true, ...j };
    }
    return { ok: false, code: j.code ?? `http_${r.status}` };
  }

  async heartbeat(): Promise<{ ok: boolean; status: number }> {
    const r = await this.fetcher(`${this.baseUrl}/api/brain/sync/heartbeat`, {
      method: 'POST',
      headers: this.authHeaders(),
    });
    return { ok: r.ok, status: r.status };
  }

  /** GET /changes with optional `since` cursor + If-None-Match for ETag. Returns null on 304. */
  async getChanges(opts: { since?: Date; etag?: string } = {}): Promise<{ data: ChangesResponse | null; notModified: boolean; status: number }> {
    const params = new URLSearchParams();
    if (opts.since) params.set('since', opts.since.toISOString());
    const url = `${this.baseUrl}/api/brain/sync/changes${params.toString() ? `?${params}` : ''}`;
    const headers: Record<string, string> = { ...this.authHeaders() };
    if (opts.etag) headers['If-None-Match'] = opts.etag;
    const r = await this.fetcher(url, { method: 'GET', headers });
    if (r.status === 304) {
      return { data: null, notModified: true, status: 304 };
    }
    if (!r.ok) {
      return { data: null, notModified: false, status: r.status };
    }
    const j = (await r.json()) as ChangesResponse;
    return { data: j, notModified: false, status: r.status };
  }

  async getFile(brainId: string): Promise<FileResponse | null> {
    const r = await this.fetcher(`${this.baseUrl}/api/brain/sync/file/${encodeURIComponent(brainId)}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!r.ok) return null;
    return (await r.json()) as FileResponse;
  }

  async uploadFlowB(payload: UploadFlowB, idempotencyKey: string): Promise<UploadSuccess | UploadError> {
    const r = await this.fetcher(`${this.baseUrl}/api/brain/sync/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-idempotency-key': idempotencyKey,
        ...this.authHeaders(),
      },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok !== false) return { ok: true, ...j, status: r.status };
    return { ok: false, code: j.code ?? `http_${r.status}` };
  }

  async uploadFlowC(payload: UploadFlowC): Promise<UploadSuccess | UploadConflict | UploadError> {
    const r = await this.fetcher(`${this.baseUrl}/api/brain/sync/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409 && j.code === 'hash_mismatch') {
      return j as UploadConflict;
    }
    if (r.ok && j.ok !== false) return { ok: true, ...j, status: r.status };
    return { ok: false, code: j.code ?? `http_${r.status}` };
  }

  async deleteItem(brainId: string): Promise<DeleteResponse> {
    const r = await this.fetcher(`${this.baseUrl}/api/brain/sync/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ brain_id: brainId }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true };
    return { ok: false, code: j.code ?? `http_${r.status}` };
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
