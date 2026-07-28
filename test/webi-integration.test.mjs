#!/usr/bin/env node
/**
 * Offline integration test — variables IR → translateWebiFormula →
 * dataModelAdditions / workbook calc columns, wired through webi.mjs.
 *   node test/webi-integration.test.mjs   (or npm test)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertWebiToWorkbook } from '../converters/webi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

const r = convertWebiToWorkbook(read('fixtures/sample_webi_variables.json'), {
  dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View',
  measureMap: { 'Net Revenue': 'Sum([Net Revenue])', 'Gross Revenue': 'Sum([Gross Revenue])' }, schemaVersion: 1,
});

// context-free measure → data-model addition (metric). Its formula is BARE
// (same-element sibling ref), NOT qualified by the source name — it lands ON
// the "Order Fact View" element itself, so `Sum([Order Fact View/Net
// Revenue])` placed there would be a self-referential cross-element path.
// This mirrors converters/bobj.mjs::translateBobjExpr, which emits the same
// same-element metric/calc-column formulas bare (`Sum([Col])`, never
// `[TableView/Col]`).
check(r.dataModelAdditions.metrics.some(m => m.name === 'Margin Pct' && /^Sum\(\[Net Revenue\]\) \/ Sum\(\[Gross Revenue\]\)$/.test(m.formula)),
  'Margin Pct → dataModelAdditions.metric, BARE same-element formula (Sum([Net Revenue]) / Sum([Gross Revenue]))');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Running Revenue'), 'Running Revenue is NOT a DM addition (it is layout-dependent)');

// layout-dependent → workbook element calc column
const cols = r.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(cols.some(c => c.name === 'Running Revenue' && /CumulativeSum/.test(c.formula)), 'Running Revenue → workbook calc column (CumulativeSum)');

// Workbook calc-column refs ARE qualified by the source element name (a
// workbook element reaching INTO the View from the outside) — no circular refs.
check(cols.every(c => !(c.name && `[${c.name}]` === c.formula)), 'no self-referential column formulas');
// DM-addition formulas are the OPPOSITE: BARE, never qualified by source name
// — see the comment on the Margin Pct assertion above.
check(r.dataModelAdditions.metrics.every(m => !/Order Fact View\//.test(m.formula)), 'DM-addition metric formulas are BARE (no source-name qualifier)');
check(r.dataModelAdditions.columns.every(c => !/Order Fact View\//.test(c.formula)), 'DM-addition column formulas are BARE (no source-name qualifier)');

// DM-addition MEASURE resolves at the block column to the INLINE translated+
// qualified formula (re-aggregating the raw View columns, exactly like a base
// measure), NOT the metric by column-path: a DM metric is NOT addressable as
// [Element/MetricName] from a workbook (live-verified in Task 8 — POST
// /v2/workbooks/spec 400s "Dependency not found: 'order fact view/margin
// pct'"); the raw View columns it re-aggregates DO resolve. The metric itself
// still lands in the DM (governance/reuse) via dataModelAdditions.metrics, BARE.
const mcol = cols.find(c => c.name === 'Margin Pct');
check(mcol && /^Sum\(\[Order Fact View\/Net Revenue\]\) \/ Sum\(\[Order Fact View\/Gross Revenue\]\)$/.test(mcol.formula),
  'Margin Pct block col → inline re-aggregated raw View columns (Sum([.../Net Revenue]) / Sum([.../Gross Revenue])) — QUALIFIED, workbook context');
check(mcol && !/\[Order Fact View\/Margin Pct\]/.test(mcol.formula),
  'Margin Pct block col does NOT reference the metric by column-path (that 400s at workbook POST)');

// Dimension variable lands in the columns bucket (not metrics); its DM-addition
// formula is BARE (same-element sibling ref to [Customer Region]); the
// workbook block column that uses it resolves to a QUALIFIED ref (workbook
// reaching into the View) — same bare-in-DM/qualified-in-workbook split as the
// measure case above.
check(r.dataModelAdditions.columns.some(c => c.name === 'Region Bucket'), 'dimension variable → dataModelAdditions.columns');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Region Bucket'), 'dimension variable NOT in metrics bucket');
const rbAdd = r.dataModelAdditions.columns.find(c => c.name === 'Region Bucket');
check(rbAdd && /^If\(\[Customer Region\] = "West", "West", "Other"\)$/.test(rbAdd.formula),
  'Region Bucket DM-addition formula is BARE same-element ref (If([Customer Region] = "West", "West", "Other"))');
const rcol = cols.find(c => c.name === 'Region Bucket');
check(rcol && /^\[Order Fact View\/Region Bucket\]$/.test(rcol.formula), 'Region Bucket block dim → QUALIFIED DM ref (workbook referencing the bound View)');

// element-level in-place formula (not a named variable) is retained on the block column
const r2 = convertWebiToWorkbook({ document: { name: 'D', reports: [ { name: 'R', blocks: [
  { kind: 'VTable', title: 'T', dimensions: [{ name: 'Bucket', formula: '=If([Revenue] > 1000 ; "High" ; "Low")' }], measures: ['Net Revenue'] } ] } ], variables: [], filters: [] } },
  { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
const r2cols = r2.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(r2cols.some(c => c.name === 'Bucket' && /If\(\[Order Fact View\/Revenue\] > 1000, "High", "Low"\)/.test(c.formula)), 'block-column dataExpression formula translated + qualified');

// RAW Raylight element tree (reports carry `.elements`, NOT a pre-flattened
// `.blocks`) — this is the shape getWebiDocument() actually produces on the
// live migrate-webi.mjs path, routed through walkRaylight() rather than
// normalizeBlock(). A dataExpression-carried inline formula on a dimension
// must translate + qualify here too, exactly as it does on the friendly shape.
const r3 = convertWebiToWorkbook({ document: { name: 'D', reports: [ { name: 'R', elements: [
  { type: 'VTable', name: 'T', dataExpressions: [
    { name: 'Bucket', qualification: 'dimension', dataExpression: '=If([Revenue] > 1000 ; "High" ; "Low")' },
    { name: 'Net Revenue', qualification: 'measure' },
  ] } ] } ], variables: [], filters: [] } },
  { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
const r3cols = r3.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(r3cols.some(c => c.name === 'Bucket' && /If\(\[Order Fact View\/Revenue\] > 1000, "High", "Low"\)/.test(c.formula)), 'RAW Raylight (walkRaylight) dataExpression formula translated + qualified');

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
