/**
 * Minimal Sigma REST helper for the migration scripts.
 *
 * Auth: either supply SIGMA_API_TOKEN directly, or SIGMA_CLIENT_ID +
 * SIGMA_CLIENT_SECRET (exchanged here for a bearer token).
 *
 * Env:
 *   SIGMA_BASE_URL        e.g. https://aws-api.sigmacomputing.com
 *   SIGMA_API_TOKEN       (or) SIGMA_CLIENT_ID + SIGMA_CLIENT_SECRET
 *   SIGMA_FOLDER_ID       target folder for created DMs/workbooks
 *   SIGMA_CONNECTION_ID   warehouse connection the universe points at
 *   SIGMA_DATABASE, SIGMA_SCHEMA   optional path overrides
 */

const BASE = (process.env.SIGMA_BASE_URL || 'https://aws-api.sigmacomputing.com').replace(/\/$/, '');
let _token = process.env.SIGMA_API_TOKEN || '';

export async function sigmaToken() {
  if (_token) return _token;
  const id = process.env.SIGMA_CLIENT_ID, secret = process.env.SIGMA_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set SIGMA_API_TOKEN, or SIGMA_CLIENT_ID + SIGMA_CLIENT_SECRET');
  const res = await fetch(`${BASE}/v2/auth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  if (!res.ok) throw new Error(`Sigma auth failed: HTTP ${res.status} ${await res.text()}`);
  _token = (await res.json()).access_token;
  return _token;
}

async function req(method, path, body, asText = false) {
  const tok = await sigmaToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${txt.slice(0, 400)}`);
  if (asText) return txt;
  try { return JSON.parse(txt); } catch { return txt; }
}

/** POST a data model spec → { dataModelId }. */
export async function postDataModel(model, folderId = process.env.SIGMA_FOLDER_ID) {
  if (!folderId) throw new Error('Set SIGMA_FOLDER_ID');
  const j = await req('POST', '/v2/dataModels/spec', { folderId, ...model });
  return j.dataModelId || j.id;
}

/** GET a data model spec back (to discover server-assigned element IDs). */
export async function getDataModelSpec(dataModelId) {
  return req('GET', `/v2/dataModels/${dataModelId}/spec`);
}

/**
 * POST a full spec back to update an EXISTING data model in place (e.g. after
 * merging dataModelAdditions into its View element).
 *
 * ASSUMPTION (unverified — confirm live in Task 8): mirrors the GET path
 * (`/v2/dataModels/{id}/spec`) with POST for a full-spec replace, the same
 * "code representation" convention `postDataModel`/`postWorkbook` use for
 * create. Unlike `referenceWorkbookSchemaVersion`'s workbook-spec GET (which
 * comes back as YAML text), `getDataModelSpec` above already round-trips as
 * plain JSON (established by migrate-universe.mjs, pre-dating this task) — so
 * this POST sends the merged object as JSON, not YAML. If the live endpoint
 * differs (e.g. requires PUT, or a different path), Task 8's e2e harness will
 * surface it as an HTTP error on this call.
 */
export async function postDataModelSpec(dataModelId, spec) {
  return req('POST', `/v2/dataModels/${dataModelId}/spec`, spec);
}

/** Read the current workbook schemaVersion from any reference workbook (spec is YAML). */
export async function referenceWorkbookSchemaVersion() {
  const list = await req('GET', '/v2/workbooks?limit=1');
  const wbId = list.entries?.[0]?.workbookId || list.entries?.[0]?.id;
  if (!wbId) return 1;
  const yaml = await req('GET', `/v2/workbooks/${wbId}/spec`, null, true);
  const m = yaml.match(/schemaVersion:\s*(\d+)/);
  return m ? Number(m[1]) : 1;
}

/** POST a workbook spec → { workbookId }. */
export async function postWorkbook(workbook) {
  const txt = await req('POST', '/v2/workbooks/spec', workbook, true);
  const m = txt.match(/workbookId:\s*"?([0-9a-f-]+)/) || txt.match(/"workbookId"\s*:\s*"([0-9a-f-]+)"/);
  return m ? m[1] : null;
}

/** DELETE any Sigma file (data model or workbook) by id. */
export async function deleteFile(id) { return req('DELETE', `/v2/files/${id}`, null, true); }

export const SIGMA_BASE = BASE;
