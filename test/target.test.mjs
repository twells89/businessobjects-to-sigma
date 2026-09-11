import { resolveTarget, targetWritePolicy } from '../scripts/target.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Migration target resolver');
check(resolveTarget('webi').resolvedTarget === 'workbook', 'omitted Webi target resolves to workbook');
check(resolveTarget('webi', 'auto').resolvedTarget === 'workbook', 'auto Webi target resolves to workbook');
check(resolveTarget('crystal').resolvedTarget === 'report', 'omitted Crystal target resolves to report');
check(resolveTarget('crystal', 'auto').resolvedTarget === 'report', 'auto Crystal target resolves to report');
check(resolveTarget('webi', 'report').resolvedTarget === 'report', 'Webi explicitly targets report');
check(resolveTarget('crystal', 'workbook').resolvedTarget === 'workbook', 'Crystal explicitly targets workbook');
check(
  !targetWritePolicy('webi', 'workbook').createFlagRequired,
  'legacy Webi workbook writes do not require --create',
);
check(
  targetWritePolicy('webi', 'report').createFlagRequired
    && targetWritePolicy('crystal', 'workbook').createFlagRequired,
  'new persistent target paths require --create',
);
try {
  resolveTarget('webi', 'dashboard');
  check(false, 'invalid target rejected');
} catch (error) {
  check(/auto, workbook, or report/.test(error.message), 'invalid target rejected');
}

console.log(failures ? `\n❌ ${failures} target check(s) failed` : '\n✅ all target checks passed');
process.exit(failures ? 1 : 0);
