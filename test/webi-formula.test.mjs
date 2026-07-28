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
check(translateWebiFormula('=Sum([Revenue]) / Count([Order Id])').kind === 'measure', 'ratio of aggregates → kind measure');
check(translateWebiFormula('=[Region]').kind === 'dimension', 'bare ref, no qualification → kind dimension');

// ── Tier 2: layout / window family → placement workbook ──────────────────────
const prev = eq('=Previous([Revenue])', 'Lag([Revenue])', 'Previous → Lag');
check(prev.placement === 'workbook', 'Previous forces placement workbook');
eq('=RunningSum([Revenue])', 'CumulativeSum([Revenue])', 'RunningSum → CumulativeSum');
check(translateWebiFormula('=RunningSum([Revenue])').placement === 'workbook', 'RunningSum forces placement workbook');
eq('=RunningCount([Order Id])', 'CumulativeCount([Order Id])', 'RunningCount → CumulativeCount');
check(translateWebiFormula('=RunningCount([Order Id])').placement === 'workbook', 'RunningCount forces placement workbook');
eq('=Rank([Revenue])', 'Rank([Revenue])', 'Rank → Rank');
eq('=Percentage([Revenue])', 'PercentOfTotal([Revenue])', 'Percentage → PercentOfTotal');
check(translateWebiFormula('=Percentage([Revenue])').placement === 'workbook', 'Percentage forces placement workbook');
check(translateWebiFormula('=Rank([Revenue])').placement === 'workbook', 'Rank forces placement workbook');

const ra = translateWebiFormula('=RunningAverage([Revenue])');
check(ra.sigma === '(CumulativeSum([Revenue]) / CumulativeCount([Revenue]))', 'RunningAverage → CumulativeSum/CumulativeCount ratio');
check(ra.placement === 'workbook', 'RunningAverage forces placement workbook');
check(ra.warnings.some(w => /RunningAverage/i.test(w)), 'RunningAverage emits a verify warning');

// ── Tier 3: context operators ────────────────────────────────────────────────
const inCtx = translateWebiFormula('=Sum([Revenue]) In ([Region])');
check(inCtx.placement === 'workbook', 'In context forces placement workbook');
check(/Sum\(\[Revenue\]\)/.test(inCtx.sigma), 'In: base aggregate preserved');
check(inCtx.warnings.some(w => /context .*In.*Region/i.test(w)), 'In: emits a grouping warning naming the dims');
const feCtx = translateWebiFormula('=RunningSum([Revenue]) ForEach ([Month])');
check(feCtx.warnings.some(w => /ForEach/i.test(w)), 'ForEach warns for manual grouping/reset review');
check(feCtx.placement === 'workbook', 'ForEach forces placement workbook');
check(translateWebiFormula('=Sum([Revenue]) foreach ([Month])').warnings.some(w => /ForEach/.test(w)), 'lowercase foreach → canonical ForEach in warning');

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
