import { universePreflight, webiPreflight, assertPublishable } from '../scripts/preflight.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failures++;
}

const outline = { universe: { name: 'Outline', classes: [{ name: 'Orders', objects: [{ name: 'Revenue', type: 'Measure' }] }] } };
const emptyResult = { model: { pages: [{ elements: [] }] }, warnings: [], stats: { relationships: 0 } };
const outlineCheck = universePreflight(outline, emptyResult);
check(outlineCheck.verdict === 'BLOCKED', 'outline-only universe is blocked');
check(outlineCheck.blockers.some(item => item.code === 'outline-only-universe'), 'outline blocker is explicit');
check(outlineCheck.blockers.some(item => item.code === 'no-bindable-view'), 'missing View is blocked');

const safeUniverse = {
  universe: {
    name: 'Safe',
    tables: ['FACT', 'DIM'],
    objects: [{ name: 'Revenue', type: 'Measure', select: 'sum(FACT.REVENUE)' }],
    joins: [{ expression: 'FACT.DIM_ID = DIM.ID', cardinality: 'many-to-one' }],
  },
};
const safeUniverseResult = {
  model: { pages: [{ elements: [
    { name: 'Fact', source: { kind: 'warehouse-table' } },
    { name: 'Dim', source: { kind: 'warehouse-table' } },
    { name: 'Fact View', source: { kind: 'table' } },
  ] }] },
  warnings: [],
  stats: { relationships: 1 },
};
check(universePreflight(safeUniverse, safeUniverseResult).verdict === 'PASS', 'full universe can pass preflight');

const singleTableInput = { universe: { name: 'Single', tables: ['FACT'], objects: [{ name: 'Revenue', type: 'Measure', select: 'sum(FACT.REVENUE)' }] } };
const singleTableResult = {
  model: { pages: [{ elements: [
    { name: 'Fact', source: { kind: 'warehouse-table' } },
    { name: 'Fact View', source: { kind: 'table' } },
  ] }] },
  warnings: [],
  stats: { relationships: 0 },
};
check(universePreflight(singleTableInput, singleTableResult).verdict === 'PASS', 'single-table SDK JSON is not mistaken for an outline');
check(universePreflight(singleTableInput, singleTableResult, { requireSourceUniverseId: true }).blockers.some(item => item.code === 'missing-source-universe-id'), 'local publish requires its source universe id');
check(universePreflight(singleTableInput, singleTableResult, { requireTargetConnection: true }).blockers.some(item => item.code === 'missing-target-connection'), 'publish requires a target connection');

const ambiguousResult = {
  model: { pages: [{ elements: [
    { name: 'Fact A', source: { kind: 'warehouse-table' } },
    { name: 'Fact B', source: { kind: 'warehouse-table' } },
    { name: 'Fact A View', source: { kind: 'table' } },
    { name: 'Fact B View', source: { kind: 'table' } },
  ] }] },
  warnings: [],
  stats: { relationships: 1 },
};
check(universePreflight(safeUniverse, ambiguousResult).blockers.some(item => item.code === 'ambiguous-bindable-view'), 'multiple candidate Views are blocked');

const workbookResult = {
  workbook: { pages: [{ elements: [{ id: 'table-1', kind: 'table' }] }] },
  warnings: [],
  stats: { pages: 1, elements: 1 },
};
const binding = { dataModelId: 'dm', viewElementId: 'view', sourceName: 'Fact View' };
const multiProvider = {
  document: { reports: [{ name: 'R' }], filters: [] },
  dataproviders: [{ id: 'a', universeId: 'u1' }, { id: 'b', universeId: 'u2' }],
};
const multiCheck = webiPreflight(multiProvider, workbookResult, binding);
check(multiCheck.blockers.some(item => item.code === 'multiple-data-providers'), 'multiple providers are blocked');
check(multiCheck.blockers.some(item => item.code === 'multiple-universes'), 'multiple universes are blocked');

const filtered = {
  document: { reports: [{ name: 'R', filters: [{ name: 'Report filter' }] }], filters: [{ name: 'Document filter' }] },
  dataproviders: [{ id: 'a', universeId: 'u1' }],
};
check(webiPreflight(filtered, workbookResult, binding).blockers.some(item => item.code === 'unbound-filters'), 'unbound filters are blocked');

const safeWebi = {
  document: { reports: [{ name: 'R' }], filters: [] },
  dataproviders: [{ id: 'a', universeId: 'u1' }],
};
const safeCheck = webiPreflight(safeWebi, workbookResult, binding);
check(safeCheck.verdict === 'PASS', 'single-provider filter-free document can pass preflight');

const unknownProvider = {
  document: { reports: [{ name: 'R' }], filters: [] },
  dataproviders: [{ id: 'a' }],
};
check(webiPreflight(unknownProvider, workbookResult, binding).blockers.some(item => item.code === 'unresolved-provider-source'), 'provider without a source id is blocked');

const mismatchedBinding = { ...binding, sourceUniverseId: 'other-universe' };
check(webiPreflight(safeWebi, workbookResult, mismatchedBinding).blockers.some(item => item.code === 'universe-binding-mismatch'), 'provider universe must match the saved binding');

const incompleteCapture = { ...safeWebi, warnings: ['/raylight/v1/documents/1/filters: HTTP 404'] };
check(webiPreflight(incompleteCapture, workbookResult, binding).blockers.some(item => item.code === 'filter-capture-incomplete'), 'failed filter capture is blocked');

let threw = false;
try { assertPublishable(multiCheck, 'Webi document'); } catch { threw = true; }
check(threw, 'publish assertion rejects blockers');

console.log(failures ? `\n${failures} preflight check(s) failed` : '\nAll preflight checks passed');
process.exit(failures ? 1 : 0);
