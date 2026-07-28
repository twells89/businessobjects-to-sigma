#!/usr/bin/env node
/**
 * Offline integration test — variables IR → translateWebiFormula →
 * dataModelAdditions / workbook calc columns, wired through webi.mjs.
 *   node test/webi-integration.test.mjs   (or npm test)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertWebiToWorkbook, normalizeWebiDocument } from '../converters/webi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

const r = convertWebiToWorkbook(read('fixtures/sample_webi_variables.json'), {
  dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View',
  measureMap: { 'Net Revenue': 'Sum([Net Revenue])', 'Gross Revenue': 'Sum([Gross Revenue])' }, schemaVersion: 1,
});

// context-free measure → data-model addition (metric). Its formula is BARE
// (same-element sibling ref), NOT qualified by the source name — it lands ON
// the "Order Fact View" element itself, so `Sum([Order Fact View/Net
// Revenue])` placed there would be a self-referential cross-element path.
// This mirrors converters/bobj.mjs::translateBobjExpr, which emits the same
// same-element metric/calc-column formulas bare (`Sum([Col])`, never
// `[TableView/Col]`).
check(r.dataModelAdditions.metrics.some(m => m.name === 'Margin Pct' && /^Sum\(\[Net Revenue\]\) \/ Sum\(\[Gross Revenue\]\)$/.test(m.formula)),
  'Margin Pct → dataModelAdditions.metric, BARE same-element formula (Sum([Net Revenue]) / Sum([Gross Revenue]))');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Running Revenue'), 'Running Revenue is NOT a DM addition (it is layout-dependent)');

// layout-dependent → workbook element calc column
const cols = r.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(cols.some(c => c.name === 'Running Revenue' && /CumulativeSum/.test(c.formula)), 'Running Revenue → workbook calc column (CumulativeSum)');

// Workbook calc-column refs ARE qualified by the source element name (a
// workbook element reaching INTO the View from the outside) — no circular refs.
check(cols.every(c => !(c.name && `[${c.name}]` === c.formula)), 'no self-referential column formulas');
// DM-addition formulas are the OPPOSITE: BARE, never qualified by source name
// — see the comment on the Margin Pct assertion above.
check(r.dataModelAdditions.metrics.every(m => !/Order Fact View\//.test(m.formula)), 'DM-addition metric formulas are BARE (no source-name qualifier)');
check(r.dataModelAdditions.columns.every(c => !/Order Fact View\//.test(c.formula)), 'DM-addition column formulas are BARE (no source-name qualifier)');

// DM-addition MEASURE resolves at the block column to the INLINE translated+
// qualified formula (re-aggregating the raw View columns, exactly like a base
// measure), NOT the metric by column-path: a DM metric is NOT addressable as
// [Element/MetricName] from a workbook (live-verified in Task 8 — POST
// /v2/workbooks/spec 400s "Dependency not found: 'order fact view/margin
// pct'"); the raw View columns it re-aggregates DO resolve. The metric itself
// still lands in the DM (governance/reuse) via dataModelAdditions.metrics, BARE.
const mcol = cols.find(c => c.name === 'Margin Pct');
check(mcol && /^Sum\(\[Order Fact View\/Net Revenue\]\) \/ Sum\(\[Order Fact View\/Gross Revenue\]\)$/.test(mcol.formula),
  'Margin Pct block col → inline re-aggregated raw View columns (Sum([.../Net Revenue]) / Sum([.../Gross Revenue])) — QUALIFIED, workbook context');
check(mcol && !/\[Order Fact View\/Margin Pct\]/.test(mcol.formula),
  'Margin Pct block col does NOT reference the metric by column-path (that 400s at workbook POST)');

// Dimension variable lands in the columns bucket (not metrics); its DM-addition
// formula is BARE (same-element sibling ref to [Customer Region]); the
// workbook block column that uses it resolves to a QUALIFIED ref (workbook
// reaching into the View) — same bare-in-DM/qualified-in-workbook split as the
// measure case above.
check(r.dataModelAdditions.columns.some(c => c.name === 'Region Bucket'), 'dimension variable → dataModelAdditions.columns');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Region Bucket'), 'dimension variable NOT in metrics bucket');
const rbAdd = r.dataModelAdditions.columns.find(c => c.name === 'Region Bucket');
check(rbAdd && /^If\(\[Customer Region\] = "West", "West", "Other"\)$/.test(rbAdd.formula),
  'Region Bucket DM-addition formula is BARE same-element ref (If([Customer Region] = "West", "West", "Other"))');
const rcol = cols.find(c => c.name === 'Region Bucket');
check(rcol && /^\[Order Fact View\/Region Bucket\]$/.test(rcol.formula), 'Region Bucket block dim → QUALIFIED DM ref (workbook referencing the bound View)');

// element-level in-place formula (not a named variable) is retained on the block column
const r2 = convertWebiToWorkbook({ document: { name: 'D', reports: [ { name: 'R', blocks: [
  { kind: 'VTable', title: 'T', dimensions: [{ name: 'Bucket', formula: '=If([Revenue] > 1000 ; "High" ; "Low")' }], measures: ['Net Revenue'] } ] } ], variables: [], filters: [] } },
  { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
const r2cols = r2.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(r2cols.some(c => c.name === 'Bucket' && /If\(\[Order Fact View\/Revenue\] > 1000, "High", "Low"\)/.test(c.formula)), 'block-column dataExpression formula translated + qualified');

// RAW Raylight element tree (reports carry `.elements`, NOT a pre-flattened
// `.blocks`) — this is the shape getWebiDocument() actually produces on the
// live migrate-webi.mjs path, routed through walkRaylight() rather than
// normalizeBlock(). A dataExpression-carried inline formula on a dimension
// must translate + qualify here too, exactly as it does on the friendly shape.
const r3 = convertWebiToWorkbook({ document: { name: 'D', reports: [ { name: 'R', elements: [
  { type: 'VTable', name: 'T', dataExpressions: [
    { name: 'Bucket', qualification: 'dimension', dataExpression: '=If([Revenue] > 1000 ; "High" ; "Low")' },
    { name: 'Net Revenue', qualification: 'measure' },
  ] } ] } ], variables: [], filters: [] } },
  { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
const r3cols = r3.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(r3cols.some(c => c.name === 'Bucket' && /If\(\[Order Fact View\/Revenue\] > 1000, "High", "Low"\)/.test(c.formula)), 'RAW Raylight (walkRaylight) dataExpression formula translated + qualified');

// ── Breaks / sort / sections IR capture ──────────────────────────────────────
{
  const doc = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'T', dimensions: ['Customer Region', 'Order Channel'], measures: ['Net Revenue'],
        breaks: ['Customer Region'],
        sort: [{ name: 'Net Revenue', direction: 'descending' }],
        sections: ['Order Channel'] },
    ] } ] } });
  const b = doc.reports[0].blocks[0];
  check(JSON.stringify(b.breaks) === JSON.stringify(['Customer Region']), `breaks captured (got ${JSON.stringify(b.breaks)})`);
  check(b.sort.length === 1 && b.sort[0].name === 'Net Revenue' && b.sort[0].direction === 'descending', `sort captured (got ${JSON.stringify(b.sort)})`);
  check(JSON.stringify(b.sections) === JSON.stringify(['Order Channel']), `sections captured (got ${JSON.stringify(b.sections)})`);
  // absent → empty arrays (back-compat)
  const doc2 = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['A'], measures: ['B'] } ] } ] } });
  const b2 = doc2.reports[0].blocks[0];
  check(Array.isArray(b2.breaks) && b2.breaks.length === 0, 'no breaks → []');
  check(Array.isArray(b2.sort) && b2.sort.length === 0, 'no sort → []');
  check(Array.isArray(b2.sections) && b2.sections.length === 0, 'no sections → []');
}

// RAW Raylight element tree (walkRaylight path, NOT normalizeBlock/`.blocks`) —
// breaks/sort/sections must be captured here too, since this is the shape
// getWebiDocument() actually produces on the live migrate-webi.mjs path.
{
  const rawDoc = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', elements: [
      { $type: 'VerticalTable', name: 'T',
        dataExpressions: [ { name: 'Customer Region', qualification: 'dimension' }, { name: 'Net Revenue', qualification: 'measure' } ],
        breaks: ['Customer Region'],
        sort: [{ name: 'Net Revenue', direction: 'descending' }],
        sections: ['Order Channel'] } ] } ] } });
  const rb = rawDoc.reports[0].blocks[0];
  check(rb && rb.dimensions.includes('Customer Region') && rb.measures.includes('Net Revenue'), 'walkRaylight recognized the raw table node (dims/measures populated)');
  check(JSON.stringify(rb.breaks) === JSON.stringify(['Customer Region']), `walkRaylight captures breaks (got ${JSON.stringify(rb && rb.breaks)})`);
  check(rb.sort.length === 1 && rb.sort[0].name === 'Net Revenue' && rb.sort[0].direction === 'descending', `walkRaylight captures sort (got ${JSON.stringify(rb && rb.sort)})`);
  check(JSON.stringify(rb.sections) === JSON.stringify(['Order Channel']), `walkRaylight captures sections (got ${JSON.stringify(rb && rb.sections)})`);
}

// ── Groupings emission (breaks → subtotals, sort, section, running-total) ─────
{
  const r = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'Summary', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        breaks: ['Customer Region'], sort: [{ name: 'Net Revenue', direction: 'descending' }] },
    ] } ] } }, { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl = r.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(Array.isArray(tbl.groupings) && tbl.groupings.length === 1, 'table gains one grouping');
  const g = tbl.groupings[0];
  const regionCol = tbl.columns.find(c => c.name === 'Customer Region');
  const netCol = tbl.columns.find(c => c.name === 'Net Revenue');
  check(g.groupBy.length === 1 && g.groupBy[0] === regionCol.id, 'groupBy = Customer Region column id');
  check(g.calculations.includes(netCol.id), 'calculations include the measure (subtotal)');
  check(g.sort.length === 1 && g.sort[0].columnId === netCol.id && g.sort[0].direction === 'descending', 'sort is inside the grouping, right col + direction');

  // running-total rewrite: a workbook RunningSum var → CumulativeSum([..]) → wrapped in Sum() inside a grouping
  const r2 = convertWebiToWorkbook({ document: { name: 'D', filters: [],
    variables: [{ name: 'Running Rev', qualification: 'measure', formula: '=RunningSum([Net Revenue])' }],
    reports: [ { name: 'R', blocks: [
      { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue', 'Running Rev'], breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl2 = r2.workbook.pages[0].elements.find(e => e.kind === 'table');
  const runCol = tbl2.columns.find(c => c.name === 'Running Rev');
  check(/^CumulativeSum\(Sum\(\[Order Fact View\/Net Revenue\]\)\)$/.test(runCol.formula), `group-level running total wrapped in Sum() (got ${runCol.formula})`);

  // section → outermost group key + warning
  const r3 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'S', dimensions: ['Customer Region', 'Order Channel'], measures: ['Net Revenue'],
        sections: ['Order Channel'], breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl3 = r3.workbook.pages[0].elements.find(e => e.kind === 'table');
  const chanCol = tbl3.columns.find(c => c.name === 'Order Channel');
  const regionCol3 = tbl3.columns.find(c => c.name === 'Customer Region');
  check(JSON.stringify(tbl3.groupings[0].groupBy) === JSON.stringify([chanCol.id, regionCol3.id]), 'section is the OUTERMOST group key, then break');
  check(r3.warnings.some(w => /Section .*Order Channel.* outer grouping/i.test(w)), 'section emits the approximation warning');

  // no breaks/sections → no groupings key (back-compat)
  const r4 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl4 = r4.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('groupings' in tbl4), 'no breaks/sections → no groupings key');

  // sort without a break → NO grouping, but element-level `sort` (Task 3
  // live-verified: element `sort: [{columnId,direction}]` orders an ungrouped
  // table; a top-level sort on a GROUPED table is the one that 400s).
  const r5 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        sort: [{ name: 'Net Revenue', direction: 'descending' }] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl5 = r5.workbook.pages[0].elements.find(e => e.kind === 'table');
  const netCol5 = tbl5.columns.find(c => c.name === 'Net Revenue');
  check(!('groupings' in tbl5), 'sort without break → no grouping key');
  check(Array.isArray(tbl5.sort) && tbl5.sort.length === 1 && tbl5.sort[0].columnId === netCol5.id && tbl5.sort[0].direction === 'descending',
    `sort without break → element-level sort [{columnId,direction}] (got ${JSON.stringify(tbl5.sort)})`);
  check(!r5.warnings.some(w => /sort .* no break|ungrouped .* sort/i.test(w)), 'no sort-without-break warning (sort is emitted, not warned)');

  // unresolvable ungrouped sort column → warns + no sort field (not a guess)
  const r5b = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        sort: [{ name: 'Ghost Measure', direction: 'descending' }] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl5b = r5b.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('sort' in tbl5b), 'unresolvable ungrouped sort column → no sort field');
  check(r5b.warnings.some(w => /sort column "Ghost Measure" not found/i.test(w)), 'unresolvable ungrouped sort column warns');

  // missing break column → warn + skip, no throw
  const r6 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'], breaks: ['Nonexistent Dim'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl6 = r6.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('groupings' in tbl6), 'unresolvable break → no grouping');
  check(r6.warnings.some(w => /Nonexistent Dim.*not a column|break.*skipped/i.test(w)), 'unresolvable break warns');

  // Fix 1 (final-review): a non-CumulativeSum cumulative left bare in a
  // grouped table's calculations is NOT auto-adjusted to group level (only
  // RunningSum→CumulativeSum is) — warn rather than guess a group-level
  // rewrite, so it doesn't silently drop/mis-grain (Task-8 rule). RunningSum
  // is still rewritten AND NOT warned.
  const r7 = convertWebiToWorkbook({ document: { name: 'D', filters: [],
    variables: [
      { name: 'Running Rev', qualification: 'measure', formula: '=RunningSum([Net Revenue])' },
      { name: 'Running Count Rev', qualification: 'measure', formula: '=RunningCount([Net Revenue])' },
      { name: 'Prev Rev', qualification: 'measure', formula: '=Previous([Net Revenue])' },
      { name: 'Avg Rev', qualification: 'measure', formula: '=RunningAverage([Net Revenue])' },
    ],
    reports: [ { name: 'R', blocks: [
      { kind: 'VTable', title: 'Broken', dimensions: ['Customer Region'],
        measures: ['Net Revenue', 'Running Rev', 'Running Count Rev', 'Prev Rev', 'Avg Rev'],
        breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl7 = r7.workbook.pages[0].elements.find(e => e.kind === 'table');
  const sumCol = tbl7.columns.find(c => c.name === 'Running Rev');
  const cntCol = tbl7.columns.find(c => c.name === 'Running Count Rev');
  const prevCol = tbl7.columns.find(c => c.name === 'Prev Rev');
  const avgCol = tbl7.columns.find(c => c.name === 'Avg Rev');
  check(/^CumulativeSum\(Sum\(\[Order Fact View\/Net Revenue\]\)\)$/.test(sumCol.formula), `RunningSum still rewritten to group level (got ${sumCol.formula})`);
  check(cntCol.formula === 'CumulativeCount([Order Fact View/Net Revenue])', `RunningCount left UNTOUCHED, bare-column (got ${cntCol.formula})`);
  check(prevCol.formula === 'Lag([Order Fact View/Net Revenue])', `Previous (Lag) left UNTOUCHED, bare-column (got ${prevCol.formula})`);
  check(avgCol.formula === '(CumulativeSum([Order Fact View/Net Revenue]) / CumulativeCount([Order Fact View/Net Revenue]))', `RunningAverage ratio left UNTOUCHED, bare-column (got ${avgCol.formula})`);
  check(r7.warnings.some(w => /grouped running calc "Running Count Rev" \(CumulativeCount\)/.test(w)), 'RunningCount → grouped running calc warning');
  check(r7.warnings.some(w => /grouped running calc "Prev Rev" \(Lag\)/.test(w)), 'Previous → grouped running calc warning');
  check(r7.warnings.some(w => /grouped running calc "Avg Rev" \(RunningAverage ratio\)/.test(w)), 'RunningAverage → grouped running calc warning');
  check(!r7.warnings.some(w => /grouped running calc "Running Rev"/.test(w)), 'RunningSum/CumulativeSum does NOT get the grouped-running-calc warning (it IS rewritten)');

  // Fix 2 (final-review): an unresolvable section does NOT ALSO get the
  // "approximated as an outer grouping" warning — only the existing
  // "not a column — skipped" one. (The section test above resolves fine and
  // still gets the approximation warning — unchanged.)
  const r8 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        sections: ['Nonexistent Section'], breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl8 = r8.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(Array.isArray(tbl8.groupings) && tbl8.groupings.length === 1, 'break still groups the table even though the section is unresolvable');
  check(r8.warnings.some(w => /Nonexistent Section.*not a column|break\/section.*skipped/i.test(w)), 'unresolvable section still warns "not a column"');
  check(!r8.warnings.some(w => /outer grouping/i.test(w)), 'unresolvable section does NOT get the approximation warning');

  // Fix 3 / T3a (final-review): all breaks/sections unresolvable but a sort
  // is present → fall back to the element-level sort (same path as the
  // no-breaks case) rather than silently discarding the sort.
  const r9 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        breaks: ['Nonexistent Dim'], sort: [{ name: 'Net Revenue', direction: 'descending' }] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl9 = r9.workbook.pages[0].elements.find(e => e.kind === 'table');
  const netCol9 = tbl9.columns.find(c => c.name === 'Net Revenue');
  check(!('groupings' in tbl9), 'unresolvable break → still no grouping');
  check(Array.isArray(tbl9.sort) && tbl9.sort.length === 1 && tbl9.sort[0].columnId === netCol9.id && tbl9.sort[0].direction === 'descending',
    `unresolvable break + valid sort → element-level sort fallback, not silently dropped (got ${JSON.stringify(tbl9.sort)})`);

  // Fix 4a (final-review): a dim used as BOTH a section and a break →
  // deduped groupBy (the id appears once, not twice).
  const r10 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        sections: ['Customer Region'], breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl10 = r10.workbook.pages[0].elements.find(e => e.kind === 'table');
  const regionCol10 = tbl10.columns.find(c => c.name === 'Customer Region');
  check(JSON.stringify(tbl10.groupings[0].groupBy) === JSON.stringify([regionCol10.id]), `dim used as BOTH section+break → groupBy id appears once (got ${JSON.stringify(tbl10.groupings[0].groupBy)})`);

  // Fix 4b (final-review): a broken table with NO explicit sort defaults to
  // sort:[{columnId: <outermost groupBy id>, direction:'ascending'}].
  const r11 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl11 = r11.workbook.pages[0].elements.find(e => e.kind === 'table');
  const regionCol11 = tbl11.columns.find(c => c.name === 'Customer Region');
  check(tbl11.groupings[0].sort.length === 1 && tbl11.groupings[0].sort[0].columnId === regionCol11.id && tbl11.groupings[0].sort[0].direction === 'ascending',
    `no explicit sort → default ascending on outermost groupBy key (got ${JSON.stringify(tbl11.groupings[0].sort)})`);
}

// ── Alerter IR capture ───────────────────────────────────────────────────────
{
  const doc = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'T', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        alerters: [
          { name: 'LowRev', column: 'Net Revenue', operator: '<', value: 100, style: { backgroundColor: '#ff0000', color: '#ffffff' } },
          { name: 'Ranged', column: 'Net Revenue', operator: 'between', value: 100, value2: 500, style: { backgroundColor: '#ffff00' } },
        ] },
    ] } ] } });
  const a = doc.reports[0].blocks[0].alerters;
  check(a.length === 2, `alerters captured (got ${a.length})`);
  check(a[0].column === 'Net Revenue' && a[0].operator === '<' && a[0].value === 100, 'rule 0 fields');
  check(a[0].style.backgroundColor === '#ff0000' && a[0].style.color === '#ffffff', 'rule 0 style');
  check(a[1].operator === 'between' && a[1].value2 === 500, 'range rule keeps value2');
  // raw Raylight path
  const raw = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', elements: [ { $type: 'VerticalTable', name: 'T',
      dataExpressions: [ { name: 'Net Revenue', qualification: 'measure' } ],
      alerters: [ { column: 'Net Revenue', operator: '>', value: 1000, style: { backgroundColor: '#00ff00' } } ] } ] } ] } });
  check(raw.reports[0].blocks[0].alerters.length === 1, 'walkRaylight captures alerters');
  // absent → []
  const none = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['A'], measures: ['B'] } ] } ] } });
  check(Array.isArray(none.reports[0].blocks[0].alerters) && none.reports[0].blocks[0].alerters.length === 0, 'no alerters → []');
}

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
