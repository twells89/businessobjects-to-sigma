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

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  canonicalizeLayout,
  document as workbookDocument,
  prepareWorkbookForPost,
  workbookElements,
  workbookPageElementIds,
} from './code_rep.mjs';

const NEUTRAL_ENV_KEYS = new Set([
  'SIGMA_BASE_URL',
  'SIGMA_API_TOKEN',
  'SIGMA_CLIENT_ID',
  'SIGMA_CLIENT_SECRET',
  'SIGMA_CONNECTION_ID',
  'SIGMA_FOLDER_ID',
  'SIGMA_DATABASE',
  'SIGMA_SCHEMA',
]);

/**
 * Parse setup.rb's simple `export KEY='value'` file without invoking a shell.
 * Command substitutions, variable references, and metacharacters remain
 * literal strings; only a fixed Sigma allowlist is accepted.
 */
export function parseSigmaEnv(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)\s*$/);
    if (!match || !NEUTRAL_ENV_KEYS.has(match[1])) continue;
    const raw = match[2].trim();
    let value = raw;
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      value = raw.slice(1, -1);
    } else if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
      value = raw.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
    }
    values[match[1]] = value;
  }
  return values;
}

/** Load only missing Sigma values from the agent-neutral credential file. */
export function loadSigmaEnvironment({
  env = process.env,
  path = join(homedir(), '.sigma-migration', 'env'),
} = {}) {
  if (!existsSync(path)) return env;
  const values = parseSigmaEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] == null || env[key] === '') env[key] = value;
  }
  return env;
}

export function validateSigmaBaseUrl(
  base,
  {
    allowInsecure = process.env.SIGMA_ALLOW_INSECURE_BASE_URL === '1',
    warn = console.warn,
  } = {},
) {
  if (allowInsecure) {
    warn(`WARNING: SIGMA_ALLOW_INSECURE_BASE_URL=1 — skipping SIGMA_BASE_URL validation (${base})`);
    return base;
  }
  let parsed;
  try { parsed = new URL(base); } catch {
    throw new Error(`FATAL: SIGMA_BASE_URL is invalid ('${base}') — refusing to send Sigma credentials.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') {
    throw new Error(`FATAL: SIGMA_BASE_URL must use https:// (got '${base}') — refusing to send Sigma credentials.`);
  }
  if (host !== 'sigmacomputing.com' && !host.endsWith('.sigmacomputing.com')) {
    throw new Error(
      `FATAL: SIGMA_BASE_URL host '${host}' is not a sigmacomputing.com host — refusing to send Sigma credentials. `
      + 'Set SIGMA_ALLOW_INSECURE_BASE_URL=1 to override (self-hosted/dev).',
    );
  }
  return base;
}

export function assertSigmaCredentials(id, secret) {
  if (!id || !secret) {
    throw new Error('Set SIGMA_API_TOKEN, or SIGMA_CLIENT_ID + SIGMA_CLIENT_SECRET');
  }
  if (id === secret) {
    throw new Error(
      'FATAL: SIGMA_CLIENT_SECRET is identical to SIGMA_CLIENT_ID. '
      + 'The secret is a separate value shown when the API key was created.',
    );
  }
}

loadSigmaEnvironment();
const BASE = (process.env.SIGMA_BASE_URL || 'https://aws-api.sigmacomputing.com').replace(/\/$/, '');
let _token = process.env.SIGMA_API_TOKEN || '';

export async function sigmaToken() {
  validateSigmaBaseUrl(BASE);
  if (_token) return _token;
  const id = process.env.SIGMA_CLIENT_ID, secret = process.env.SIGMA_CLIENT_SECRET;
  assertSigmaCredentials(id, secret);
  const credentials = Buffer.from(`${id}:${secret}`, 'utf8').toString('base64');
  const res = await fetch(`${BASE}/v2/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!res.ok) throw new Error(`Sigma auth failed: HTTP ${res.status} ${await res.text()}`);
  _token = (await res.json()).access_token;
  if (!_token) throw new Error('Sigma auth failed: response did not contain access_token');
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(_token)) {
    _token = '';
    throw new Error('Sigma auth failed: access_token contains unexpected characters');
  }
  return _token;
}

async function req(method, path, body, asText = false) {
  const tok = await sigmaToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      Accept: asText ? '*/*' : 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${txt.slice(0, 400)}`);
  if (asText) return txt;
  try { return JSON.parse(txt); } catch { return txt; }
}

// Shared by the report-specific lifecycle helper. Keep the low-level request
// in one place so auth/error handling stays identical across DMs, workbooks,
// and pixel-perfect reports.
export { req as sigmaRequest };

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

/** POST a workbook create envelope to the non-persistent verifier. */
export async function verifyWorkbook(workbook) {
  const body = prepareWorkbookForPost(workbook);
  return req('POST', '/v2/workbooks/spec/verify', body);
}

/** GET a workbook code representation as JSON. */
export async function getWorkbookSpec(workbookId) {
  return req('GET', `/v2/workbooks/${workbookId}/spec?format=json`);
}

export function workbookIdFromResult(result) {
  if (result && typeof result === 'object') return result.workbookId || result.id || null;
  const match = String(result || '').match(
    /(?:workbookId|id)\s*:\s*"?([0-9a-f]{8}-[0-9a-f-]{27,})"?/i,
  );
  return match?.[1] || null;
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
export async function postWorkbook(workbook, { verify = false } = {}) {
  const body = prepareWorkbookForPost(workbook);
  if (verify) {
    const verified = await req('POST', '/v2/workbooks/spec/verify', body);
    if (verified?.valid === false) {
      throw new Error(`Sigma workbook verify rejected the spec: ${JSON.stringify(verified).slice(0, 1000)}`);
    }
  }
  const txt = await req('POST', '/v2/workbooks/spec', body, true);
  try {
    return workbookIdFromResult(JSON.parse(txt));
  } catch {
    return workbookIdFromResult(txt);
  }
}

/**
 * Normalize the parts of a workbook document that must survive create/readback.
 * Server-only metadata is ignored, while create metadata, page order, formulas,
 * and known representational rewrites are preserved.
 */
export function normalizeWorkbookForComparison(spec) {
  const body = prepareWorkbookForPost(spec);
  const doc = body.document;
  return {
    name: body.name ?? null,
    folderId: body.folderId ?? null,
    description: body.description ?? null,
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    pages: [...(Array.isArray(doc.pages) ? doc.pages : [])],
    elements: sortById(doc.elements).map(normalizeWorkbookElement),
    overlays: sortById(doc.overlays),
    panels: sortById(doc.panels),
    settings: doc.settings || {},
    agents: sortById(doc.agents),
    layout: canonicalizeLayout(doc.layout).replace(/\s+/g, ' ').trim(),
  };
}

export async function assertWorkbookReadback(
  workbookId,
  submitted,
  normalize = normalizeWorkbookForComparison,
) {
  const readback = await getWorkbookSpec(workbookId);
  const expected = normalize(submitted);
  const actual = normalize(readback);
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error('Workbook GET readback differs from the submitted normalized document');
  }
  return readback;
}

/**
 * Compare migration intent while allowing Sigma to assign new page, element,
 * and column IDs. Unlike normalizeWorkbookForComparison this is a separate,
 * explicitly weaker verdict used only by migration lifecycles that must map
 * server IDs after creation.
 */
export function assessWorkbookSemanticReadback(submitted, readback) {
  const expected = prepareWorkbookForPost(submitted);
  const actual = prepareWorkbookForPost(readback);
  const errors = [];
  const warnings = [];
  for (const key of ['name', 'folderId', 'description']) {
    const left = key === 'description' ? (expected[key] ?? '') : (expected[key] ?? null);
    const right = key === 'description' ? (actual[key] ?? '') : (actual[key] ?? null);
    if (left !== right) errors.push(`workbook ${key} changed (${JSON.stringify(left)} → ${JSON.stringify(right)})`);
  }

  const expectedPages = expected.document.pages || [];
  const actualPages = actual.document.pages || [];
  const pageMappings = [];
  const actualByName = new Map();
  for (const page of actualPages) {
    const name = String(page?.name ?? '');
    if (!actualByName.has(name)) actualByName.set(name, []);
    actualByName.get(name).push(page);
  }
  const nameUse = new Map();
  for (const [index, page] of expectedPages.entries()) {
    const name = String(page?.name ?? '');
    const occurrence = nameUse.get(name) || 0;
    nameUse.set(name, occurrence + 1);
    const mapped = actualByName.get(name)?.[occurrence];
    if (!mapped) {
      errors.push(`workbook page ${JSON.stringify(name)} occurrence ${occurrence + 1} was dropped`);
      continue;
    }
    pageMappings.push({
      name,
      occurrence,
      submittedPageId: page.id,
      readbackPageId: mapped.id,
      submittedIndex: index,
      readbackIndex: actualPages.indexOf(mapped),
    });
  }
  if (expectedPages.length !== actualPages.length) {
    errors.push(`workbook page count changed (${expectedPages.length} → ${actualPages.length})`);
  }
  const expectedNames = expectedPages.map((page) => page?.name ?? '');
  const actualNames = actualPages.map((page) => page?.name ?? '');
  if (!isDeepStrictEqual(expectedNames, actualNames)) {
    errors.push('workbook page order or names changed');
  }

  const expectedElements = elementsByPage(expected);
  const actualElements = elementsByPage(actual);
  const pageCoverage = [];
  for (const mapping of pageMappings) {
    const left = expectedElements.get(mapping.submittedPageId) || [];
    const right = actualElements.get(mapping.readbackPageId) || [];
    const comparison = compareSemanticElements(left, right);
    pageCoverage.push({
      pageName: mapping.name,
      submittedPageId: mapping.submittedPageId,
      readbackPageId: mapping.readbackPageId,
      submittedElements: left.length,
      readbackElements: right.length,
      ...comparison,
    });
    errors.push(...comparison.errors.map((error) => `page ${JSON.stringify(mapping.name)}: ${error}`));
  }
  const expectedPlaced = [...expectedElements.values()].reduce((sum, values) => sum + values.length, 0);
  const actualPlaced = [...actualElements.values()].reduce((sum, values) => sum + values.length, 0);
  if (expectedPlaced !== (expected.document.elements || []).length) {
    errors.push('submitted workbook contains unplaced elements');
  }
  if (actualPlaced !== (actual.document.elements || []).length) {
    errors.push('readback workbook contains unplaced elements');
  }
  const idsChanged = pageMappings.some((mapping) =>
    mapping.submittedPageId !== mapping.readbackPageId);
  if (idsChanged) warnings.push('Sigma assigned different page IDs; mapped pages by ordered name occurrence.');
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    idsChanged,
    pageMappings,
    pageCoverage,
  };
}

export function resolveWorkbookReadbackPageIds(
  submitted,
  readback,
  requestedSubmittedPageIds = [],
) {
  const verdict = assessWorkbookSemanticReadback(submitted, readback);
  if (!verdict.valid) {
    throw new Error(`Workbook semantic readback failed: ${verdict.errors.join('; ')}`);
  }
  const bySubmittedId = new Map(
    verdict.pageMappings.map((mapping) => [mapping.submittedPageId, mapping.readbackPageId]),
  );
  const selected = requestedSubmittedPageIds.length
    ? requestedSubmittedPageIds
    : verdict.pageMappings.map((mapping) => mapping.submittedPageId);
  return {
    pageIds: selected.map((pageId) => {
      const mapped = bySubmittedId.get(pageId);
      if (!mapped) throw new Error(`Requested submitted workbook page ${pageId} was not found in readback`);
      return mapped;
    }),
    verdict,
  };
}

/** DELETE any Sigma file (data model or workbook) by id. */
export async function deleteFile(id) { return req('DELETE', `/v2/files/${id}`, null, true); }

/** Refresh warehouse metadata for a connection path (empty path = connection root). */
export async function syncConnectionPath(connectionId, path = []) {
  return req('POST', `/v2/connections/${connectionId}/sync`, { path });
}

function sortById(value) {
  return [...(Array.isArray(value) ? value : [])]
    .sort((a, b) => String(a?.id || a?.elementId || '').localeCompare(
      String(b?.id || b?.elementId || ''),
    ));
}

function normalizeWorkbookElement(value) {
  const element = { ...value };
  if (Array.isArray(element.columns)) {
    element.columns = sortById(element.columns).map((column) => ({ ...column }));
  }
  const hiddenIds = new Set(
    (element.columns || []).filter((column) => column.hidden).map((column) => column.id),
  );
  if (Array.isArray(element.order)) {
    element.order = element.order.filter((id) => !hiddenIds.has(id));
  }
  if (Array.isArray(element.sort)) {
    element.sort = element.sort.map((item) => {
      if (item.nulls !== 'connection-default') return item;
      const { nulls: _removed, ...rest } = item;
      return rest;
    });
  }
  return element;
}

function elementsByPage(spec) {
  const doc = workbookDocument(spec);
  const elements = new Map(workbookElements(doc).map((element) => [element.id, element]));
  const membership = workbookPageElementIds(doc);
  const result = new Map();
  for (const page of doc.pages || []) {
    result.set(
      page.id,
      (membership[page.id] || []).map((id) => elements.get(id)).filter(Boolean),
    );
  }
  return result;
}

function compareSemanticElements(expected, actual) {
  const errors = [];
  const actualByKey = groupBySemanticKey(actual);
  const used = new Map();
  for (const element of expected) {
    const key = semanticElementKey(element);
    const occurrence = used.get(key) || 0;
    used.set(key, occurrence + 1);
    const candidate = actualByKey.get(key)?.[occurrence];
    if (!candidate) {
      errors.push(`element ${key} occurrence ${occurrence + 1} was dropped`);
      continue;
    }
    if (!isDeepStrictEqual(semanticElement(element), semanticElement(candidate))) {
      errors.push(`element ${key} occurrence ${occurrence + 1} changed materially`);
    }
  }
  if (expected.length !== actual.length) {
    errors.push(`element count changed (${expected.length} → ${actual.length})`);
  }
  return { valid: errors.length === 0, errors };
}

function groupBySemanticKey(elements) {
  const result = new Map();
  for (const element of elements) {
    const key = semanticElementKey(element);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(element);
  }
  return result;
}

function semanticElementKey(element) {
  return `${element?.kind || ''}:${element?.name || element?.body || ''}`;
}

function semanticElement(element) {
  const columnIds = new Map();
  const nameCounts = new Map();
  for (const column of element?.columns || []) {
    const name = String(column?.name ?? '');
    const occurrence = nameCounts.get(name) || 0;
    nameCounts.set(name, occurrence + 1);
    columnIds.set(column.id, `${name}#${occurrence + 1}`);
  }
  const visit = (value, key = '') => {
    if (Array.isArray(value)) {
      if (['columnIds', 'order', 'groupBy', 'calculations', 'values'].includes(key)) {
        return value.map((item) => columnIds.get(item) || item);
      }
      return value.map((item) => visit(item, key));
    }
    if (value == null || typeof value !== 'object') {
      if (key === 'columnId') return columnIds.get(value) || value;
      return value;
    }
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'id' && (value === element || key === 'columns' || key === 'groupings')) continue;
      out[childKey] = visit(child, childKey);
    }
    return out;
  };
  return visit(element);
}

export const SIGMA_BASE = BASE;
