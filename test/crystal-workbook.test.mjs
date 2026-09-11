import { readFileSync } from 'node:fs';
import {
  buildValidatedCrystalDataModelFieldMap,
  convertCrystalToWorkbook,
} from '../converters/crystal.mjs';
import {
  document,
  workbookElements,
  workbookPageElementIds,
} from '../scripts/code_rep.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Crystal → Sigma workbook first draft');
const ir = JSON.parse(readFileSync('fixtures/crystal/owned-customer-statement.ir.json', 'utf8'));
const wideFieldMap = {
  'customer-customer-id': 'customer_customer_id',
  'customer-name': 'customer_name',
  'invoice-invoice-id': 'invoice_id',
  'invoice-customer-id': 'invoice_customer_id',
  'invoice-amount-gross': 'amount_gross',
};
const result = convertCrystalToWorkbook(ir, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
  database: 'CRYSTAL_MIGRATION_DEMO',
  schema: 'PUBLIC',
  sourceTable: 'CUSTOMER_STATEMENT_ROWS',
  sourceName: 'CUSTOMER_STATEMENT_ROWS',
  fieldMap: wideFieldMap,
  schemaVersion: 2,
});
const workbook = result.workbook;
const doc = document(workbook);
const elements = workbookElements(workbook);
const table = elements.find(element => element.kind === 'table');

check(workbook.name.endsWith('(Interactive)'), 'workbook metadata identifies interactive target');
check(doc.kind === 'workbook' && doc.schemaVersion === 2, 'current wrapped workbook document emitted');
check(Array.isArray(doc.elements) && !('elements' in doc.pages[0]), 'elements are flat and pages are metadata-only');
check(
  workbookPageElementIds(workbook)[doc.pages[0].id]?.length === doc.elements.length,
  'stacked layout places every current workbook element',
);
check(table?.source?.kind === 'warehouse-table', 'existing warehouse binding is reused');
check(
  table?.source?.path?.join('.') === 'CRYSTAL_MIGRATION_DEMO.PUBLIC.CUSTOMER_STATEMENT_ROWS',
  'workbook targets the requested warehouse path',
);
check(
  table?.columns?.some(column => column.formula === '[CUSTOMER_STATEMENT_ROWS/amount_gross]'),
  'Crystal IR fields become source-bound workbook columns',
);
check(
  table?.columns?.some(column => column.name === 'Balance' && /\[Amount Gross\].*\[PaidAmount\]/.test(column.formula)),
  'translated Crystal formulas become workbook calculated columns',
);
check(
  !table?.groupings && !table?.columns?.some(column => /^summary-/.test(column.id)),
  'detail table remains ungrouped and does not absorb grouped summaries',
);
check(
  !elements.some(element => element.kind === 'control')
    && result.degradationLedger.some(item =>
      item.sourceType === 'parameter' && item.disposition === 'omitted-unbound-control'),
  'unknown parameter domains are omitted instead of emitting inert controls',
);
const parameterFormulaIr = structuredClone(ir);
parameterFormulaIr.data.formulas.push({
  name: 'Parameter Driven',
  text: '{invoice.amount_gross} >= {?MinimumBalance}',
  syntax: 'crystal',
});
const parameterFormulaResult = convertCrystalToWorkbook(parameterFormulaIr, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
  database: 'CRYSTAL_MIGRATION_DEMO',
  schema: 'PUBLIC',
  sourceTable: 'CUSTOMER_STATEMENT_ROWS',
  fieldMap: wideFieldMap,
});
const parameterFormulaTable = workbookElements(parameterFormulaResult.workbook)
  .find(element => element.kind === 'table');
check(
  !parameterFormulaTable.columns.some(column => column.name === 'Parameter Driven')
    && parameterFormulaResult.degradationLedger.some(item =>
      item.sourceId === 'Parameter Driven' && item.disposition === 'not-emitted-unbound-parameter'),
  'formulas cannot retain references to omitted parameter controls',
);
check(
  result.degradationLedger.some(item =>
    item.sourceType === 'group' && item.disposition === 'not-emitted-detail-preserved')
    && result.degradationLedger.some(item =>
      item.sourceType === 'summary' && item.disposition === 'not-emitted-grain-redesign'),
  'groups and summaries explicitly require separate-element redesign',
);
check(
  result.adaptation.pagination.disposition === 'responsive-single-page'
    && result.adaptation.panels.length === 2
    && result.adaptation.layout.target === 'stacked-responsive-grid',
  'pagination, panels, and fixed geometry adaptations are recorded',
);
check(
  result.degradationLedger.some(item => item.sourceType === 'source-topology')
    && result.degradationLedger.some(item => item.sourceType === 'parameter'),
  'unsupported source topology and control scope remain explicit degradations',
);

try {
  convertCrystalToWorkbook(ir, { connectionId: 'CONNECTION' });
  check(false, 'multi-table IR rejects implicit warehouse collapse');
} catch (error) {
  check(/explicit wide warehouse source/.test(error.message), 'multi-table IR rejects implicit warehouse collapse');
}

try {
  convertCrystalToWorkbook(ir, {
    connectionId: 'CONNECTION',
    database: 'ANALYTICS',
    schema: 'PUBLIC',
    sourceTable: 'WIDE_REPORT_ROWS',
  });
  check(false, 'multi-table wide source rejects missing per-field map');
} catch (error) {
  check(/per-field mapping/.test(error.message), 'multi-table wide source rejects missing per-field map');
}

try {
  convertCrystalToWorkbook(ir, {
    dataModelId: 'DM',
    dataModelElementId: 'ELEMENT',
  });
  check(false, 'data-model binding requires sourceName');
} catch (error) {
  check(/explicit sourceName/.test(error.message), 'data-model binding requires sourceName');
}

const dataModelResult = convertCrystalToWorkbook(ir, {
  folderId: 'FOLDER',
  dataModelId: 'DM',
  dataModelElementId: 'ELEMENT',
  sourceName: 'Crystal Wide View',
  fieldMap: wideFieldMap,
});
const dataModelTable = workbookElements(dataModelResult.workbook)
  .find(element => element.kind === 'table');
check(
  dataModelTable?.source?.kind === 'data-model'
    && dataModelTable.source.dataModelId === 'DM'
    && dataModelTable.columns[0].formula.startsWith('[Crystal Wide View/'),
  'complete data-model binding supports multi-table IR with explicit sourceName',
);

const validatedMapping = buildValidatedCrystalDataModelFieldMap(ir, {
  pages: [{
    elements: [{
      id: 'ELEMENT',
      name: 'Crystal Wide View',
      columns: Object.values(wideFieldMap).map((name, index) => ({
        id: `dm-column-${index}`,
        name,
      })),
    }],
  }],
}, {
  dataModelElementId: 'ELEMENT',
  sourceName: 'Crystal Wide View',
  fieldMap: wideFieldMap,
});
check(
  validatedMapping.validatedColumns === ir.data.fields.length
    && validatedMapping.fieldMap['invoice-amount-gross'] === 'amount_gross',
  'explicit data-model field map is validated against readback columns',
);
const inferredDataModelMapping = buildValidatedCrystalDataModelFieldMap(ir, {
  pages: [{
    elements: [{
      id: 'ELEMENT',
      name: 'Crystal Wide View',
      columns: ir.data.fields.map((field, index) => ({
        id: `dm-exact-${index}`,
        name: field.id,
      })),
    }],
  }],
}, {
  dataModelElementId: 'ELEMENT',
  sourceName: 'Crystal Wide View',
});
check(
  inferredDataModelMapping.fieldMap['invoice-amount-gross'] === 'invoice-amount-gross',
  'exact unique data-model readback names provide a validated mapping without invented aliases',
);

const aggregateIr = structuredClone(ir);
aggregateIr.data.formulas.push({
  name: 'Invoice Total',
  text: 'Sum({invoice.amount_gross})',
  syntax: 'crystal',
});
const aggregateResult = convertCrystalToWorkbook(aggregateIr, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
  database: 'ANALYTICS',
  schema: 'PUBLIC',
  sourceTable: 'WIDE_REPORT_ROWS',
  fieldMap: wideFieldMap,
});
const aggregateTable = workbookElements(aggregateResult.workbook)
  .find(element => element.kind === 'table');
check(
  !aggregateTable.columns.some(column => column.name === 'Invoice Total')
    && aggregateResult.degradationLedger.some(item =>
      item.sourceId === 'Invoice Total'
      && item.disposition === 'not-emitted-aggregate-detail-grain'),
  'aggregate formulas are not emitted into the ungrouped detail table',
);

const singleTableIr = structuredClone(ir);
singleTableIr.data.tables = [ir.data.tables.find(item => item.name === 'invoice')];
singleTableIr.data.fields = ir.data.fields.filter(field => field.table === 'invoice');
singleTableIr.data.links = [];
singleTableIr.data.groups = [];
singleTableIr.data.summaries = [];
const singleTableResult = convertCrystalToWorkbook(singleTableIr, {
  folderId: 'FOLDER',
  connectionId: 'CONNECTION',
});
const singleTable = workbookElements(singleTableResult.workbook)
  .find(element => element.kind === 'table');
check(
  singleTable?.source?.path?.join('.') === 'MERIDIAN.PUBLIC.invoice',
  'single-table IR warehouse path defaults come from that IR table',
);

console.log(failures ? `\n❌ ${failures} Crystal workbook check(s) failed` : '\n✅ all Crystal workbook checks passed');
process.exit(failures ? 1 : 0);
