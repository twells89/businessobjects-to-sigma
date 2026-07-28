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
const created = { dataModelId: null, workbookId: null };

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

  // ── Step 4: post-process the workbook — add groupings/sort so the grouped
  // tie-outs (In-context sum, Running Revenue) evaluate at a real grain. This
  // is the harness's own responsibility (not the translator's): a Sigma
  // `table` with no `groupings` shows raw detail rows, so the harness wires
  // the grouping a real workbook author would add when following the
  // translator's context-operator warning ("set the Sigma grouping to
  // [Customer Region] and verify").
  //
  // Two live-verified (Task 8) rules govern how a grouped table exports:
  //   1. EVERY non-dimension column must be listed in the grouping's
  //      `calculations` for the table to collapse to one row per group; a
  //      column left out keeps the table at detail grain (Sigma broadcasts the
  //      group aggregate over every underlying row).
  //   2. A running total (the translator's RunningSum→CumulativeSum) only
  //      produces a valid, monotonic group-level series when the author (a)
  //      accumulates the group SUM — CumulativeSum(Sum([col])) — and (b) lists
  //      it in `calculations`. A bare-column CumulativeSum placed in
  //      `calculations` is silently DROPPED from the result; left as a detail
  //      column it computes per-row in an order the export does not preserve.
  //      This inner-Sum + grouping placement is exactly the completion a real
  //      author performs for a windowed measure whose translator output is
  //      (by design, v1) the bare base call.
  const page = wconv.workbook.pages[0];
  const byName = n => page.elements.find(e => e.name === n);
  const colByName = (el, n) => el.columns.find(c => c.name === n);
  const groupBySum = (tableEl, dimName, aggCalcNames, runningCalcNames = []) => {
    const dimCol = colByName(tableEl, dimName);
    if (!dimCol) throw new Error(`groupBySum: no "${dimName}" column on "${tableEl.name}"`);
    const need = n => {
      const c = colByName(tableEl, n);
      if (!c) throw new Error(`groupBySum: no "${n}" column on "${tableEl.name}"`);
      return c;
    };
    const aggCols = aggCalcNames.map(need);
    // Complete each running total to its monotonic group-level form: wrap the
    // CumulativeSum's bare column argument in Sum() (rule 2 above). The
    // translator supplies `CumulativeSum([Order Fact View/Net Revenue])`; the
    // author scopes it to the grouping as `CumulativeSum(Sum([…]))`.
    const runCols = runningCalcNames.map(n => {
      const c = need(n);
      const rewritten = c.formula.replace(/CumulativeSum\(\s*(\[[^\]]+\])\s*\)/, 'CumulativeSum(Sum($1))');
      if (rewritten === c.formula) throw new Error(`groupBySum: "${n}" is not a bare-column CumulativeSum — got ${c.formula}`);
      c.formula = rewritten;
      return c;
    });
    // NOTE: `sort` is a property of the `groupings[]` entry itself, not a
    // top-level table field (live-verified: a top-level `table.sort` 400s
    // with "Sort column not found" even for a column id that legitimately
    // exists on the table — see tables.md's `groupings[].sort` example).
    tableEl.groupings = [{
      id: `grp-${tableEl.id}`,
      groupBy: [dimCol.id],
      calculations: [...aggCols, ...runCols].map(c => c.id),
      sort: [{ columnId: dimCol.id, direction: 'ascending' }],
    }];
  };

  const summary = byName('Region Summary');
  const rawCheck = byName('Region Raw Check');
  if (!summary || !rawCheck) throw new Error('Region Summary / Region Raw Check element missing from the converted workbook.');
  groupBySum(summary, 'Customer Region', ['Net Revenue', 'Gross Revenue', 'Regional Net Revenue'], ['Running Revenue']);
  groupBySum(rawCheck, 'Customer Region', ['Net Revenue']);

  // ── Step 5: POST the workbook ──────────────────────────────────────────────
  const workbookId = await postWorkbook(wconv.workbook);
  if (!workbookId) throw new Error('postWorkbook did not return a workbookId.');
  created.workbookId = workbookId;
  console.log('\nWorkbook created:', workbookId);
  console.log(`Open: ${SIGMA_BASE.replace(/^https:\/\/aws-api\./, 'https://app.')} → workbook ${workbookId}`);

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

  // The grouped table exports one row per group; dedupe defensively by region
  // and order by the grouping's own sort (Customer Region ascending, null/blank
  // region last) so the running total is read in the SAME order Sigma
  // accumulated it.
  const dedupeByRegion = rows => {
    const seen = new Map();
    for (const r of rows) { const k = r['Customer Region'] ?? null; if (!seen.has(k)) seen.set(k, r); }
    return [...seen.values()].sort((a, b) => {
      const ra = a['Customer Region'], rb = b['Customer Region'];
      if (ra == null && rb == null) return 0;
      if (ra == null) return 1;
      if (rb == null) return -1;
      return String(ra).localeCompare(String(rb));
    });
  };

  // (c) Running Revenue — the translator's RunningSum→CumulativeSum, completed
  // by the author into a group-level running total, is monotonically
  // non-decreasing across the region-ascending rows and totals to the grand
  // Net Revenue on the final region.
  const summaryRows = dedupeByRegion(await exportElementRows(workbookId, summary.id));
  console.log('\nRegion Summary (per region, region-asc):', JSON.stringify(summaryRows.map(r => ({
    region: r['Customer Region'], net: r['Net Revenue'], gross: r['Gross Revenue'],
    regional: r['Regional Net Revenue'], running: r['Running Revenue'],
  })), null, 2));
  const running = summaryRows.map(r => Number(r['Running Revenue']));
  let monotonic = running.length > 1 && running.every(Number.isFinite);
  for (let i = 1; i < running.length; i++) if (running[i] < running[i - 1] - 1e-6) monotonic = false;
  check(monotonic, `Running Revenue (group-level cumulative) is monotonically non-decreasing across ${running.length} region(s): [${running.join(', ')}]`);

  // (d) In-context sum groups at the expected grain — spot-check one real
  // (non-null) region's translated "Regional Net Revenue" (Tier-3 `In`
  // translation, grouped by [Customer Region] per its warning) against an
  // INDEPENDENT element's raw grouped query for the same region.
  const rawRows = dedupeByRegion(await exportElementRows(workbookId, rawCheck.id));
  console.log('Region Raw Check (per region):', JSON.stringify(rawRows.map(r => ({
    region: r['Customer Region'], net: r['Net Revenue'],
  })), null, 2));
  const spot = summaryRows.find(r => r['Customer Region'] != null);
  const spotRegion = spot?.['Customer Region'];
  const spotFromTranslated = Number(spot?.['Regional Net Revenue']);
  const spotRaw = rawRows.find(r => r['Customer Region'] === spotRegion);
  const spotFromRaw = spotRaw ? Number(spotRaw['Net Revenue']) : NaN;
  check(
    spotRegion != null && Number.isFinite(spotFromTranslated) && Number.isFinite(spotFromRaw) &&
    Math.abs(spotFromTranslated - spotFromRaw) <= tol(spotFromRaw),
    `In-context sum groups at the "${spotRegion}" grain: Regional Net Revenue (${spotFromTranslated}) ≈ independent raw grouped query (${spotFromRaw})`
  );

  console.log(failures ? `\n❌ ${failures} assertion(s) failed — NOT green.` : '\n✅ all live tie-out assertions passed.');
}

async function cleanup() {
  console.log('\nCleanup:');
  if (created.workbookId) {
    try { await deleteFile(created.workbookId); console.log(`  deleted workbook ${created.workbookId}`); }
    catch (e) { console.log(`  ⚠ failed to delete workbook ${created.workbookId}: ${e.message}`); }
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
