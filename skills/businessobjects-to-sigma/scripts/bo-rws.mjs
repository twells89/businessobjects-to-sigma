/**
 * SAP BusinessObjects BI RESTful Web Service (RWS) client.
 *
 * Talks to the customer's on-prem BO 4.x server (default base
 * https://<host>:6405/biprws). One logon token unlocks both layers:
 *   - Semantic Layer  (/sl/v1/universes)        → universes  → data models
 *   - Raylight        (/raylight/v1/documents)  → Webi docs  → workbooks
 *   - CMS query       (/v1/cmsquery)            → full repository inventory
 *
 * ⚠ STATUS: coded to the documented RWS contract; NOT yet exercised against a
 * live BO server. Response shapes vary slightly across BI 4.1/4.2/4.3 SPs —
 * the parsers below are defensive but expect to adjust on first real run.
 *
 * Env (see .bo_env.example):
 *   BO_BASE_URL   e.g. https://bo.example.com:6405/biprws
 *   BO_USER, BO_PASSWORD
 *   BO_AUTH       secEnterprise | secLDAP | secWinAD | secSAPR3  (default secEnterprise)
 */

let TOKEN = process.env.BO_LOGON_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.BO_REQUEST_TIMEOUT_MS || 30000);

export function boBaseUrl() {
  return (process.env.BO_BASE_URL || '').replace(/\/$/, '');
}

/** Import-time snapshot. Prefer boBaseUrl() when the environment can change. */
export const BO_BASE = boBaseUrl();

function need(v, name) { if (!v) throw new Error(`Missing ${name} — set it in .bo_env`); return v; }

function headers(extra = {}) {
  const h = { 'Accept': 'application/json', 'Content-Type': 'application/json', ...extra };
  if (TOKEN) h['X-SAP-LogonToken'] = TOKEN;
  return h;
}

export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(X-SAP-LogonToken["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1<REDACTED>')
    .replace(/((?:password|passwd|secret|credential|token|authorization|logonToken)["']?\s*[:=]\s*["']?)[^"'\s,}&]+/gi, '$1<REDACTED>');
}

/** Deep-redact credential-shaped keys before anything is written to disk. */
export function redact(value, key = '') {
  if (/password|passwd|secret|credential|token|authorization/i.test(key)) return '<REDACTED>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

function truncateText(text, max = 300) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function resetSessionForTests(token = '') {
  TOKEN = token;
}

function requestUrl(path) {
  const base = boBaseUrl();
  if (/^https?:\/\//i.test(path)) {
    const requested = new URL(path);
    const configured = new URL(need(base, 'BO_BASE_URL'));
    if (requested.origin !== configured.origin) {
      throw new Error(`Refusing RWS pagination URL on a different origin: ${requested.origin}`);
    }
    return requested.toString();
  }
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function retryDelay(res, attempt) {
  const retryAfter = Number(res.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, 30000)
    : Math.min(500 * (2 ** attempt), 5000);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function rawFetch(method, path, { body, attempt = 0 } = {}) {
  const res = await fetch(requestUrl(path), {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(retryDelay(res, attempt));
    return rawFetch(method, path, { body, attempt: attempt + 1 });
  }
  return res;
}

/** POST /logon/long → logon token (also cached on this module). */
export async function logon() {
  need(boBaseUrl(), 'BO_BASE_URL');
  if (TOKEN) return TOKEN;
  const res = await rawFetch('POST', '/logon/long', {
    body: {
      userName: need(process.env.BO_USER, 'BO_USER'),
      password: need(process.env.BO_PASSWORD, 'BO_PASSWORD'),
      auth: process.env.BO_AUTH || 'secEnterprise',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redactSecrets(`logon failed: HTTP ${res.status} ${truncateText(text)}`));
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
  TOKEN = res.headers.get('x-sap-logontoken') || json.logonToken || '';
  if (!TOKEN) throw new Error('logon succeeded but no logon token returned');
  return TOKEN;
}

async function responseJson(res, method, path) {
  const text = await res.text();
  if (!res.ok) throw new Error(redactSecrets(`${method} ${path} → HTTP ${res.status} ${truncateText(text)}`));
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new Error(`${method} ${path} returned non-JSON`); }
}

/**
 * GET/POST JSON with the same timeout, 429/5xx retry, 401 re-logon, and
 * same-origin checks as the typed RWS reads.
 */
export async function requestJson(method, path, { body, retryAuth = true } = {}) {
  const res = await rawFetch(method, path, { body });
  if (res.status === 401 && retryAuth && !process.env.BO_LOGON_TOKEN) {
    TOKEN = '';
    await logon();
    return requestJson(method, path, { body, retryAuth: false });
  }
  return responseJson(res, method, path);
}

async function getJson(path) {
  return requestJson('GET', path);
}

// RWS wraps collections as { <plural>: { <singular>: [...] } } and sometimes a
// bare array. asArray() normalizes both, plus the single-object case.
export function asArray(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  return [node];
}

/** Normalize the common RWS collection variants:
 *   { reports: { report: [...] } }, { reports: [...] }, { report: [...] }, [...]. */
export function collectionItems(payload, plural, singular) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const pluralNode = payload[plural];
  if (Array.isArray(pluralNode)) return pluralNode;
  if (pluralNode && typeof pluralNode === 'object' && singular in pluralNode) return asArray(pluralNode[singular]);
  if (pluralNode && typeof pluralNode === 'object' && Array.isArray(pluralNode.items)) return pluralNode.items;
  if (singular in payload) return asArray(payload[singular]);
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

export function reportElementTree(payload) {
  if (!payload) return null;
  const reportElements = payload.reportElements;
  if (Array.isArray(reportElements)) return reportElements;
  if (reportElements && typeof reportElements === 'object') {
    if (reportElements.reportElement != null) return asArray(reportElements.reportElement);
    if (reportElements.element != null) return asArray(reportElements.element);
  }
  const elements = payload.elements;
  if (Array.isArray(elements)) return elements;
  if (elements && typeof elements === 'object' && elements.element != null) return asArray(elements.element);
  if (payload.element != null) return asArray(payload.element);
  return reportElements ?? elements ?? payload;
}

function linkHref(link) {
  if (!link) return null;
  if (typeof link === 'string') return link;
  return link.href || link.url || link.uri || null;
}

export function nextPagePath(payload) {
  const scopes = [payload, ...Object.values(payload || {}).filter(value => value && typeof value === 'object' && !Array.isArray(value))];
  for (const scope of scopes) {
    const direct = scope?.next || scope?.pagination?.next || scope?.pageInfo?.next;
    if (linkHref(direct)) return linkHref(direct);
    const links = asArray(scope?.links?.link ?? scope?.links ?? scope?.pagination?.links);
    const next = links.find(link => /next/i.test(link?.rel || link?.name || ''));
    if (linkHref(next)) return linkHref(next);
  }
  return null;
}

function expectedTotal(payload) {
  const scopes = [payload, ...Object.values(payload || {}).filter(value => value && typeof value === 'object' && !Array.isArray(value))];
  for (const scope of scopes) {
    const value = scope?.total
      ?? scope?.totalCount
      ?? scope?.pagination?.total
      ?? scope?.pageInfo?.totalCount;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/** Follow server-provided next links and verify any advertised total. */
export async function collectPaginated(firstPath, fetchPage, extractItems) {
  const items = [];
  const payloads = [];
  const seen = new Set();
  let path = firstPath;
  let pages = 0;
  let advertisedTotal = null;
  while (path) {
    if (seen.has(path)) throw new Error(`Pagination loop detected at ${path}`);
    if (pages >= 10000) throw new Error('Pagination exceeded 10,000 pages');
    seen.add(path);
    const payload = await fetchPage(path);
    payloads.push(payload);
    pages++;
    items.push(...extractItems(payload));
    advertisedTotal ??= expectedTotal(payload);
    path = nextPagePath(payload);
  }
  const complete = advertisedTotal == null || items.length >= advertisedTotal;
  return { items, payloads, pages, advertisedTotal, complete };
}

async function getCollection(path, plural, singular, { strict = true } = {}) {
  const result = await collectPaginated(path, getJson, payload => collectionItems(payload, plural, singular));
  if (strict && !result.complete) {
    throw new Error(`${path} returned ${result.items.length} of ${result.advertisedTotal} advertised entries without a next-page link`);
  }
  return result;
}

async function optionalJson(path, warnings) {
  try { return await getJson(path); }
  catch (error) { warnings.push(`${path}: ${error.message}`); return null; }
}

async function optionalCollection(path, plural, singular, warnings) {
  try { return await getCollection(path, plural, singular); }
  catch (error) {
    warnings.push(`${path}: ${error.message}`);
    return { items: [], payloads: [], pages: 0, advertisedTotal: null, complete: false };
  }
}

// ── Semantic layer (universes) ───────────────────────────────────────────────

export async function listUniverses() {
  return (await listUniversesDetailed()).items;
}

export async function listUniversesDetailed(options = {}) {
  return getCollection('/sl/v1/universes', 'universes', 'universe', options);
}

export async function getUniverse(id) {
  return getJson(`/sl/v1/universes/${id}`);
}

// ── Raylight (Web Intelligence documents) ────────────────────────────────────

export async function listWebiDocuments() {
  return (await listWebiDocumentsDetailed()).items;
}

export async function listWebiDocumentsDetailed(options = {}) {
  return getCollection('/raylight/v1/documents', 'documents', 'document', options);
}

/**
 * GET /raylight/v1/documents/{id}/variables → the document's named report
 * variables (Webi's report-scoped calculated fields), in the shape
 * normalizeWebiDocument() reads via `document.variables`. Some BO 4.x SPs
 * return the formula inline on the list entry (`definition`/`formula`);
 * others require a per-variable GET. Both are tolerated; a variable whose
 * formula can't be recovered still comes back (with formula: '') rather than
 * dropping it, so the caller/warnings surface it instead of silently losing it.
 */
async function getWebiVariablesCapture(id, warnings = []) {
  const collection = await optionalCollection(`/raylight/v1/documents/${id}/variables`, 'variables', 'variable', warnings);
  const list = collection.items;
  const out = [];
  const details = [];
  for (const v of list) {
    let def = v.definition || v.formula;
    let detail = null;
    if (!def && (v.id ?? v.variableId) != null) {
      detail = await optionalJson(`/raylight/v1/documents/${id}/variables/${v.id ?? v.variableId}`, warnings);
      def = detail?.variable?.definition || detail?.definition;
    }
    out.push({ name: v.name, qualification: (v.qualification || '').toLowerCase() || undefined, dataType: v.dataType, formula: def || '' });
    details.push({ metadata: v, detail });
  }
  return { variables: out, snapshot: { pages: collection.payloads, details } };
}

export async function getWebiVariables(id) {
  return (await getWebiVariablesCapture(id)).variables;
}

/**
 * Assemble a single Webi document into the shape the Webi converter ingests:
 * { document: { name, reports: [{ name, ...raw report element tree }], filters,
 *   variables } } plus the dataproviders (so the caller can map the doc to its
 * universe → DM). `elements` is passed through untouched (not re-shaped) so
 * each report element's own in-place expression text — RWS calls this
 * `dataExpression` on a raw element — survives unmodified into
 * normalizeWebiDocument(). This document arrives as the RAW Raylight element
 * tree (reports carry `.elements`, not a pre-flattened `.blocks`), so it is
 * `walkRaylight()` — not `normalizeBlock()` (that one's for the friendly,
 * already-flattened shape a discovery script might emit) — that reads this
 * tree and captures each expression's formula into the block's
 * `formulaByName`, alongside its name. Both walkRaylight() and normalizeBlock()
 * feed the same downstream inline-formula translation path, so an in-place
 * block-column formula (as opposed to a named variable) is picked up and
 * translated regardless of which of the two shapes it started as.
 */
export async function getWebiDocument(id) {
  const warnings = [];
  const doc = await getJson(`/raylight/v1/documents/${id}`);
  const name = doc.document?.name || doc.name || `Document ${id}`;
  const reportsResult = await getCollection(`/raylight/v1/documents/${id}/reports`, 'reports', 'report');
  const reportsList = reportsResult.items;
  const reports = [];
  const reportSnapshots = [];
  for (const r of reportsList) {
    const rid = r.id ?? r.reportId;
    if (rid == null) {
      warnings.push(`Report "${r.name || '(unnamed)'}" has no id; elements were not fetched.`);
      reports.push({ name: r.name || 'Report', elements: null, filters: [] });
      continue;
    }
    const elements = await optionalJson(`/raylight/v1/documents/${id}/reports/${rid}/elements`, warnings);
    const reportFiltersResult = await optionalCollection(`/raylight/v1/documents/${id}/reports/${rid}/filters`, 'filters', 'filter', warnings);
    const filters = reportFiltersResult.items;
    reports.push({
      id: rid,
      name: r.name || `Report ${rid}`,
      elements: reportElementTree(elements),
      filters,
    });
    reportSnapshots.push({ metadata: r, elements, filters: reportFiltersResult.payloads });
  }
  const documentFiltersResult = await optionalCollection(`/raylight/v1/documents/${id}/filters`, 'filters', 'filter', warnings);
  const filters = documentFiltersResult.items;
  const dataprovidersResult = await optionalCollection(`/raylight/v1/documents/${id}/dataproviders`, 'dataproviders', 'dataprovider', warnings);
  const providerList = dataprovidersResult.items;
  const dataproviders = [];
  const providerSnapshots = [];
  for (const provider of providerList) {
    const providerId = provider.id ?? provider.dataProviderId;
    const detail = providerId == null
      ? null
      : await optionalJson(`/raylight/v1/documents/${id}/dataproviders/${providerId}`, warnings);
    const normalized = detail?.dataprovider ?? detail?.dataProvider ?? detail ?? provider;
    dataproviders.push({ ...provider, ...(normalized && typeof normalized === 'object' ? normalized : {}) });
    providerSnapshots.push({ metadata: provider, detail });
  }
  const variableResult = await getWebiVariablesCapture(id, warnings);
  const variables = variableResult.variables;
  const inputControlPayload = await optionalJson(`/raylight/v1/documents/${id}/inputcontrols`, warnings);
  const inputControls = collectionItems(inputControlPayload, 'inputControls', 'inputControl');
  return {
    document: { name, reports, variables, filters, dataproviders, inputControls },
    dataproviders,
    warnings,
    snapshot: {
      document: doc,
      reports: reportSnapshots,
      variables: variableResult.snapshot,
      filters: documentFiltersResult.payloads,
      dataproviders: { pages: dataprovidersResult.payloads, details: providerSnapshots },
      inputControls,
      pagination: { reports: reportsResult.pages },
    },
  };
}

// ── CMS query (full-repository inventory) ────────────────────────────────────

function cmsEntries(payload) {
  return asArray(payload?.entries?.entry ?? payload?.entries ?? payload?.results);
}

/** Run a CMS query. POST uses the same retry, re-logon, timeout, and origin checks as GET. */
export async function cmsQuery(query) {
  const collected = [];
  const seen = new Set();
  let payload = await requestJson('POST', '/v1/cmsquery', { body: { query } });
  let pages = 0;
  while (payload) {
    pages++;
    if (pages > 10000) throw new Error('Pagination exceeded 10,000 pages');
    collected.push(...cmsEntries(payload));
    const next = nextPagePath(payload);
    if (!next) break;
    if (seen.has(next)) throw new Error(`Pagination loop detected at ${next}`);
    seen.add(next);
    payload = await requestJson('GET', next);
  }
  return collected;
}

/**
 * Crystal Reports are not exposed by Raylight. Inventory definitions through
 * CMS query and explicitly exclude scheduled instances (`SI_INSTANCE = 0`).
 * Opening/extracting the report definition itself requires the BI Platform
 * Java SDK/RAS path in scripts/extract-crystal-cms.groovy.
 */
export async function listCrystalReports() {
  const rows = await cmsQuery(
    "SELECT SI_ID, SI_CUID, SI_NAME, SI_KIND, SI_PARENTID, SI_INSTANCE " +
    "FROM CI_INFOOBJECTS WHERE SI_KIND = 'CrystalReport' AND SI_INSTANCE = 0",
  );
  return rows.map(row => ({
    id: row.SI_ID ?? row.si_id ?? row.id,
    cuid: row.SI_CUID ?? row.si_cuid ?? row.cuid,
    name: row.SI_NAME ?? row.si_name ?? row.name,
    kind: row.SI_KIND ?? row.si_kind ?? row.kind ?? 'CrystalReport',
    parentId: row.SI_PARENTID ?? row.si_parentid ?? row.parentId,
    instance: row.SI_INSTANCE ?? row.si_instance ?? row.instance ?? 0,
  }));
}
