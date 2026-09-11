import { parseCrystalArgs } from '../scripts/migrate-crystal.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Crystal CLI argument parsing');

let parsed = parseCrystalArgs([
  '--target', 'workbook',
  '--database', 'ANALYTICS',
  '--schema', 'PUBLIC',
  '--source-table', 'WIDE_REPORT_ROWS',
]);
check(parsed.irPath == null, 'option values are not mistaken for positional IR paths');

parsed = parseCrystalArgs([
  '--target', 'workbook',
  'report.crystal-ir.json',
  '--source-table', 'WIDE_REPORT_ROWS',
  '--field-map', 'wide-fields.json',
]);
check(parsed.irPath === 'report.crystal-ir.json', 'explicit positional IR path is retained');
check(parsed.value('--source-table') === 'WIDE_REPORT_ROWS', 'value flags retain their values');
check(parsed.value('--field-map') === 'wide-fields.json', 'field-map option value is consumed');

parsed = parseCrystalArgs([
  '--ir', 'explicit.json',
  '--target', 'report',
  '--create',
]);
check(parsed.irPath === 'explicit.json', '--ir takes precedence');
check(parsed.has('--create'), 'boolean flags are retained');

try {
  parseCrystalArgs(['--target', 'workbook', '--source-table']);
  check(false, 'missing option value is rejected');
} catch (error) {
  check(/requires a value/.test(error.message), 'missing option value is rejected');
}

try {
  parseCrystalArgs(['one.json', 'two.json']);
  check(false, 'multiple positional paths are rejected');
} catch (error) {
  check(/Unexpected positional/.test(error.message), 'multiple positional paths are rejected');
}

try {
  parseCrystalArgs(['--ir', 'one.json', 'two.json']);
  check(false, '--ir plus positional path is rejected');
} catch (error) {
  check(/with --ir/.test(error.message), '--ir plus positional path is rejected');
}

console.log(failures ? `\n❌ ${failures} CLI parsing check(s) failed` : '\n✅ all CLI parsing checks passed');
process.exit(failures ? 1 : 0);
