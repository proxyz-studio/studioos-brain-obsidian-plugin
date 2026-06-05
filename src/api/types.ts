/** Shapes shared between client + server. Mirror the StudioOS API contract. */

export type ClaimRequest = {
  code: string; // 'NNNN-NNNN' formatted OR raw 8 digits
  vault_id: string;
  vault_name: string;
  device_label: string;
};

export type ClaimSuccess = {
  ok: true;
  token: string;
  vault_id: string;
  server_challenge: string;
};

export type ClaimError = {
  ok: false;
  code: 'invalid_code' | 'expired' | 'wrong_vault' | 'attempts_exceeded' | 'malformed_body' | 'invalid_body' | 'unauthorized' | string;
  current_vault?: string;
  instructions?: string;
};

export type ChangeRow = {
  id: string;
  path: string | null;
  content: string;
  content_hash: string;
  sync_version: number;
  deleted_at: string | null;
  updated_at: string;
};

export type ChangesResponse = {
  changes: ChangeRow[];
  etag: string;
};

export type FileResponse = {
  id: string;
  path: string;
  content: string;
  content_hash: string;
  sync_version: number;
};

export type UploadFlowB = {
  path: string;
  content: string;
  source_type: 'note';
  request_uuid: string;
};

export type UploadFlowC = {
  brain_id: string;
  content: string;
  content_hash: string;
  last_known_server_hash: string;
};

export type UploadSuccess = {
  ok: true;
  brain_id: string;
  content_hash: string;
  sync_version: number;
  status?: number;
};

export type UploadConflict = {
  ok: false;
  code: 'hash_mismatch';
  canonical: {
    brain_id: string;
    content: string;
    content_hash: string;
    sync_version: number;
  };
};

export type UploadError = {
  ok: false;
  code: 'unauthorized' | 'vault_mismatch' | 'not_found' | 'too_large' | 'rate_limited' | string;
};

export type DeleteResponse = { ok: true } | { ok: false; code: string };
