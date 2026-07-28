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

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// RWS wraps collections as { <plural>: { <singular>: [...] } } and sometimes a
// bare array. asArray() normalizes both, plus the single-object case.
function asArray(node) {
  if (!node) return [];
  if (Array.isArray(node)) return node;
  return [node];
}

// ── Semantic layer (universes) ───────────────────────────────────────────────

export async function listUniverses() {
  const j = await getJson('/sl/v1/universes');
  return asArray(j.universes?.universe ?? j.universes ?? j.universe);
}

export async function getUniverse(id) {
  return getJson(`/sl/v1/universes/${id}`);
}

// ── Raylight (Web Intelligence documents) ────────────────────────────────────

export async function listWebiDocuments() {
  const j = await getJson('/raylight/v1/documents');
  return asArray(j.documents?.document ?? j.documents ?? j.document);
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
export async function getWebiVariables(id) {
  let list = [];
  try { list = asArray((await getJson(`/raylight/v1/documents/${id}/variables`)).variables?.variable); } catch { return []; }
  const out = [];
  for (const v of list) {
    let def = v.definition || v.formula;
    if (!def && (v.id ?? v.variableId) != null) {
      try { const one = await getJson(`/raylight/v1/documents/${id}/variables/${v.id ?? v.variableId}`); def = one.variable?.definition || one.definition; } catch { /* tolerate */ }
    }
    out.push({ name: v.name, qualification: (v.qualification || '').toLowerCase() || undefined, dataType: v.dataType, formula: def || '' });
  }
  return out;
}

/**
 * Assemble a single Webi document into the shape the Webi converter ingests:
 * { document: { name, reports: [{ name, ...raw report element tree }], filters,
 *   variables } } plus the dataproviders (so the caller can map the doc to its
 * universe → DM). `elements` is passed through untouched (not re-shaped) so
 * each report element's own expression text — RWS calls this `dataExpression`
 * on a raw element, `formula`/`expression`/`definition` on a flattened one —
 * survives into normalizeWebiDocument()/normalizeBlock() unmodified; that's
 * what lets an in-place block-column formula (as opposed to a named variable)
 * get picked up and translated downstream.
 */
export async function getWebiDocument(id) {
  const doc = await getJson(`/raylight/v1/documents/${id}`);
  const name = doc.document?.name || doc.name || `Document ${id}`;
  const reportsList = asArray((await getJson(`/raylight/v1/documents/${id}/reports`)).reports?.report);
  const reports = [];
  for (const r of reportsList) {
    const rid = r.id ?? r.reportId;
    let elements = null;
    try { elements = (await getJson(`/raylight/v1/documents/${id}/reports/${rid}/elements`)); } catch { /* tolerate */ }
    reports.push({ name: r.name || `Report ${rid}`, elements: elements?.reportElements ?? elements?.elements ?? elements });
  }
  let dataproviders = [];
  try { dataproviders = asArray((await getJson(`/raylight/v1/documents/${id}/dataproviders`)).dataproviders?.dataprovider); } catch { /* optional */ }
  const variables = await getWebiVariables(id);
  return { document: { name, reports, variables }, dataproviders };
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
