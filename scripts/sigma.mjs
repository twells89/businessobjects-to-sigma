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

import { prepareWorkbookForPost } from './code_rep.mjs';

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
 * PUT a full spec back to update an EXISTING data model in place (e.g. after
 * merging dataModelAdditions into its View element).
 *
 * CONFIRMED live in Task 8 against the Sigma "code representation" OpenAPI
 * (https://help.sigmacomputing.com/openapi/openapi/code-representation.json →
 * `/v2/dataModels/{dataModelId}/spec`): the update verb is **PUT**, not POST
 * (POST on that path is CREATE-only, matching `postDataModel` above; a POST
 * here 404s/405s). The original assumption in this function's previous
 * revision was wrong on the verb — corrected here. Body is
 * `{ schemaVersion, pages }`. Per the endpoint docs, only `pages` (+
 * `schemaVersion`) are read — other top-level fields are ignored — and this
 * is a full-representation replace, not a partial patch.
 *
 * Normalizes its input so callers can pass back whatever `getDataModelSpec`
 * handed them, unmodified shape and all: some DM-spec GET responses nest
 * `pages` under `spec.spec.pages` rather than a flat `spec.pages` (the same
 * uncertainty `mergeAdditionsIntoView` already hedges — see dm-merge.mjs).
 * Deliberately does NOT also tolerate a bare `spec.elements[]` shape — a live
 * spec always carries `.pages`, and mergeAdditionsIntoView (dm-merge.mjs) was
 * intentionally narrowed to the same two shapes so an in-place mutation there
 * is guaranteed to be visible to this PUT (a mismatch would silently drop it).
 */
export async function postDataModelSpec(dataModelId, spec) {
  const pages = spec.pages || spec.spec?.pages;
  const schemaVersion = spec.schemaVersion ?? spec.spec?.schemaVersion ?? 2;
  return req('PUT', `/v2/dataModels/${dataModelId}/spec`, { schemaVersion, pages });
}

/** Read the current workbook schemaVersion from any reference workbook (spec is YAML). */
export async function referenceWorkbookSchemaVersion() {
  const list = await req('GET', '/v2/workbooks?limit=1');
  const wbId = list.entries?.[0]?.workbookId || list.entries?.[0]?.id;
  if (!wbId) return 1;
  const yaml = await req('GET', `/v2/workbooks/${wbId}/spec`, null, true);
  // Live GETs nest schemaVersion under `document:` (code-rep wrapper, 2026-08).
  // Prefer the document-scoped value; fall back to any schemaVersion match.
  const underDoc = yaml.match(/document:\s*\n(?:[ \t]+.+\n)*?[ \t]+schemaVersion:\s*(\d+)/)
    || yaml.match(/document:[\s\S]*?schemaVersion:\s*(\d+)/);
  const m = underDoc || yaml.match(/schemaVersion:\s*(\d+)/);
  return m ? Number(m[1]) : 1;
}

/**
 * POST a workbook spec → { workbookId }.
 *
 * Always routes through `prepareWorkbookForPost` so callers can keep the
 * converter's convenient `pages[].elements` shape (and flat probe fixtures)
 * while the wire body matches the live code-rep contract: outer
 * `{name, folderId}` + `document: { schemaVersion, kind: "workbook",
 * pages (metadata), elements (flat), layout }`. A flat pre-2026-08 body
 * hard-400s. Data-model POSTs are unaffected — do not wrap those.
 */
export async function postWorkbook(workbook) {
  const body = prepareWorkbookForPost(workbook);
  const txt = await req('POST', '/v2/workbooks/spec', body, true);
  const m = txt.match(/workbookId:\s*"?([0-9a-f-]+)/) || txt.match(/"workbookId"\s*:\s*"([0-9a-f-]+)"/);
  return m ? m[1] : null;
}

/** DELETE any Sigma file (data model or workbook) by id. */
export async function deleteFile(id) { return req('DELETE', `/v2/files/${id}`, null, true); }

export const SIGMA_BASE = BASE;
