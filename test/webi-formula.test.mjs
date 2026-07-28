#!/usr/bin/env node
/** Offline unit tests for the Webi → Sigma formula engine. */
import { translateWebiFormula } from '../converters/webi-formula.mjs';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };
const eq = (formula, expected, msg, opts) => {
  const r = translateWebiFormula(formula, opts);
  check(r.sigma === expected, `${msg}  (got: ${r.sigma})`);
  return r;
};

// ── Tier 1: direct function map + operators ──────────────────────────────────
eq('=[Revenue] - [Cost]', '[Revenue] - [Cost]', 'strips leading = and keeps subtraction');
eq('=[Revenue] / [Quantity]', '[Revenue] / [Quantity]', 'division passes through');
eq('=Average([Revenue])', 'Avg([Revenue])', 'Average → Avg');
eq('=Substr([Name]; 1; 3)', 'Mid([Name], 1, 3)', 'Substr → Mid, ; → ,');
eq('=Upper([Region]) + " " + Lower([City])', 'Upper([Region]) & " " & Lower([City])', 'text + → &, Upper/Lower kept');
eq('=If([Revenue] > 0 ; "Pos" ; "Neg")', 'If([Revenue] > 0, "Pos", "Neg")', 'If with ; separators → , ');
eq('=Sum([Revenue]) / Count([Order Id])', 'Sum([Revenue]) / Count([Order Id])', 'nested aggregates preserved');

// kind inference
check(translateWebiFormula('=Sum([Revenue])').kind === 'measure', 'outer aggregate → kind measure');
check(translateWebiFormula('=[Region]', { qualification: 'dimension' }).kind === 'dimension', 'qualification dimension respected');
check(translateWebiFormula('=[Revenue] - [Cost]').placement === 'dm', 'context-free → placement dm');

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
