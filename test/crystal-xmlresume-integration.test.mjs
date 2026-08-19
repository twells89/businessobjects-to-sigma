import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { convertXmlResumeToReport } from '../converters/crystal-xmlresume.mjs';
import { validateReportSpec } from '../scripts/report-code-rep.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('XML Résumé Crystal → Sigma report integration');
const schema = JSON.parse(readFileSync('schemas/crystal-report-ir.schema.json', 'utf8'));
const fixture = JSON.parse(readFileSync('fixtures/crystal/owned-xmlresume.ir.json', 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validateIr = ajv.compile(schema);
check(
  validateIr(fixture),
  `owned résumé IR validates${validateIr.errors ? `: ${JSON.stringify(validateIr.errors)}` : ''}`,
);

const result = convertXmlResumeToReport(fixture, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
  database: 'CRYSTAL_MIGRATION_DEMO',
  schema: 'PUBLIC',
  reportName: 'XML Résumé',
});
const report = result.report;
const offline = validateReportSpec(report);
check(offline.valid, `Sigma report passes offline validation: ${offline.errors.join('; ')}`);
check(
  report.document.config.pageWidth === 792
    && report.document.config.pageHeight === 1123,
  'PDF-derived A4 page geometry is preserved',
);
check(
  report.document.elements.some(
    element => element.id === 'xmlresume-name' && /FIRST LAST/.test(element.body),
  ),
  'profile header is represented',
);

const dataElements = report.document.elements.filter(
  element => element.source?.kind === 'warehouse-table',
);
check(dataElements.length === 3, 'three Crystal subreports become three data elements');
check(
  dataElements.map(element => element.source.path.at(-1)).join(',')
    === 'XMLRESUME_DEGREES,XMLRESUME_CERTIFICATIONS,XMLRESUME_PROJECT_LINES',
  'subreport data binds to isolated XML résumé tables',
);
const projects = dataElements.find(element => element.id === 'xmlresume-projects');
check(
  projects?.sort?.map(item => item.columnId).join(',')
    === 'xmlresume-col-project-sort,xmlresume-col-line-sort',
  'projects preserve deterministic nested order',
);
check(
  report.document.elements.some(element => element.kind === 'divider'),
  'Crystal name rule becomes a horizontal divider',
);
check(
  result.degradationLedger.some(
    item => item.disposition === 'flattened-warehouse-tables',
  ),
  'subreport flattening is explicit in the degradation ledger',
);
check(
  result.stats.sourceSubreports === 3,
  'source subreport census is retained',
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
    ? `\n❌ ${failures} XML résumé integration check(s) failed`
    : '\n✅ all XML résumé integration checks passed',
);
process.exit(failures ? 1 : 0);
