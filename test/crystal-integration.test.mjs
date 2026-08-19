import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { convertCrystalToReport } from '../converters/crystal.mjs';
import { validateReportSpec } from '../scripts/report-code-rep.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Crystal → Sigma report integration');
const schema = JSON.parse(readFileSync('schemas/crystal-report-ir.schema.json', 'utf8'));
const fixture = JSON.parse(readFileSync('fixtures/crystal/owned-customer-statement.ir.json', 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
const validateIr = ajv.compile(schema);
check(validateIr(fixture), `owned Crystal IR validates${validateIr.errors ? `: ${JSON.stringify(validateIr.errors)}` : ''}`);

const result = convertCrystalToReport(fixture, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
  database: 'CRYSTAL_MIGRATION_DEMO',
  schema: 'PUBLIC',
  sourceTable: 'CUSTOMER_STATEMENT_ROWS',
  reportName: 'Owned Crystal Statement',
  profile: 'meridian-customer-statement',
});
const report = result.report;
const offline = validateReportSpec(report);
check(offline.valid, `Sigma report passes offline validation: ${offline.errors.join('; ')}`);
check(report.document.kind === 'report', 'emits kind: report (not workbook)');
check(report.document.config.pageWidth === Math.round(fixture.page.widthTwips / 15), 'twip page width converted at 96 DPI');
check(report.document.config.pageHeight === Math.round(fixture.page.heightTwips / 15), 'twip page height converted at 96 DPI');
check(report.document.panels.some(panel => panel.type === 'header'), 'page header becomes report header panel');
check(report.document.panels.some(panel => panel.type === 'footer'), 'page footer becomes report footer panel');
check(!/gridColumn|Container/.test(report.document.layout), 'emits absolute pixel layout only');

const table = report.document.elements.find(element => element.id === 'statement-detail');
check(table?.source?.kind === 'warehouse-table', 'detail table uses live-proven report warehouse source');
check(
  table?.source?.path?.join('.') === 'CRYSTAL_MIGRATION_DEMO.PUBLIC.CUSTOMER_STATEMENT_ROWS',
  'detail table targets isolated Snowflake wide view',
);
check(table?.columns.some(column => column.formula === '[CUSTOMER_STATEMENT_ROWS/INVOICE_NUMBER]'), 'invoice source column emitted');
check(table?.groupings?.[0]?.groupBy?.length === 1, 'Crystal customer group becomes Sigma table grouping');

const kpi = report.document.elements.find(element => element.id === 'statement-total');
check(kpi?.kind === 'kpi-chart', 'report total becomes KPI');
check(kpi?.columns?.[0]?.formula === 'Sum([CUSTOMER_STATEMENT_ROWS/USD_BALANCE])', 'report total aggregates live Snowflake value');

check(result.formulas.length === fixture.data.formulas.length, 'every Crystal formula is inventoried');
check(result.dataModelAdditions.columns.some(column => column.name === 'Balance'), 'context-free Crystal formula offered as governed DM addition');
check(result.degradationLedger.some(item => item.sourceId === 'MinimumBalance'), 'unwired Crystal parameter is explicit degradation');
check(result.stats.degradations === result.degradationLedger.length, 'degradation census is internally consistent');

console.log(failures ? `\n❌ ${failures} Crystal integration check(s) failed` : '\n✅ all Crystal integration checks passed');
process.exit(failures ? 1 : 0);

