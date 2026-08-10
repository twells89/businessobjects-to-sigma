#!/usr/bin/env node
/**
 * Offline smoke test — no network. Runs both converters on the bundled fixtures
 * and asserts the output shape. Exits non-zero on any failure.
 *   node test/smoke.mjs   (or npm test)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertBobjToSigma, detectBobjInputKind } from '../converters/bobj.mjs';
import { convertWebiToWorkbook } from '../converters/webi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

// ── Universe → data model ────────────────────────────────────────────────────
const uni = convertBobjToSigma(read('fixtures/efashion_universe.json'), { connectionId: 'conn', database: 'CSA', schema: 'TJ' });
const els = uni.model.pages[0].elements;
check(uni.model.schemaVersion === 1, 'universe: schemaVersion === 1');
check(els.length >= 3, `universe: ${els.length} elements (>= 3)`);
const fact = els.find(e => e.name === 'Order Fact');
check(!!fact, 'universe: Order Fact element present');
check((fact?.metrics || []).some(m => /Sum\(\[Net Revenue\]\)/.test(m.formula)), 'universe: Net Revenue metric = Sum([Net Revenue])');
check((fact?.relationships || []).some(r => r.name === 'CUSTOMER_DIM' && r.keys.length === 1), 'universe: ORDER_FACT→CUSTOMER_DIM relationship with a key');
const view = els.find(e => /View$/.test(e.name));
check(!!view && view.columns.some(c => c.formula === '[Order Fact/CUSTOMER_DIM/Customer Region]'), 'universe: View has cross-element [.../CUSTOMER_DIM/Customer Region]');

// ── Universe → data model via SL-SDK / IDT XML export (ingestBobjSdkXml) ─────
// The XML path carries the physical columns + object SELECTs the RWS REST
// endpoint does NOT expose; it must produce a structurally identical model.
const xmlUni = convertBobjToSigma(readFileSync(join(root, 'fixtures/efashion_universe.xml'), 'utf8'),
  { connectionId: 'conn', database: 'CSA', schema: 'TJ' });
const sig = r => JSON.stringify(r.model.pages[0].elements.map(e => ({
  n: e.name, k: e.source?.kind, p: e.source?.path,
  c: (e.columns || []).map(c => c.name || c.formula),
  m: (e.metrics || []).map(m => `${m.name}=${m.formula}`),
  r: (e.relationships || []).map(rl => rl.name),
})));
check(xmlUni.model.schemaVersion === 1, 'xml: schemaVersion === 1');
check(JSON.stringify(xmlUni.stats) === JSON.stringify(uni.stats), `xml: stats match JSON path (${JSON.stringify(xmlUni.stats)})`);
check(sig(xmlUni) === sig(uni), 'xml: SDK-XML ingest produces identical structure to RWS JSON ingest');

// ── Universe → data model WITH target-layer remap (restructured / platinum) ──
const remapped = convertBobjToSigma(read('fixtures/efashion_universe.json'), {
  connectionId: 'conn', database: 'CSA',
  tableMap: { ORDER_FACT: { table: 'FCT_ORDERS', schema: 'PLATINUM' }, CUSTOMER_DIM: { table: 'DIM_CUST', schema: 'PLATINUM' } },
  columnMap: { 'ORDER_FACT.NET_REVENUE': 'NET_REV', '*.REGION': 'SALES_REGION' },
});
const rEls = remapped.model.pages[0].elements;
const rFact = rEls.find(e => (e.source?.path || []).slice(-1)[0] === 'FCT_ORDERS');
check(!!rFact, 'remap: ORDER_FACT element repointed to FCT_ORDERS');
check((rFact?.source?.path || []).includes('PLATINUM'), 'remap: per-table schema relocation → path includes PLATINUM');
check((rFact?.metrics || []).some(m => /Sum\(\[Net Rev\]\)/.test(m.formula)), 'remap: NET_REVENUE column renamed → Sum([Net Rev])');
check(rEls.some(e => (e.relationships || []).some(r => r.name === 'DIM_CUST')), 'remap: join repointed → relationship name DIM_CUST');
check(remapped.warnings.some(w => /remap applied/i.test(w)), 'remap: applied-summary warning surfaced');
// A bad map key must be surfaced, not silently ignored.
const remapTypo = convertBobjToSigma(read('fixtures/efashion_universe.json'), { connectionId: 'conn', tableMap: { NOPE_TABLE: 'WHATEVER' } });
check(remapTypo.warnings.some(w => /matched no universe table/.test(w)), 'remap: unmatched tableMap key warns (typo guard)');

// ── Join fidelity: schema-qualified (3-part) join expressions must resolve ────
// A data-foundation join like "DWH"."ORDER_FACT"."KEY" = "DWH"."CUST_DIM"."KEY"
// must still produce a relationship (parseJoinKeys takes the last two segments).
const xml3 = `<universe name="Q"><dataFoundation>
  <tables><table name="ORDER_FACT"/><table name="CUST_DIM"/></tables>
  <joins><join cardinality="many-to-one"><expression>"DWH"."ORDER_FACT"."CUST_KEY" = "DWH"."CUST_DIM"."CUST_KEY"</expression></join></joins>
</dataFoundation><businessLayer>
  <object name="Region" type="dimension"><select>CUST_DIM.REGION</select></object>
  <object name="Revenue" type="measure"><select>sum(ORDER_FACT.NET_REVENUE)</select></object>
</businessLayer></universe>`;
const q3 = convertBobjToSigma(xml3, { connectionId: 'conn', database: 'DB', schema: 'S' });
check(q3.stats.relationships === 1, `join: schema-qualified 3-part join → 1 relationship (got ${q3.stats.relationships})`);
check(q3.warnings.every(w => !/0 relationships|0 produced a relationship/.test(w)), 'join: no zero-join guard when a relationship exists');
// The join key must reference the FULL column (CUST_KEY), not a truncated prefix —
// the relationship targets the CUST_DIM element's CUST_KEY hidden column.
const q3els = q3.model.pages[0].elements;
const q3fact = q3els.find(e => e.name === 'Order Fact');
const q3cust = q3els.find(e => e.name === 'Cust Dim');
const q3rel = q3fact?.relationships?.[0];
const q3tgtCol = q3cust?.columns?.find(c => c.id === q3rel?.keys?.[0]?.targetColumnId);
check(/Cust Key/i.test(q3tgtCol?.formula || ''), `join: 3-part key target column is the full CUST_KEY, not truncated (got ${q3tgtCol?.formula})`);

// ── Relationship DIRECTION: the many/fact side must be the source (View base) ──
// In Sigma a relationship is a many→one lookup; if the "one" side is the source,
// every looked-up column fans out to "multiple values". The dimension is on the
// LEFT here, so a naive "left = source" would build the View on the one side.
const srcOf = (els) => els.find(e => e.relationships?.length)?.name;
// (a) cardinality one-to-many (left=one dim, right=many fact) → source = fact.
const dirCard = convertBobjToSigma(`<universe name="D"><dataFoundation>
  <tables><table name="CUST_DIM"/><table name="ORDER_FACT"/></tables>
  <joins><join cardinality="one-to-many"><expression>CUST_DIM.CUST_KEY = ORDER_FACT.CUST_KEY</expression></join></joins>
</dataFoundation><businessLayer>
  <object name="Region" type="dimension"><select>CUST_DIM.REGION</select></object>
  <object name="Revenue" type="measure"><select>sum(ORDER_FACT.NET_REVENUE)</select></object>
</businessLayer></universe>`, { connectionId: 'conn' });
check(srcOf(dirCard.model.pages[0].elements) === 'Order Fact', `direction: one-to-many puts the many/fact side as source (got ${srcOf(dirCard.model.pages[0].elements)})`);
// (b) 1:N symbolic encoding → same result.
const dirSym = convertBobjToSigma(`<universe name="D"><dataFoundation>
  <tables><table name="CUST_DIM"/><table name="ORDER_FACT"/></tables>
  <joins><join cardinality="1:N"><expression>CUST_DIM.CUST_KEY = ORDER_FACT.CUST_KEY</expression></join></joins>
</dataFoundation><businessLayer>
  <object name="Revenue" type="measure"><select>sum(ORDER_FACT.NET_REVENUE)</select></object>
</businessLayer></universe>`, { connectionId: 'conn' });
check(srcOf(dirSym.model.pages[0].elements) === 'Order Fact', `direction: "1:N" encoding recognized (got ${srcOf(dirSym.model.pages[0].elements)})`);
// (c) NO cardinality → infer the many side from measures (the fact bears them).
const dirInfer = convertBobjToSigma(`<universe name="D"><dataFoundation>
  <tables><table name="CUST_DIM"/><table name="ORDER_FACT"/></tables>
  <joins><join><expression>CUST_DIM.CUST_KEY = ORDER_FACT.CUST_KEY</expression></join></joins>
</dataFoundation><businessLayer>
  <object name="Region" type="dimension"><select>CUST_DIM.REGION</select></object>
  <object name="Revenue" type="measure"><select>sum(ORDER_FACT.NET_REVENUE)</select></object>
</businessLayer></universe>`, { connectionId: 'conn' });
check(srcOf(dirInfer.model.pages[0].elements) === 'Order Fact', `direction: no cardinality → measure-bearing fact inferred as source (got ${srcOf(dirInfer.model.pages[0].elements)})`);
// (d) per-side multiplicity attributes compose into a usable cardinality.
const dirMult = convertBobjToSigma(`<universe name="D"><dataFoundation>
  <tables><table name="CUST_DIM"/><table name="ORDER_FACT"/></tables>
  <joins><join leftCardinality="1" rightCardinality="N"><expression>CUST_DIM.CUST_KEY = ORDER_FACT.CUST_KEY</expression></join></joins>
</dataFoundation><businessLayer>
  <object name="Revenue" type="measure"><select>sum(ORDER_FACT.NET_REVENUE)</select></object>
</businessLayer></universe>`, { connectionId: 'conn' });
check(srcOf(dirMult.model.pages[0].elements) === 'Order Fact', `direction: per-side multiplicity attrs (1 / N) compose correctly (got ${srcOf(dirMult.model.pages[0].elements)})`);

// ── Input-kind detection + zero-join guard (silent low-fidelity model) ────────
check(detectBobjInputKind(xml3) === 'sdk-xml', 'input-kind: leading < → sdk-xml');
const outlineJson = JSON.stringify({ name: 'U', tables: ['A', 'B'], objects: [
  { name: 'x', type: 'dimension', select: 'A.X' }, { name: 'y', type: 'dimension', select: 'B.Y' } ] });
check(detectBobjInputKind(outlineJson) === 'json-outline', 'input-kind: joinless JSON → json-outline');
check(detectBobjInputKind(JSON.stringify({ tables: ['A', 'B'], joins: [{ expression: 'A.K=B.K' }] })) === 'json-with-joins',
  'input-kind: JSON with joins[] → json-with-joins');
const guarded = convertBobjToSigma(outlineJson, { connectionId: 'conn' });
check(guarded.stats.relationships === 0, 'guard: multi-table outline → 0 relationships');
check(guarded.warnings.some(w => /Input format: RWS outline JSON/.test(w)), 'guard: outline input surfaces "Input format" note');
check(guarded.warnings.some(w => /No joins in the universe input: 2 tables produced 0 relationships/.test(w)), 'guard: zero-join guard warning fires');

// ── Webi → workbook ──────────────────────────────────────────────────────────
const measureMap = {};
for (const e of els) for (const m of (e.metrics || [])) measureMap[m.name] = m.formula;
const wb = convertWebiToWorkbook(read('fixtures/sample_webi.json'), {
  dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap, schemaVersion: 1,
});
check(wb.workbook.schemaVersion === 1, 'webi: schemaVersion === 1');
check(wb.workbook.kind === 'workbook', 'webi: kind === "workbook" (required by live code-rep)');
check(wb.workbook.pages.length === 2, `webi: ${wb.workbook.pages.length} pages (2)`);
check(wb.stats.kpis === 2 && wb.stats.charts === 2 && wb.stats.pivots === 1, `webi: 2 KPIs / 2 charts / 1 pivot (got ${wb.stats.kpis}/${wb.stats.charts}/${wb.stats.pivots})`);
const allCols = wb.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(allCols.some(c => c.formula === 'Count([Order Fact View/Order Id])'), 'webi: Order Count measure → Count([Order Fact View/Order Id]) (qualified, no circular ref)');
check(!allCols.some(c => /^\[[^\/\]]+\]$/.test(c.formula) && c.name && `[${c.name}]` === c.formula), 'webi: no self-referential (circular) column formulas');

console.log(`\n${failures ? '❌ ' + failures + ' check(s) failed' : '✅ all checks passed'}`);
process.exit(failures ? 1 : 0);
