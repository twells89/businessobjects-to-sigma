/**
 * Offline unit tests for scripts/code_rep.mjs — the workbook code-rep adapter
 * that makes POST /v2/workbooks/spec accept converter output after the 2026-08
 * document-wrapper change.
 */
import {
  document, metadata, workbookElements, wrap,
  stackedLayout, prepareWorkbookForPost, canonicalizeLayout,
} from '../scripts/code_rep.mjs';

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✅', msg);
  else { console.log('  ❌', msg); failures++; }
}

console.log('code_rep');

const live = {
  workbookId: 'w1',
  name: 'N',
  folderId: 'f1',
  document: {
    schemaVersion: 1,
    kind: 'workbook',
    pages: [{ id: 'p' }],
    elements: [{ id: 'e1', kind: 'table' }],
    layout: '<Page id="p"><Element elementId="e1"/></Page>',
  },
};
check(document(live).elements[0].id === 'e1', 'document() unwraps nested live GET');
check(Object.keys(metadata(live)).sort().join(',') === 'folderId,name,workbookId', 'metadata() keeps outer fields only');

const nested = {
  name: 'Sales',
  folderId: 'folder-1',
  schemaVersion: 1,
  kind: 'workbook',
  pages: [{ id: 'p1', name: 'Overview', elements: [{ id: 't1', kind: 'table', name: 'T' }] }],
};
check(workbookElements(nested).map(e => e.id).join() === 't1', 'workbookElements() reads legacy pages[].elements');

const wrapped = wrap({ schemaVersion: 1, kind: 'workbook', pages: nested.pages }, { name: 'Sales', folderId: 'folder-1' });
check(Array.isArray(wrapped.document.elements) && wrapped.document.elements[0].id === 't1', 'wrap() flattens pages[].elements → document.elements');
check(!('elements' in wrapped.document.pages[0]), 'wrap() strips nested pages[].elements');
check(wrapped.name === 'Sales' && wrapped.folderId === 'folder-1', 'wrap(doc, extra) puts name/folderId outside document');
check(wrapped.document.kind === 'workbook', 'wrap() keeps document.kind');

const legacyLayout = '<Page id="p"><GridContainer elementId="c"><LayoutElement elementId="e1"/></GridContainer></Page>';
check(
  canonicalizeLayout(legacyLayout) === '<Page id="p"><Container elementId="c"><Element elementId="e1"/></Container></Page>',
  'canonicalizeLayout() rewrites LayoutElement/GridContainer → Element/Container',
);

const layout = stackedLayout(nested.pages);
check(/<Page[^>]*id="p1">/.test(layout), 'stackedLayout() emits a <Page> per page');
check(/<Element elementId="t1" gridColumn="1 \/ 25"/.test(layout), 'stackedLayout() places each element full-width');
check(layout.startsWith('<?xml version="1.0"'), 'stackedLayout() starts with the XML declaration');

const body = prepareWorkbookForPost(nested);
check(body.document && body.document.kind === 'workbook', 'prepareWorkbookForPost: document.kind === "workbook"');
check(body.name === 'Sales' && body.folderId === 'folder-1', 'prepareWorkbookForPost: name/folderId stay outer');
check(!('schemaVersion' in body) || body.schemaVersion === undefined, 'prepareWorkbookForPost: schemaVersion is NOT outer (lives in document)');
check(body.document.schemaVersion === 1, 'prepareWorkbookForPost: schemaVersion nests under document');
check(Array.isArray(body.document.elements) && body.document.elements.length === 1, 'prepareWorkbookForPost: flat document.elements');
check(!('elements' in body.document.pages[0]), 'prepareWorkbookForPost: pages are metadata-only');
check(/elementId="t1"/.test(body.document.layout || ''), 'prepareWorkbookForPost: synthesizes layout placing every element');

// Already-wrapped input is idempotent on the important fields.
const again = prepareWorkbookForPost(body);
check(again.document.kind === 'workbook' && again.document.elements[0].id === 't1', 'prepareWorkbookForPost is safe on already-wrapped input');
check(/elementId="t1"/.test(again.document.layout || ''), 'prepareWorkbookForPost keeps layout on re-wrap');

// Converter-shaped object with kind already set (what webi.mjs now returns).
const fromConverter = {
  name: 'Doc', folderId: 'f', schemaVersion: 2, kind: 'workbook',
  pages: [
    { id: 'page-a', name: 'A', elements: [{ id: 'k1', kind: 'kpi-chart' }, { id: 'c1', kind: 'bar-chart' }] },
    { id: 'page-b', name: 'B', elements: [{ id: 't2', kind: 'table' }] },
  ],
};
const posted = prepareWorkbookForPost(fromConverter);
check(posted.document.elements.map(e => e.id).join(',') === 'k1,c1,t2', 'prepareWorkbookForPost: multi-page flatten preserves order');
check((posted.document.layout.match(/<Page /g) || []).length === 2, 'prepareWorkbookForPost: layout has one <Page> per page');
check(!/LayoutElement|GridContainer/.test(posted.document.layout), 'prepareWorkbookForPost: layout uses live Element/Container tags only');

console.log(failures ? `\n❌ ${failures} check(s) failed` : '\n✅ all code_rep checks passed');
process.exit(failures ? 1 : 0);
