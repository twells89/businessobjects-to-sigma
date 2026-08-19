import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { convertPettyCashToReport } from '../converters/crystal-pettycash.mjs';
import { validateReportSpec } from '../scripts/report-code-rep.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('PettyCash Crystal → Sigma report integration');
const schema = JSON.parse(readFileSync('schemas/crystal-report-ir.schema.json', 'utf8'));
const fixture = JSON.parse(
  readFileSync('fixtures/crystal/owned-pettycash-monthly.ir.json', 'utf8'),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validateIr = ajv.compile(schema);
check(
  validateIr(fixture),
  `owned PettyCash IR validates${validateIr.errors ? `: ${JSON.stringify(validateIr.errors)}` : ''}`,
);

const result = convertPettyCashToReport(fixture, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
  database: 'CRYSTAL_MIGRATION_DEMO',
  schema: 'PUBLIC',
  sourceTable: 'PETTYCASH_MONTHLY_REPORT_ROWS',
  reportName: 'PettyCash Monthly Report',
});
const report = result.report;
const offline = validateReportSpec(report);
check(offline.valid, `Sigma report passes offline validation: ${offline.errors.join('; ')}`);
check(
  report.document.config.pageWidth === 816
    && report.document.config.pageHeight === 1056
    && report.document.config.margin === 24,
  'Letter page and quarter-inch Crystal margins are preserved',
);

const detail = report.document.elements.find(element => element.id === 'pettycash-detail');
check(detail?.source?.kind === 'warehouse-table', 'detail rows use a warehouse table');
check(
  detail?.source?.path?.join('.')
    === 'CRYSTAL_MIGRATION_DEMO.PUBLIC.PETTYCASH_MONTHLY_REPORT_ROWS',
  'detail rows target the isolated PettyCash seed',
);
check(detail?.columns?.length === 7, 'all seven Crystal detail columns are emitted');
check(
  detail?.columns?.find(column => column.id === 'pettycash-col-entry-date')
    ?.format?.formatString === '%d/%m/%Y',
  'Crystal day/month/year date display is preserved',
);
check(
  detail?.columns?.find(column => column.id === 'pettycash-col-receipt')
    ?.formula === '[PETTYCASH_MONTHLY_REPORT_ROWS/RECEIPT_NO]',
  'receipt identifiers remain text-backed source values',
);
check(
  report.document.elements.some(
    element => element.id === 'pettycash-logo' && /PettyCash/.test(element.body),
  ),
  'logo fallback is explicitly represented',
);
check(
  report.document.panels.some(panel => panel.type === 'footer'),
  'Crystal page footer becomes a report footer panel',
);
check(
  result.degradationLedger.some(
    item => item.disposition === 'reconstructed-public-oracle',
  ),
  'missing saved data is disclosed in the degradation ledger',
);
const geometry = [
  ...report.document.layout.matchAll(/\b(?:x|y|width|height)="([^"]+)"/g),
].map(match => match[1]);
check(
  geometry.length > 0 && geometry.every(value => /^\d+$/.test(value)),
  'layout geometry uses integer pixels',
);

console.log(
  failures
    ? `\n❌ ${failures} PettyCash integration check(s) failed`
    : '\n✅ all PettyCash integration checks passed',
);
process.exit(failures ? 1 : 0);
