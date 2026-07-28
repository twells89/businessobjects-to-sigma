#!/usr/bin/env node
/**
 * Task 8 — Live end-to-end tie-out for the Webi formula translator (the commit gate).
 *
 * Runs the FULL pipeline against the real Sigma API on the CSA.TJ connection:
 *   1. fixtures/efashion_universe.xml  → Sigma data model → POST /v2/dataModels/spec
 *   2. fixtures/e2e_webi_variables.json (4 Webi variables, all translator tiers)
 *      → { workbook, dataModelAdditions } via convertWebiToWorkbook
 *   3. dataModelAdditions merged into the posted DM's View element and PUT back
 *   4. workbook POSTed, bound to the (now-patched) data model
 *   5. describe (element/column error scan) + query (real exported values)
 *
 * Then asserts real tie-out (never faked green — see checks below) and cleans
 * up every object it created.
 *
 * Run:  set -a; . ~/.sigma-migration/env; set +a; node scripts/e2e-webi-formula.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  postDataModel, getDataModelSpec, postDataModelSpec,
  postWorkbook, deleteFile, referenceWorkbookSchemaVersion,
  sigmaToken, SIGMA_BASE,
} from './sigma.mjs';
import { convertBobjToSigma } from '../converters/bobj.mjs';
import { convertWebiToWorkbook } from '../converters/webi.mjs';
import { mergeAdditionsIntoView } from './dm-merge.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Live resources for this run (verified present — see task-8-brief.md).
const CONNECTION_ID = 'cb2f5180-641f-47bd-8efa-da9d590d855a'; // CSA.TJ warehouse connection
const FOLDER_ID = '9ca9bf60-6a33-43dd-967d-1ba6352c54bb';     // test folder

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; return cond; };
const created = { dataModelId: null, workbookIds: [] };

// ── Minimal REST helpers this harness needs beyond scripts/sigma.mjs ────────

async function sigmaGet(path) {
  const tok = await sigmaToken();
  let res, txt;
  try {
    res = await fetch(`${SIGMA_BASE}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
    txt = await res.text();
  } catch (e) {
    // Pre/mid-response failure (connection refused/reset, DNS, etc.) — no
    // HTTP status to report. Left as `err.status === undefined` so callers
    // can tell this apart from a real HTTP error response.
    throw new Error(`GET ${path} → network error: ${e.message}`);
  }
  if (!res.ok) {
    const err = new Error(`GET ${path} → HTTP ${res.status} ${txt.slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  try { return JSON.parse(txt); } catch { return txt; }
}

/** List every element across every page of a workbook (name, elementId, error?). */
async function listPageElements(workbookId) {
  const pages = await sigmaGet(`/v2/workbooks/${workbookId}/pages`);
  const out = [];
  for (const pg of pages.entries || []) {
    const pageId = pg.pageId || pg.id;
    const els = await sigmaGet(`/v2/workbooks/${workbookId}/pages/${pageId}/elements`);
    for (const e of (els.entries || [])) out.push({ ...e, pageId });
  }
  return out;
}

/**
 * GET one element's /query, retrying a transient 5xx/network failure within a
 * bounded budget — the same attempt budget + delay (maxWaitMs/pollMs) the
 * export/download path below already uses for the same class of infra blip.
 * Distinguishes the one legitimate non-retry case from everything else:
 *   - a genuine 4xx (not 429) means this element isn't queryable at all (e.g.
 *     a control) — skip it, no retry, not a problem.
 *   - a 429, a 5xx, or a network-level error (no HTTP status at all) is
 *     transient — retry. If it still hasn't succeeded once the budget is
 *     exhausted, that's a real failure, returned so the caller records it as
 *     a problem instead of silently swallowing it.
 */
async function queryElementWithRetry(workbookId, elementId, { maxWaitMs = 90000, pollMs = 1500 } = {}) {
  const start = Date.now();
  let lastErr;
  do {
    try {
      return { data: await sigmaGet(`/v2/workbooks/${workbookId}/elements/${elementId}/query`) };
    } catch (e) {
      lastErr = e;
      if (e.status !== undefined && e.status >= 400 && e.status < 500 && e.status !== 429) {
        return { skip: true }; // genuine 4xx on a non-queryable element (e.g. a control)
      }
      await new Promise(r => setTimeout(r, pollMs));
    }
  } while (Date.now() - start < maxWaitMs);
  return { error: lastErr };
}

/**
 * "describe": list every element, then pull each element's compiled SQL
 * (GET /v2/workbooks/{id}/elements/{eid}/query) and scan it for Sigma's two
 * documented unresolved-formula error markers — POST /v2/workbooks/spec is
 * generous and accepts specs whose formulas don't actually resolve; the
 * failure only surfaces as a string literal embedded in the compiled SQL at
 * query time. A column alias containing "--metric-" is a known-benign
 * internal SELECT-* artifact and is excluded. A transient 5xx/network error
 * on the per-element /query probe is retried (see queryElementWithRetry); if
 * it still fails after exhausting the budget, that's recorded as a problem
 * (the gate fails) rather than swallowed — only a genuine 4xx on a
 * non-queryable element (e.g. a control) is a legitimate skip.
 */
async function describeWorkbook(workbookId) {
  const elements = await listPageElements(workbookId);
  const problems = [];
  for (const el of elements) {
    if (el.error) problems.push(`${el.name} (${el.elementId}): element error: ${el.error}`);
    const result = await queryElementWithRetry(workbookId, el.elementId);
    if (result.skip) continue;
    if (result.error) {
      problems.push(`${el.name} (${el.elementId}): /query never succeeded after retries: ${result.error.message}`);
      continue;
    }
    const q = result.data;
    if (q.error) problems.push(`${el.name}: query error: ${q.error}`);
    const sql = q.sql || '';
    const markers = sql.match(/Unknown column "[^"]+"|Circular column reference to \[[^\]]+\]/g) || [];
    const real = markers.filter(m => !/--metric-/.test(m));
    real.forEach(m => problems.push(`${el.name}: ${m}`));
  }
  return { elements, problems };
}

/**
 * Kick off an element export → queryId. The POST is NOT safely idempotent —
 * if the server actually received it, an export job may already have been
 * created even if the client never saw a clean success response. So the
 * retry here is scoped to only the failures that happened BEFORE any server
 * response:
 *   - a network-level error (connection refused/reset, DNS, etc. — no HTTP
 *     status at all) means the POST never reached/was answered by the
 *     server, so resending is safe.
 *   - HTTP 429 means the server's rate limiter rejected the request before
 *     it was processed (no export job created), so resending is also safe.
 * Any other HTTP response — a genuine 4xx (bad element/auth) OR a 5xx — means
 * the server received the request and answered it; for a 5xx we cannot tell
 * whether an export job was already accepted server-side before the error,
 * so it is treated as fatal here rather than retried (retrying by re-POSTing
 * could start a duplicate export job). The download-poll GET below is a
 * separate, idempotent operation and keeps retrying 5xx as before.
 */
async function startExport(workbookId, elementId, tok, maxWaitMs, pollMs) {
  const start = Date.now();
  let lastTransient = '';
  while (Date.now() - start < maxWaitMs) {
    let res, txt;
    try {
      res = await fetch(`${SIGMA_BASE}/v2/workbooks/${workbookId}/export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ elementId, format: { type: 'json' } }),
      });
      txt = await res.text();
    } catch (e) { lastTransient = `network ${e.message}`; await new Promise(r => setTimeout(r, pollMs)); continue; }
    if (res.ok) {
      let queryId;
      try { ({ queryId } = JSON.parse(txt)); } catch { /* fallthrough */ }
      if (queryId) return queryId;
      throw new Error(`export ${elementId}: no queryId in response: ${txt.slice(0, 400)}`);
    }
    if (res.status === 429) {
      lastTransient = `HTTP 429 ${txt.slice(0, 200)}`;
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    // Any other non-2xx response — 4xx or 5xx — is fatal, not retried: the
    // server received and answered the POST, so re-POSTing a 5xx risks
    // creating a duplicate export job (see docstring above).
    throw new Error(`export ${elementId} → HTTP ${res.status} ${txt.slice(0, 400)}`);
  }
  throw new Error(`export ${elementId}: kickoff never succeeded within ${maxWaitMs}ms${lastTransient ? ` (last transient: ${lastTransient})` : ''}`);
}

/**
 * "query": export one element's real data via POST /v2/workbooks/{id}/export
 * (format: json) → { queryId }, then poll GET /v2/query/{queryId}/download
 * until it returns a non-empty body (per the transpose-element export recipe
 * already proven in this org — see reference_sigma_transpose_element.md).
 */
async function exportElementRows(workbookId, elementId, { maxWaitMs = 90000, pollMs = 1500 } = {}) {
  const tok = await sigmaToken();
  // The POST that kicks off the export retries only pre-response network
  // failures and HTTP 429 (see startExport) — never a 5xx, since the server
  // may have already accepted the export and re-POSTing risks starting a
  // duplicate export job.
  const queryId = await startExport(workbookId, elementId, tok, maxWaitMs, pollMs);

  const start = Date.now();
  let lastTransient = '';
  while (Date.now() - start < maxWaitMs) {
    let dRes, buf;
    try {
      dRes = await fetch(`${SIGMA_BASE}/v2/query/${queryId}/download`, {
        headers: { Authorization: `Bearer ${tok}`, Accept: '*/*' },
      });
      buf = Buffer.from(await dRes.arrayBuffer());
    } catch (e) {
      // Socket-level reset/disconnect (the connection dropped before headers) —
      // transient; keep polling within the budget rather than failing the gate.
      lastTransient = `network ${e.message}`;
      await new Promise(r => setTimeout(r, pollMs));
      continue;
    }
    if (dRes.status === 200 && buf.length > 0) return parseExportRows(buf.toString('utf8'));
    // 5xx (e.g. the 503 "upstream connect error / connection termination"
    // Sigma's gateway intermittently returns) and 429 are TRANSIENT — retry
    // within maxWaitMs instead of throwing. Only a genuine 4xx client error
    // (bad/expired queryId, auth) is fatal. A still-running query returns a
    // non-200 <400 (202/204) or an empty 200 → also keep polling.
    if (dRes.status >= 400 && dRes.status < 500 && dRes.status !== 429) {
      throw new Error(`download ${queryId} → HTTP ${dRes.status} ${buf.toString('utf8').slice(0, 400)}`);
    }
    if (dRes.status >= 500 || dRes.status === 429) lastTransient = `HTTP ${dRes.status} ${buf.toString('utf8').slice(0, 200)}`;
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error(`export ${elementId}: query ${queryId} never completed within ${maxWaitMs}ms${lastTransient ? ` (last transient: ${lastTransient})` : ''}`);
}

function parseExportRows(text) {
  const t = text.trim();
  if (!t) return [];
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed.data)) return parsed.data;
    return [parsed];
  } catch {
    // JSONL — one JSON object per line.
    return t.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
}

/** First numeric-looking value in a row object, regardless of its key name. */
function firstNumber(rows) {
  const row = rows?.[0] || {};
  for (const v of Object.values(row)) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return NaN;
}

// ── conditionalFormats round-trip helpers ───────────────────────────────────
// The workbook spec GET returns YAML. We don't ship a YAML parser (zero deps),
// so extract just the one `conditionalFormats:` block by indentation and match
// its scalars. `extractCFBlock` returns the block text (its own line + every
// more-indented line, stopping at the next same-or-shallower key like `layout:`).

function extractCFBlock(yaml) {
  const i = yaml.indexOf('conditionalFormats:');
  if (i < 0) return '';
  const baseIndent = (yaml.slice(0, i).match(/[^\n]*$/)?.[0] || '').length;
  const lines = yaml.slice(i).split('\n');
  const out = [lines[0]];
  for (let k = 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.trim() === '') { out.push(l); continue; }
    if ((l.match(/^(\s*)/)?.[1].length ?? 0) <= baseIndent) break;
    out.push(l);
  }
  return out.join('\n');
}

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// True iff a `condition: <op>` line for exactly `op` is present (quoted or not).
// The trailing boundary stops `<` from matching a `<=` line (and `=` a `>=`).
const condPresent = (block, op) => new RegExp(`condition:\\s*'?${reEsc(op)}'?\\s*($|\\n)`, 'm').test(block);
// True iff a text-color (`color:`) line is present. `\ncolor:` won't match the
// `backgroundColor:` line (capital C, and preceded by `background`).
const colorFieldPresent = (block, hex) => new RegExp(`\\n\\s*color:\\s*'?${reEsc(hex)}'?`).test(block);

async function main() {
  // ── Step 1: universe → data model ─────────────────────────────────────────
  const universeXml = readFileSync(join(root, 'fixtures/efashion_universe.xml'), 'utf8');
  const uconv = convertBobjToSigma(universeXml, { connectionId: CONNECTION_ID });
  console.log('Universe converted →', JSON.stringify(uconv.stats));
  uconv.warnings.forEach(w => console.log('  ⚠', w));

  const dataModelId = await postDataModel(uconv.model, FOLDER_ID);
  created.dataModelId = dataModelId;
  console.log('Data model created:', dataModelId);

  const specRaw = await getDataModelSpec(dataModelId);
  const pages0 = specRaw.pages || specRaw.spec?.pages || [];
  const elements0 = pages0[0]?.elements || specRaw.elements || [];
  const view = elements0.find(e => /View$/.test(e.name || ''));
  if (!view) throw new Error('No "… View" element found in the posted DM spec readback — cannot bind a workbook.');
  console.log('View element:', view.name, view.id);

  const measureMap = {};
  for (const e of uconv.model.pages[0].elements) for (const m of (e.metrics || [])) measureMap[m.name] = m.formula;

  // ── Step 2: Webi variables (all 4 tiers) → workbook + dataModelAdditions ──
  const webiDoc = JSON.parse(readFileSync(join(root, 'fixtures/e2e_webi_variables.json'), 'utf8'));
  const schemaVersion = await referenceWorkbookSchemaVersion();
  const wconv = convertWebiToWorkbook(webiDoc, {
    folderId: FOLDER_ID,
    dataModelId,
    dataModelElementId: view.id,
    sourceName: view.name,
    measureMap,
    schemaVersion,
    workbookName: 'E2E Webi Formula Tie-Out',
  });
  console.log('\nWebi converted →', JSON.stringify(wconv.stats));
  wconv.warnings.forEach(w => console.log('  ⚠', w));
  console.log('\ndataModelAdditions:', JSON.stringify(wconv.dataModelAdditions, null, 2));

  // Tier 4 — NoFilter() must produce a specific warning, not silence.
  check(
    wconv.warnings.some(w => /NoFilter/i.test(w) && /unfiltered element/i.test(w)),
    'Tier 4: NoFilter() produced a specific how-to warning (not silently dropped)'
  );

  // ── Step 3: apply dataModelAdditions to the posted DM ─────────────────────
  const additions = wconv.dataModelAdditions;
  if (additions.metrics.length || additions.columns.length) {
    const merge = mergeAdditionsIntoView(specRaw, view.id, additions);
    console.log(`\nDM additions merged: +${merge.addedMetrics} metric(s), +${merge.addedColumns} column(s)` +
      (merge.skipped.length ? `, skipped ${merge.skipped.join(', ')}` : ''));
    await postDataModelSpec(dataModelId, specRaw); // PUT /v2/dataModels/{id}/spec (corrected verb — see sigma.mjs)
    console.log('DM spec updated live.');
  }

  // ── Step 4: the converted workbook is used UNCHANGED ──────────────────────
  // The translator now emits table `groupings` directly from the Webi block's
  // breaks/sort (Task 1+2): the E2E fixture puts `breaks: ["Customer Region"]`
  // (+ `sort: [{Net Revenue, descending}]`) on "Region Summary" and a break on
  // "Region Raw Check", so both collapse to one row per region — per-group
  // subtotals in `calculations`, the running total rewritten to
  // CumulativeSum(Sum(...)), and the sort inside the grouping entry — with no
  // post-processing by this harness. The old manual `groupBySum` was deleted.
  const page = wconv.workbook.pages[0];
  const byName = n => page.elements.find(e => e.name === n);
  const summary = byName('Region Summary');
  const rawCheck = byName('Region Raw Check');
  if (!summary || !rawCheck) throw new Error('Region Summary / Region Raw Check element missing from the converted workbook.');
  // Guard: the tie-outs below only mean anything if the CONVERTER (not this
  // harness) produced the grouping. Fail loudly if it didn't.
  check(Array.isArray(summary.groupings) && summary.groupings.length === 1,
    'Converter emitted a grouping on Region Summary (breaks → groupings, no harness post-processing)');
  const summaryGrp = summary.groupings?.[0] || {};
  const netColId = summary.columns.find(c => c.name === 'Net Revenue')?.id;
  check(Array.isArray(summaryGrp.sort) && summaryGrp.sort.length === 1 &&
    summaryGrp.sort[0].columnId === netColId && summaryGrp.sort[0].direction === 'descending',
    'Converter carried the sort INSIDE the grouping entry (Net Revenue, descending)');
  const runningCol = summary.columns.find(c => c.name === 'Running Revenue');
  check(/^CumulativeSum\(Sum\(\[.*Net Revenue\]\)\)$/.test(runningCol?.formula || ''),
    `Converter rewrote the running total to CumulativeSum(Sum(...)) (got ${runningCol?.formula})`);

  // Guard: the CONVERTER (not this harness) emitted the conditionalFormats from
  // the fixture's alerter on Region Summary — otherwise the round-trip gate
  // below would prove nothing. `>` / value 30000 / bg #c8e6c9 / text #1b5e20.
  const cfEmitted = (summary.conditionalFormats || [])[0];
  check(Array.isArray(summary.conditionalFormats) && summary.conditionalFormats.length === 1 &&
    cfEmitted?.type === 'single' && cfEmitted?.condition === '>' && cfEmitted?.value === 30000 &&
    Array.isArray(cfEmitted?.columnIds) && cfEmitted.columnIds[0] === netColId &&
    cfEmitted?.style?.backgroundColor === '#c8e6c9' && cfEmitted?.style?.color === '#1b5e20',
    `Converter emitted conditionalFormats on Region Summary (single ">" 30000, bg+text color) — got ${JSON.stringify(cfEmitted)}`);

  // ── Step 5: POST the workbook (converter output, unchanged) ────────────────
  const workbookId = await postWorkbook(wconv.workbook);
  if (!workbookId) throw new Error('postWorkbook did not return a workbookId.');
  created.workbookIds.push(workbookId);
  console.log('\nWorkbook created:', workbookId);
  console.log(`Open: ${SIGMA_BASE.replace(/^https:\/\/aws-api\./, 'https://app.')} → workbook ${workbookId}`);

  // ── Step 5b: conditionalFormats ROUND-TRIP GATE (the feature under test) ───
  // A format feature has no numeric tie-out — the gate is persistence. GET the
  // just-POSTed workbook's spec back (YAML) and assert the alerter → Sigma
  // conditionalFormats rule the converter put on Region Summary SURVIVED the
  // POST intact: target column id + condition + value + BOTH style colors. This
  // is a REAL round-trip against the live API on the actual converter output —
  // never faked. (The converter-emitted shape was already guarded pre-POST.)
  const wbYaml = await sigmaGet(`/v2/workbooks/${workbookId}/spec`);
  const cfBlock = extractCFBlock(typeof wbYaml === 'string' ? wbYaml : JSON.stringify(wbYaml));
  console.log('\nPersisted conditionalFormats block (GET /v2/workbooks/{id}/spec):\n' + (cfBlock || '(none)'));
  check(!!cfBlock, 'CF round-trip: summary table kept a conditionalFormats block in the persisted spec');
  check(cfBlock.includes(netColId), `CF round-trip: rule targets the Net Revenue column id (${netColId})`);
  check(condPresent(cfBlock, '>'), 'CF round-trip: condition ">" persisted verbatim');
  check(/value:\s*30000(\b|\.0*\b)/.test(cfBlock), 'CF round-trip: value 30000 persisted');
  check(/backgroundColor:\s*'?#c8e6c9'?/.test(cfBlock), 'CF round-trip: backgroundColor #c8e6c9 persisted');
  check(colorFieldPresent(cfBlock, '#1b5e20'), 'CF round-trip: text color persisted as `color` #1b5e20 (not fontColor)');

  // ── Step 6: describe — zero error-typed columns ───────────────────────────
  const { elements: wbElements, problems } = await describeWorkbook(workbookId);
  console.log(`\nDescribed ${wbElements.length} workbook element(s): ${wbElements.map(e => e.name).join(', ')}`);
  check(problems.length === 0,
    `describe: zero error-typed columns${problems.length ? ` — ${problems.join(' | ')}` : ''}`);

  // ── Step 7: query — real tie-out numbers ──────────────────────────────────
  const netRevKpi = byName('Net Revenue Total');
  const grossRevKpi = byName('Gross Revenue Total');
  const marginKpi = byName('Margin Pct');
  const allTimeKpi = byName('All Time Net Revenue');

  const netRevTotal = firstNumber(await exportElementRows(workbookId, netRevKpi.id));
  const grossRevTotal = firstNumber(await exportElementRows(workbookId, grossRevKpi.id));
  const marginPctValue = firstNumber(await exportElementRows(workbookId, marginKpi.id));
  const allTimeValue = firstNumber(await exportElementRows(workbookId, allTimeKpi.id));

  console.log(`\nNet Revenue Total (KPI):    ${netRevTotal}`);
  console.log(`Gross Revenue Total (KPI):  ${grossRevTotal}`);
  console.log(`Margin Pct (KPI):           ${marginPctValue}`);
  console.log(`All Time Net Revenue (KPI): ${allTimeValue}`);

  // (b) context-free ratio measure ties to an INDEPENDENT computation of the
  // two base measures (each its own KPI/query, not reused from Margin Pct's
  // own internal formula).
  const expectedMargin = netRevTotal / grossRevTotal;
  const tol = (expected) => Math.max(1e-6, Math.abs(expected) * 1e-4);
  check(
    Number.isFinite(marginPctValue) && Number.isFinite(expectedMargin) &&
    Math.abs(marginPctValue - expectedMargin) <= tol(expectedMargin),
    `Margin Pct (${marginPctValue}) ≈ Net Revenue / Gross Revenue (${expectedMargin}) computed independently from the two base measures`
  );

  // Tier 4 bonus check: the NoFilter stub produced a REAL (not broken) value.
  check(
    Number.isFinite(allTimeValue) && Math.abs(allTimeValue - netRevTotal) <= tol(netRevTotal),
    `Tier 4: All Time Net Revenue (NoFilter stub, ${allTimeValue}) is a real value ≈ Net Revenue Total (${netRevTotal}), not a broken column`
  );

  // Both grouped tables export one row per group. Read them in the order the
  // API returned them (that IS the grouping's sort order — do NOT re-sort, the
  // sort tie-out below depends on the returned order); dedupe defensively by
  // region key, preserving first-seen order. `<null>` is the sentinel for the
  // one region group whose Customer Region is blank/null.
  const RK = r => (r['Customer Region'] == null ? '<null>' : r['Customer Region']);
  const preserveOrder = rows => {
    const seen = new Set(), out = [];
    for (const r of rows) { const k = RK(r); if (!seen.has(k)) { seen.add(k); out.push(r); } }
    return out;
  };
  const summaryRows = preserveOrder(await exportElementRows(workbookId, summary.id));
  const rawRows = preserveOrder(await exportElementRows(workbookId, rawCheck.id));
  console.log('\nRegion Summary (per region, in returned order):', JSON.stringify(summaryRows.map(r => ({
    region: r['Customer Region'], net: r['Net Revenue'], gross: r['Gross Revenue'],
    regional: r['Regional Net Revenue'], running: r['Running Revenue'],
  })), null, 2));
  console.log('Region Raw Check (independent grouped query, per region):', JSON.stringify(rawRows.map(r => ({
    region: r['Customer Region'], net: r['Net Revenue'],
  })), null, 2));

  // (a) SUBTOTALS — each region's Net Revenue subtotal from the converter's
  // grouping ties out to an INDEPENDENT raw grouped query (the "Region Raw
  // Check" element, grouped only on Customer Region) for the same region.
  const rawNetByRegion = new Map(rawRows.map(r => [RK(r), Number(r['Net Revenue'])]));
  let subtotalsTie = summaryRows.length > 0 && summaryRows.length === rawRows.length;
  for (const r of summaryRows) {
    const key = RK(r), sub = Number(r['Net Revenue']), raw = rawNetByRegion.get(key);
    const ok = Number.isFinite(sub) && Number.isFinite(raw) && Math.abs(sub - raw) <= tol(raw);
    if (!ok) subtotalsTie = false;
    console.log(`   subtotal[${key}]: grouping ${sub} vs independent raw grouped ${raw} → ${ok ? '≈' : '≠ MISMATCH'}`);
  }
  check(subtotalsTie,
    `Subtotals: every region's Net Revenue subtotal ties to the independent raw grouped query (${summaryRows.length} region group(s))`);

  // (b) SORT ORDER — the grouped rows come back sorted by the requested key
  // (Net Revenue, descending). Assert the returned region order matches an
  // INDEPENDENT sort of the raw grouped query by Net Revenue descending.
  const actualOrder = summaryRows.map(RK);
  const expectedOrder = [...rawRows].sort((a, b) => Number(b['Net Revenue']) - Number(a['Net Revenue'])).map(RK);
  console.log(`   sort actual  : ${JSON.stringify(actualOrder)}`);
  console.log(`   sort expected: ${JSON.stringify(expectedOrder)} (independent Net-Revenue-desc sort)`);
  check(JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
    'Sort order: grouped rows returned Net-Revenue-descending, matching an independent sorted query');

  // (c) RUNNING TOTAL — the converter's CumulativeSum(Sum(...)) is monotonically
  // non-decreasing when read in the grouping's accumulation (sort) order, and
  // its final value equals the grand-total Net Revenue.
  const running = summaryRows.map(r => Number(r['Running Revenue']));
  let monotonic = running.length > 1 && running.every(Number.isFinite);
  for (let i = 1; i < running.length; i++) if (running[i] < running[i - 1] - 1e-6) monotonic = false;
  check(monotonic, `Running Revenue (converter CumulativeSum(Sum(...))) monotonically non-decreasing across ${running.length} region(s): [${running.join(', ')}]`);
  const finalRunning = running[running.length - 1];
  const subtotalSum = summaryRows.reduce((s, r) => s + Number(r['Net Revenue']), 0);
  check(Number.isFinite(finalRunning) && Math.abs(finalRunning - subtotalSum) <= tol(subtotalSum),
    `Running Revenue final (${finalRunning}) == grand total of the region subtotals (${subtotalSum})`);

  // (d) In-context sum groups at the expected grain — spot-check one real
  // (non-null) region's translated "Regional Net Revenue" (Tier-3 `In`
  // translation) against the INDEPENDENT raw grouped query for the same region.
  const spot = summaryRows.find(r => r['Customer Region'] != null);
  const spotRegion = spot?.['Customer Region'];
  const spotFromTranslated = Number(spot?.['Regional Net Revenue']);
  const spotFromRaw = rawNetByRegion.get(spotRegion);
  check(
    spotRegion != null && Number.isFinite(spotFromTranslated) && Number.isFinite(spotFromRaw) &&
    Math.abs(spotFromTranslated - spotFromRaw) <= tol(spotFromRaw),
    `In-context sum groups at the "${spotRegion}" grain: Regional Net Revenue (${spotFromTranslated}) ≈ independent raw grouped query (${spotFromRaw})`
  );

  // ── Step 8: DM-placed DIMENSION path — previously untested end-to-end. The
  // "Region Bucket" variable (fixtures/e2e_webi_variables.json) is context-free
  // and qualification:"dimension", so it lands in dataModelAdditions.columns
  // (a BARE-formula calc COLUMN merged onto the View by mergeAdditionsIntoView
  // above) and the "Region Bucket Check" block resolves it via a QUALIFIED
  // `[Order Fact View/Region Bucket]` ref — the sibling path to the DM-placed
  // MEASURE path (dmMeasureInline) already exercised by Margin Pct/step 7, but
  // never live-verified before this fix wave. describeWorkbook() above already
  // covers "no error-typed column" for every element including this one; this
  // step additionally confirms the column actually RESOLVES to sensible values
  // on real data.
  const bucketCheck = byName('Region Bucket Check');
  if (!bucketCheck) throw new Error('Region Bucket Check element missing from the converted workbook.');
  const bucketRows = await exportElementRows(workbookId, bucketCheck.id);
  const bucketValues = bucketRows.map(r => r['Region Bucket']).filter(v => v != null && v !== '');
  console.log(`\nRegion Bucket Check: ${bucketRows.length} row(s), ${bucketValues.length} non-empty "Region Bucket" value(s), distinct: ${JSON.stringify([...new Set(bucketValues)])}`);
  check(bucketValues.length > 0, `Region Bucket Check returned ${bucketValues.length} non-empty "Region Bucket" value(s) (DM-placed dimension is not blank/broken)`);
  check(bucketValues.every(v => v === 'West' || v === 'Other'), 'every "Region Bucket" value is "West" or "Other" (DM-placed dimension calc column resolves correctly on real data)');

  // ── Step 9: UNGROUPED-SORT live verification (Task 3 open question #2) ──────
  // The converter emits an element-level `sort: [{columnId,direction}]` for a
  // table that has a Webi sort but NO break (unit-tested offline). Prove that
  // exact shape actually ORDERS rows on the live API — the answer to the
  // "where does sort go on an ungrouped table?" open question (element-level
  // `sort`, not a grouping and not a guessed field). This is a harness-owned
  // probe element in its own throwaway workbook (NOT converter output), with a
  // top-n filter to bound the export — a real ungrouped table over the fact
  // would otherwise return every detail row.
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const uReg = `c-${rnd()}`, uNet = `c-${rnd()}`;
  const qcol = f => f.replace(/\[([^\]\/]+)\]/g, (_m, i) => `[${view.name}/${i}]`);
  const sortProbe = {
    name: 'E2E Webi Ungrouped Sort Probe', folderId: FOLDER_ID, schemaVersion,
    pages: [{ id: `page-${rnd()}`, name: 'P', elements: [{
      id: `tbl-${rnd()}`, kind: 'table', name: 'Ungrouped Sort',
      source: { kind: 'data-model', dataModelId, elementId: view.id },
      columns: [
        { id: uReg, name: 'Customer Region', formula: qcol('[Customer Region]') },
        { id: uNet, name: 'Net Rev Raw', formula: qcol('[Net Revenue]') },
      ],
      order: [uReg, uNet],
      filters: [{ id: `f-${rnd()}`, columnId: uNet, kind: 'top-n', rankingFunction: 'rank', mode: 'top-n', rowCount: 300, includeNulls: 'when-no-value-is-selected' }],
      sort: [{ columnId: uReg, direction: 'descending' }],
    }] }],
  };
  const sortProbeId = await postWorkbook(sortProbe);
  if (!sortProbeId) throw new Error('ungrouped-sort probe workbook POST returned no id');
  created.workbookIds.push(sortProbeId);
  const sortElId = (await listPageElements(sortProbeId)).find(e => e.name === 'Ungrouped Sort')?.elementId;
  const sortProbeRows = await exportElementRows(sortProbeId, sortElId);
  const nonNullRegions = sortProbeRows.map(r => r['Customer Region']).filter(v => v != null && v !== '');
  let sortedDesc = nonNullRegions.length > 1;
  for (let i = 1; i < nonNullRegions.length; i++) if (String(nonNullRegions[i - 1]) < String(nonNullRegions[i])) { sortedDesc = false; break; }
  console.log(`\nUngrouped sort probe: ${sortProbeRows.length} row(s); non-null region sequence (first 10): ${JSON.stringify(nonNullRegions.slice(0, 10))}`);
  check(sortedDesc, `Ungrouped sort: element-level sort ordered the rows Customer-Region DESCENDING (${[...new Set(nonNullRegions)].join(' > ')})`);

  // ── Step 10: conditionalFormats operator / text-color / Between live probes ─
  // Resolve — and RE-CONFIRM on every run so they can't silently regress — the
  // three open questions the converter's CF mapping depends on. Each is a
  // harness-owned throwaway workbook (NOT converter output): one table over the
  // View carrying only conditionalFormats. No warehouse query (POST + GET spec).
  const cfProbeWb = (cfs) => ({
    name: `E2E Webi CF Probe ${rnd()}`, folderId: FOLDER_ID, schemaVersion,
    pages: [{ id: `page-${rnd()}`, name: 'P', elements: [{
      id: `tbl-${rnd()}`, kind: 'table', name: 'CF',
      source: { kind: 'data-model', dataModelId, elementId: view.id },
      columns: [
        { id: 'c-cfdim', name: 'Customer Region', formula: qcol('[Customer Region]') },
        { id: 'c-cfval', name: 'Net Revenue', formula: qcol('[Net Revenue]') },
      ],
      order: ['c-cfdim', 'c-cfval'],
      conditionalFormats: cfs,
    }] }],
  });
  const getCFBlock = async (wbId) => {
    const y = await sigmaGet(`/v2/workbooks/${wbId}/spec`);
    return extractCFBlock(typeof y === 'string' ? y : JSON.stringify(y));
  };
  // Post a probe expected to FAIL (bad condition enum); return the error (or
  // null if it unexpectedly succeeded — then keep the id for cleanup).
  const expectReject = async (cfs) => {
    try { const id = await postWorkbook(cfProbeWb(cfs)); if (id) created.workbookIds.push(id); return null; }
    catch (e) { return e.message; }
  };

  // (a) OPERATORS — every string the converter's CF_OP can emit must be accepted
  // and round-trip VERBATIM (this is the live source of truth CF_OP tracks).
  const OP_SET = ['>', '<', '>=', '<=', '=', '!='];
  const opProbeId = await postWorkbook(cfProbeWb(
    OP_SET.map((op, k) => ({ type: 'single', columnIds: ['c-cfval'], condition: op, value: (k + 1) * 100, style: { backgroundColor: '#c8e6c9' } }))
  ));
  if (!opProbeId) throw new Error('CF operator probe POST returned no id');
  created.workbookIds.push(opProbeId);
  const opBlock = await getCFBlock(opProbeId);
  console.log(`\nCF operator probe: persisted conditions → ${OP_SET.filter(op => condPresent(opBlock, op)).map(o => `"${o}"`).join(', ')}`);
  for (const op of OP_SET) check(condPresent(opBlock, op), `CF operator "${op}" is accepted and round-trips verbatim (Sigma single condition)`);

  // (b) NOT-EQUAL FORM — `<>` must be REJECTED (that is WHY CF_OP maps not-equal
  // to `!=`, which (a) just proved round-trips). Asserting the rejection keeps
  // that mapping honest.
  const ltgtErr = await expectReject([{ type: 'single', columnIds: ['c-cfval'], condition: '<>', value: 1, style: { backgroundColor: '#c8e6c9' } }]);
  check(!!ltgtErr, `CF not-equal: "<>" is REJECTED by the API — justifies mapping not-equal to "!=" (${(ltgtErr || 'UNEXPECTEDLY ACCEPTED').slice(0, 90)})`);

  // (c) TEXT COLOR — `fontColor` is silently dropped on round-trip; `color` (the
  // field the converter emits, already confirmed persisted in the Step-5b gate)
  // is the correct one. POSTing fontColor succeeds but the field must NOT survive.
  const fcProbeId = await postWorkbook(cfProbeWb([{ type: 'single', columnIds: ['c-cfval'], condition: '>', value: 1, style: { backgroundColor: '#c8e6c9', fontColor: '#1b5e20' } }]));
  if (fcProbeId) created.workbookIds.push(fcProbeId);
  const fcBlock = await getCFBlock(fcProbeId);
  check(!/fontColor/i.test(fcBlock) && !colorFieldPresent(fcBlock, '#1b5e20'),
    'CF text color: `fontColor` is silently dropped on round-trip — confirms `color` is the correct text-color field');

  // (d) BETWEEN — a native two-bound "Between" is NOT accepted on the
  // workbook-spec path (any value shape 400s), so the converter warns + skips.
  const betweenErr = await expectReject([{ type: 'single', columnIds: ['c-cfval'], condition: 'Between', value: 100, value2: 500, style: { backgroundColor: '#c8e6c9' } }]);
  check(!!betweenErr, `CF Between: a native two-bound "Between" conditional format is NOT accepted — converter warns + skips (${(betweenErr || 'UNEXPECTEDLY ACCEPTED').slice(0, 90)})`);

  console.log(failures ? `\n❌ ${failures} assertion(s) failed — NOT green.` : '\n✅ all live tie-out assertions passed.');
}

async function cleanup() {
  console.log('\nCleanup:');
  for (const id of created.workbookIds) {
    try { await deleteFile(id); console.log(`  deleted workbook ${id}`); }
    catch (e) { console.log(`  ⚠ failed to delete workbook ${id}: ${e.message}`); }
  }
  if (created.dataModelId) {
    try { await deleteFile(created.dataModelId); console.log(`  deleted data model ${created.dataModelId}`); }
    catch (e) { console.log(`  ⚠ failed to delete data model ${created.dataModelId}: ${e.message}`); }
  }
}

main()
  .catch(e => { console.error('\n❌ e2e-webi-formula failed:', e.stack || e.message); failures++; })
  .finally(async () => {
    await cleanup();
    process.exit(failures ? 1 : 0);
  });
