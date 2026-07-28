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

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
