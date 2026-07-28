#!/usr/bin/env node
/**
 * Offline unit test — pure merge logic (no network) for applying
 * dataModelAdditions into a DM spec's View element.
 *   node test/dm-merge.test.mjs   (or npm test)
 */
import { mergeAdditionsIntoView } from '../scripts/dm-merge.mjs';
let failures = 0; const check = (c, m) => { console.log(`${c?'✅':'❌'} ${m}`); if (!c) failures++; };

const spec = { pages: [{ elements: [ { id: 'VIEW', name: 'Order Fact View', columns: [{ id: 'c1', name: 'Net Revenue', formula: '[.../Net Revenue]' }], metrics: [] } ] }] };
const additions = { metrics: [{ id: 'a1', name: 'Margin Pct', formula: 'X' }, { id: 'a2', name: 'Net Revenue', formula: 'DUP' }], columns: [] };
const res = mergeAdditionsIntoView(spec, 'VIEW', additions);
const view = spec.pages[0].elements[0];
check(view.metrics.some(m => m.name === 'Margin Pct'), 'new metric added to View');
check(!view.metrics.some(m => m.name === 'Net Revenue'), 'metric duplicating an existing column name is skipped');
check(res.skipped.includes('Net Revenue'), 'skip is reported');

// NESTED shape — some DM-spec GET responses wrap pages under `spec.spec.pages`
// rather than a flat `spec.pages` (migrate-universe.mjs already hedges against
// this same uncertainty at line 83: `spec.pages || spec.spec?.pages || []`).
// The merge must find the View element either way.
const nestedSpec = { spec: { pages: [{ elements: [ { id: 'VIEW', name: 'Order Fact View', columns: [], metrics: [] } ] }] } };
const nestedAdditions = { metrics: [{ id: 'a1', name: 'Margin Pct', formula: 'X' }], columns: [] };
mergeAdditionsIntoView(nestedSpec, 'VIEW', nestedAdditions);
const nestedView = nestedSpec.spec.pages[0].elements[0];
check(nestedView.metrics.some(m => m.name === 'Margin Pct'), 'nested spec.spec.pages shape resolves the View element too');

console.log(`\n${failures?'❌ '+failures+' failed':'✅ all passed'}`); process.exit(failures?1:0);
