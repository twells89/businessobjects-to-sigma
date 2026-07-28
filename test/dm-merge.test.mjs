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
console.log(`\n${failures?'❌ '+failures+' failed':'✅ all passed'}`); process.exit(failures?1:0);
