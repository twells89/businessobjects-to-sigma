import {
  buildAbsoluteLayout,
  normalizeReportForComparison,
  prepareReportForPost,
  prepareReportForUpdate,
  reportDocument,
  reportMetadata,
  validateReportSpec,
} from '../scripts/report-code-rep.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Sigma report code representation');
const layout = buildAbsoluteLayout({
  pages: [{ id: 'p1' }],
  panels: [{ id: 'head', type: 'header' }],
  placements: [
    { rootId: 'p1', rootType: 'page', elementId: 'title', x: 48, y: 48, width: 720, height: 48 },
    { rootId: 'head', rootType: 'panel', elementId: 'head-text', x: 48, y: 8, width: 720, height: 20 },
  ],
});
check(layout.includes('<Page id="p1">'), 'layout emits Page root');
check(layout.includes('<Panel id="head" type="header">'), 'layout emits typed Panel root');
check(!/gridColumn|Container/.test(layout), 'layout has no workbook syntax');

const report = prepareReportForPost({
  name: 'R',
  folderId: 'F',
  schemaVersion: 1,
  kind: 'report',
  config: { pageWidth: 816, pageHeight: 1056, margin: 48 },
  pages: [{ id: 'p1', name: 'Page 1' }],
  panels: [{ id: 'head', type: 'header', pages: ['p1'], config: { height: 40 } }],
  elements: [
    { id: 'title', kind: 'text', body: '# T' },
    { id: 'head-text', kind: 'text', body: 'H' },
  ],
  layout,
});
check(report.document.kind === 'report', 'prepare nests report document');
check(report.name === 'R' && report.folderId === 'F', 'metadata stays outside document');
check(reportDocument(report).elements.length === 2, 'document helper reads wrapped elements');
check(Object.keys(reportMetadata(report)).sort().join(',') === 'folderId,name', 'metadata helper excludes document fields');

let validation = validateReportSpec(report);
check(validation.valid, `valid report passes (${validation.errors.join('; ')})`);
check(validateReportSpec(prepareReportForUpdate(report), { mode: 'update' }).valid, 'full-document update envelope passes');

const workbookLayout = structuredClone(report);
workbookLayout.document.layout = '<Page id="p1"><Element elementId="title" gridColumn="1 / 2" x="0" y="0" width="1" height="1"/></Page>';
validation = validateReportSpec(workbookLayout);
check(!validation.valid && validation.errors.some(error => /workbook grid/.test(error)), 'workbook grid syntax rejected');

const missing = structuredClone(report);
missing.document.layout = missing.document.layout.replace(/<Element elementId="title"[^>]+\/>\n/, '');
validation = validateReportSpec(missing);
check(!validation.valid && validation.errors.some(error => /title.*exactly once/.test(error)), 'unplaced element rejected');

const duplicate = structuredClone(report);
duplicate.document.elements.push({ id: 'title', kind: 'text', body: 'duplicate' });
check(!validateReportSpec(duplicate).valid, 'duplicate IDs rejected');

const normalized = normalizeReportForComparison(report);
check(normalized.elements[0].id === 'head-text' && normalized.elements[1].id === 'title', 'comparison normalization sorts IDs');

console.log(failures ? `\n❌ ${failures} report code-rep check(s) failed` : '\n✅ all report code-rep checks passed');
process.exit(failures ? 1 : 0);

