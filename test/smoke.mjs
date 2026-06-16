#!/usr/bin/env node
/**
 * Offline smoke test — no network. Runs both converters on the bundled fixtures
 * and asserts the output shape. Exits non-zero on any failure.
 *   node test/smoke.mjs   (or npm test)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertBobjToSigma } from '../converters/bobj.mjs';
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

// ── Webi → workbook ──────────────────────────────────────────────────────────
const measureMap = {};
for (const e of els) for (const m of (e.metrics || [])) measureMap[m.name] = m.formula;
const wb = convertWebiToWorkbook(read('fixtures/sample_webi.json'), {
  dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap, schemaVersion: 1,
});
check(wb.workbook.schemaVersion === 1, 'webi: schemaVersion === 1');
check(wb.workbook.pages.length === 2, `webi: ${wb.workbook.pages.length} pages (2)`);
check(wb.stats.kpis === 2 && wb.stats.charts === 2 && wb.stats.pivots === 1, `webi: 2 KPIs / 2 charts / 1 pivot (got ${wb.stats.kpis}/${wb.stats.charts}/${wb.stats.pivots})`);
const allCols = wb.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(allCols.some(c => c.formula === 'Count([Order Fact View/Order Id])'), 'webi: Order Count measure → Count([Order Fact View/Order Id]) (qualified, no circular ref)');
check(!allCols.some(c => /^\[[^\/\]]+\]$/.test(c.formula) && c.name && `[${c.name}]` === c.formula), 'webi: no self-referential (circular) column formulas');

console.log(`\n${failures ? '❌ ' + failures + ' check(s) failed' : '✅ all checks passed'}`);
process.exit(failures ? 1 : 0);
