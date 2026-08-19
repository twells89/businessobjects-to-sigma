import { readFileSync } from 'node:fs';
import { crystalSourceToBobj, inferFactTable } from '../converters/crystal-source.mjs';
import { convertBobjToSigma } from '../converters/bobj.mjs';

const ir = JSON.parse(readFileSync('fixtures/crystal/owned-customer-statement.ir.json', 'utf8'));
let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Crystal source adapter');
check(inferFactTable(ir) === 'invoice', 'details infer invoice as the fact table');

const result = crystalSourceToBobj(ir, {
  database: 'CRYSTAL_MIGRATION_DEMO',
  schema: 'PUBLIC',
  includeUnusedFields: true,
});
check(result.stats.tables === 2, 'two direct tables retained');
check(result.stats.fields === 5, 'five physical fields retained');
check(result.stats.joins === 1, 'one Crystal link retained');
check(result.universe.tables.every(table => table.database === 'CRYSTAL_MIGRATION_DEMO'), 'target database remapped');
check(result.universe.tables.every(table => table.schema === 'PUBLIC'), 'target schema remapped');
check(result.universe.joins[0].cardinality === 'many-to-one', 'fact-to-dimension cardinality retained');

const converted = convertBobjToSigma(result, { connectionId: 'CONNECTION' });
check(converted.stats.relationships === 1, 'existing data-model converter emits relationship');
check(converted.stats.columns >= 5, 'existing data-model converter emits physical columns');
check(
  converted.model.pages[0].elements.some(element => element.name === 'Invoice View'),
  'existing data-model converter emits an Invoice View',
);

console.log(failures ? `\n❌ ${failures} Crystal source check(s) failed` : '\n✅ all Crystal source checks passed');
process.exit(failures ? 1 : 0);

