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

const BASE = (process.env.BO_BASE_URL || '').replace(/\/$/, '');
let TOKEN = process.env.BO_LOGON_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.BO_REQUEST_TIMEOUT_MS || 30000);

function need(v, name) { if (!v) throw new Error(`Missing ${name} — set it in .bo_env`); return v; }

function headers(extra = {}) {
  const h = { 'Accept': 'application/json', 'Content-Type': 'application/json', ...extra };
  if (TOKEN) h['X-SAP-LogonToken'] = TOKEN;
  return h;
}

/** POST /logon/long → logon token (also cached on this module). */
export async function logon() {
  need(BASE, 'BO_BASE_URL');
  if (TOKEN) return TOKEN;
  const body = {
    userName: need(process.env.BO_USER, 'BO_USER'),
    password: need(process.env.BO_PASSWORD, 'BO_PASSWORD'),
    auth: process.env.BO_AUTH || 'secEnterprise',
  };
  const res = await fetch(`${BASE}/logon/long`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`logon failed: HTTP ${res.status} ${await res.text()}`);
  // Token comes back in the X-SAP-LogonToken header and/or the JSON body.
  TOKEN = res.headers.get('x-sap-logontoken') || (await res.clone().json().catch(() => ({}))).logonToken || '';
  if (!TOKEN) throw new Error('logon succeeded but no logon token returned');
  return TOKEN;
}

function requestUrl(path) {
  if (/^https?:\/\//i.test(path)) {
    const requested = new URL(path);
    const configured = new URL(need(BASE, 'BO_BASE_URL'));
    if (requested.origin !== configured.origin) {
      throw new Error(`Refusing RWS pagination URL on a different origin: ${requested.origin}`);
    }
    return requested.toString();
  }
  return `${BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

function retryDelay(res, attempt) {
  const retryAfter = Number(res.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1000, 30000)
    : Math.min(500 * (2 ** attempt), 5000);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function getJson(path, retryAuth = true, attempt = 0) {
  const res = await fetch(requestUrl(path), {
    headers: headers(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 && retryAuth && !process.env.BO_LOGON_TOKEN) {
    TOKEN = '';
    await logon();
    return getJson(path, false, attempt);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await sleep(retryDelay(res, attempt));
    return getJson(path, retryAuth, attempt + 1);
  }
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
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

async function getCollection(path, plural, singular) {
  const result = await collectPaginated(path, getJson, payload => collectionItems(payload, plural, singular));
  if (!result.complete) {
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

export async function listUniversesDetailed() {
  return getCollection('/sl/v1/universes', 'universes', 'universe');
}

export async function getUniverse(id) {
  return getJson(`/sl/v1/universes/${id}`);
}

// ── Raylight (Web Intelligence documents) ────────────────────────────────────

export async function listWebiDocuments() {
  return (await listWebiDocumentsDetailed()).items;
}

export async function listWebiDocumentsDetailed() {
  return getCollection('/raylight/v1/documents', 'documents', 'document');
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
  const inputControls = await optionalJson(`/raylight/v1/documents/${id}/inputcontrols`, warnings);
  return {
    document: { name, reports, variables, filters, dataproviders },
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

/** Run a CMS query (SQL-like over InfoObjects). Returns the entries array. */
export async function cmsQuery(query) {
  const res = await fetch(`${BASE}/v1/cmsquery`, { method: 'POST', headers: headers(), body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`cmsquery → HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  return asArray(j.entries?.entry ?? j.entries ?? j.results);
}

export const BO_BASE = BASE;
