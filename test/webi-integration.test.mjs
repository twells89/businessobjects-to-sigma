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

// context-free measure → data-model addition (metric), qualified by source name
check(r.dataModelAdditions.metrics.some(m => m.name === 'Margin Pct' && /PercentOfTotal|\/ Sum/.test(m.formula)), 'Margin Pct → dataModelAdditions.metric');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Running Revenue'), 'Running Revenue is NOT a DM addition (it is layout-dependent)');

// layout-dependent → workbook element calc column
const cols = r.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(cols.some(c => c.name === 'Running Revenue' && /CumulativeSum/.test(c.formula)), 'Running Revenue → workbook calc column (CumulativeSum)');

// refs are qualified by the source element name, no circular refs
check(cols.every(c => !(c.name && `[${c.name}]` === c.formula)), 'no self-referential column formulas');
check(r.dataModelAdditions.metrics.every(m => /Order Fact View\//.test(m.formula)), 'DM-addition formulas qualified by source name');

// DM-addition measure resolves at the block column to the qualified DM ref, not Sum([...])
const mcol = cols.find(c => c.name === 'Margin Pct');
check(mcol && /^\[Order Fact View\/Margin Pct\]$/.test(mcol.formula), 'Margin Pct block col → qualified DM ref [Order Fact View/Margin Pct]');
check(mcol && !/Sum\(/.test(mcol.formula), 'Margin Pct block col is NOT Sum([Margin Pct])');

// dimension variable lands in the columns bucket (not metrics) and resolves to a qualified ref
check(r.dataModelAdditions.columns.some(c => c.name === 'Region Bucket'), 'dimension variable → dataModelAdditions.columns');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Region Bucket'), 'dimension variable NOT in metrics bucket');
const rcol = cols.find(c => c.name === 'Region Bucket');
check(rcol && /^\[Order Fact View\/Region Bucket\]$/.test(rcol.formula), 'Region Bucket block dim → qualified DM ref');

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
