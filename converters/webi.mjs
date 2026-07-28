/**
 * SAP BusinessObjects Web Intelligence (Webi) → Sigma Workbook converter.
 *
 * The report-layer companion to the universe converter (convert_bobj_to_sigma).
 * Where the universe → a Sigma DATA MODEL, a Webi document → a Sigma WORKBOOK.
 *
 * Input: BI RESTful Web Service "Raylight" document JSON, e.g.
 *   GET /biprws/raylight/v1/documents/{id}
 *   GET /biprws/raylight/v1/documents/{id}/reports/{rid}/elements
 * The ingest (`normalizeWebiDocument`) is tolerant of the raw Raylight element
 * tree AND of a friendly pre-flattened shape (what a discovery script emits).
 *
 * Output: a Sigma workbook spec object suitable for POST /v2/workbooks/spec.
 * Each report tab → a page; each block → an element bound (by default) to the
 * Sigma data model produced from the matching universe.
 *
 * Mapping:
 *   report tab                → workbook page
 *   vertical/horizontal table → table element
 *   crosstab                  → pivot-table element (rowsBy / columnsBy / values)
 *   chart                     → {bar,line,pie,area,...}-chart element
 *   free-standing measure cell→ kpi-chart element
 *   document / report filter  → workbook control (best-effort)
 */

// ── IR ───────────────────────────────────────────────────────────────────────

/** @typedef {{kind:'table'|'crosstab'|'chart'|'cell', title?:string,
 *   dimensions:string[], measures:string[], chartType?:string,
 *   rows?:string[], cols?:string[],
 *   breaks?:string[], sort?:{name:string,direction:string}[], sections?:string[],
 *   formulaByName?:Record<string,string>}} WebiBlock */
/** @typedef {{name:string, blocks:WebiBlock[]}} WebiReport */
/** @typedef {{name:string, qualification?:string, formula:string}} WebiVariable */
/** @typedef {{name:string, reports:WebiReport[], filters:{name:string,expression?:string}[],
 *   variables:WebiVariable[]}} WebiDocument */

import { translateWebiFormula } from './webi-formula.mjs';

let _seq = 0;
function uid(prefix = 'el') { return `${prefix}-${(++_seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

// Webi chart class names → Sigma chart kinds.
const CHART_KIND = [
  [/vertical.*bar|column/i, 'bar-chart'],
  [/horizontal.*bar|bar/i, 'bar-chart'],
  [/line/i, 'line-chart'],
  [/area/i, 'area-chart'],
  [/pie|donut/i, 'pie-chart'],
  [/scatter|bubble/i, 'scatter-chart'],
  [/combo|dual/i, 'combo-chart'],
];
function sigmaChartKind(webiType) {
  for (const [re, kind] of CHART_KIND) if (re.test(webiType || '')) return kind;
  return 'bar-chart';
}
const isHorizontalBar = t => /horizontal/i.test(t || '');

function displayName(s) {
  if (!s) return '';
  return /[ ]/.test(s) ? s.replace(/\b\w/g, c => c.toUpperCase()) : s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Normalize a breaks/sections list (strings or {name}) → string[] of names.
function nameList(arr) {
  return (arr || []).map(x => (typeof x === 'string' ? x : (x && (x.name || x.label || x.dimension)))).filter(Boolean);
}
// Normalize a sort list (strings or {name,direction}) → [{name,direction}].
function sortList(arr) {
  return (arr || []).map(x => {
    const name = typeof x === 'string' ? x : (x && (x.name || x.label || x.column));
    const dir = (typeof x === 'object' && x && /desc/i.test(x.direction || x.order || '')) ? 'descending' : 'ascending';
    return name ? { name, direction: dir } : null;
  }).filter(Boolean);
}

// ── Tolerant ingest → WebiDocument IR ────────────────────────────────────────

export function normalizeWebiDocument(input) {
  const root = input?.document ?? input ?? {};
  const name = root.name || root.documentName || input?.name || 'Web Intelligence Document';
  const reports = [];

  const rawReports = root.reports || root.report || input?.reports;
  if (Array.isArray(rawReports)) {
    for (const r of rawReports) {
      const rName = r.name || r.reportName || `Report ${reports.length + 1}`;
      const blocks = [];
      // Friendly shape: r.blocks already flattened.
      if (Array.isArray(r.blocks)) {
        for (const b of r.blocks) blocks.push(normalizeBlock(b));
      } else {
        // Raw Raylight: walk the element tree under elements/body/children.
        const tree = r.elements || r.body || r.children || r.element;
        walkRaylight(tree, blocks);
      }
      reports.push({ name: rName, blocks });
    }
  }

  const filters = [];
  const rawFilters = root.filters || root.documentFilters || root.queryFilters || input?.filters;
  if (Array.isArray(rawFilters)) {
    for (const f of rawFilters) {
      filters.push({ name: f.name || f.filterName || 'Filter', expression: f.expression || f.definition || f.sql || f.condition });
    }
  }

  const variables = [];
  const rawVars = root.variables || input?.variables;
  if (Array.isArray(rawVars)) for (const v of rawVars) variables.push({
    name: v.name || v.variableName || 'Variable',
    qualification: (v.qualification || v.type || '').toString().toLowerCase() || undefined,
    formula: v.formula || v.definition || v.expression || '',
  });
  return { name, reports, filters, variables };
}

function normalizeBlock(b) {
  const rawType = (b.kind || b.type || b.$type || b.blockType || '').toString();
  const dimsIn = b.dimensions || b.dims || b.axisDimensions || [];
  const measIn = b.measures || b.metrics || b.axisMeasures || [];
  const exprNames = arr => (arr || []).map(x => (typeof x === 'string' ? x : (x.name || x.label || x.expression || ''))).filter(Boolean);
  // An in-place cell/column formula — a dimension/measure entry that is an
  // OBJECT carrying its own formula/expression/definition (raw Raylight calls
  // this `dataExpression`), NOT a named report variable — is kept alongside
  // its plain name so blockToElement can translate + qualify it, taking
  // precedence over the name-based variable/measureMap resolution. A plain
  // string entry has no inline formula (existing name-only behavior).
  const formulaByName = {};
  const captureFormulas = arr => {
    for (const x of (arr || [])) {
      if (!x || typeof x !== 'object') continue;
      const name = x.name || x.label;
      if (!name) continue; // no distinct name (e.g. name derived solely from `expression`) — nothing to key a formula on
      const formula = x.formula || x.dataExpression || x.expression || x.definition;
      if (!formula) continue;
      formulaByName[name] = formula;
      formulaByName[displayName(name)] = formula;
    }
  };
  captureFormulas(dimsIn);
  captureFormulas(measIn);
  let kind = 'table';
  if (/cross|matrix|pivot/i.test(rawType)) kind = 'crosstab';
  else if (/chart|graph|plot/i.test(rawType)) kind = 'chart';
  else if (/cell|free/i.test(rawType)) kind = 'cell';
  else if (/table|htable|vtable|list/i.test(rawType) || rawType === '') kind = 'table';
  return {
    kind,
    title: b.title || b.name || b.caption,
    chartType: b.chartType || b.chartStyle || rawType,
    dimensions: exprNames(dimsIn),
    measures: exprNames(measIn),
    rows: exprNames(b.rows || b.rowAxis),
    cols: exprNames(b.cols || b.columnAxis),
    formulaByName,
    breaks: nameList(b.breaks || b.breakBy || b.breakOn),
    sort: sortList(b.sort || b.sortBy || b.orderBy),
    sections: nameList(b.sections || b.sectionBy || b.sectionOn),
  };
}

// Raw Raylight element tree: recurse, emit a block per recognized leaf.
function walkRaylight(node, out) {
  if (!node) return;
  const nodes = Array.isArray(node) ? node : [node];
  for (const n of nodes) {
    const t = (n.$type || n.type || n.elementType || '').toString();
    const looksBlock = /table|chart|crosstab|cell/i.test(t) && (n.dataExpressions || n.expressions || n.axes || n.columns);
    if (looksBlock) {
      const exprs = n.dataExpressions || n.expressions || [];
      const dims = [], meas = [];
      // Same in-place formula capture as normalizeBlock (friendly shape): a
      // raw Raylight expression carrying its own formula text — `dataExpression`
      // is RWS's field name for this, `formula`/`expression`/`definition` cover
      // other shapes — is kept alongside its name, NOT as a named report
      // variable. Keyed under both the raw name and its displayName() form
      // (mirroring normalizeBlock) so withInlineFormula resolves it whether
      // blockToElement calls in with the raw name (measures) or the
      // displayName()'d one (dimensions).
      const formulaByName = {};
      for (const e of exprs) {
        const nm = e.name || e.label || e.expression || '';
        const q = (e.qualification || e.dataType || e.kind || '').toString().toLowerCase();
        const distinctName = e.name || e.label; // not derived solely from `expression` — nothing to key a formula on otherwise
        const formula = e.formula || e.dataExpression || e.expression || e.definition;
        if (distinctName && formula) { formulaByName[distinctName] = formula; formulaByName[displayName(distinctName)] = formula; }
        if (/measure/.test(q)) meas.push(nm); else dims.push(nm);
      }
      out.push({
        kind: /cross/i.test(t) ? 'crosstab' : /chart/i.test(t) ? 'chart' : /cell/i.test(t) ? 'cell' : 'table',
        title: n.name || n.title, chartType: n.chartType || t,
        dimensions: dims.filter(Boolean), measures: meas.filter(Boolean), rows: [], cols: [],
        formulaByName,
        breaks: nameList(n.breaks || n.breakBy),
        sort: sortList(n.sort || n.sortBy),
        sections: nameList(n.sections || n.sectionBy),
      });
    }
    // Recurse into containers.
    const kids = n.children || n.elements || n.cells || n.body;
    if (kids) walkRaylight(kids, out);
  }
}

// ── IR → Sigma workbook spec ─────────────────────────────────────────────────

export function convertWebiToWorkbook(input, options = {}) {
  _seq = 0;
  const {
    folderId = '<FOLDER_ID>',
    dataModelId = '<DATA_MODEL_ID>',
    dataModelElementId = '<DM_ELEMENT_ID>',
    // sourceName: display NAME of the bound data-model element (e.g. the
    // universe's "Order Fact View"). Column refs are qualified by it
    // (`[sourceName/Col]`) so a workbook column named after its source column
    // doesn't self-reference ("Circular column reference"). Required for the
    // workbook to resolve; when empty, refs stay bare (UI binding needed).
    sourceName = '',
    // measureMap: universe measure NAME → Sigma aggregate formula (from the
    // universe converter's metrics), e.g. { "Order Count": "Count([Order Id])" }.
    // Without it, a measure defaults to Sum([Name]).
    measureMap = {},
    schemaVersion = 1,
    workbookName,
  } = options;
  const doc = normalizeWebiDocument(input);
  const warnings = [];

  // Every block element sources directly from the universe's data-model element
  // (the denormalized "View" carries all dims + measure columns).
  const src = { kind: 'data-model', dataModelId, elementId: dataModelElementId };
  // Qualify bare bracket refs `[X]` → `[sourceName/X]` (leave `[a/b]` alone).
  const q = formula => sourceName ? formula.replace(/\[([^\]\/]+)\]/g, (_m, inner) => `[${sourceName}/${inner}]`) : formula;
  const dimRef = dim => q(`[${dim}]`);
  const measFormula = name => q(measureMap[name] || measureMap[displayName(name)] || `Sum([${displayName(name)}])`);

  // ── Variables (Webi report-scoped formulas) → dataModelAdditions / calc cols ─
  // A context-free variable (Tier 1/no window/no context-op) is a candidate DM
  // metric or column — Task 7 will add it to the bound View element. A
  // layout-dependent one (window fn or context operator forced `placement:
  // 'workbook'`) can only live as a workbook calc column on the element that
  // uses it, since it depends on the element's own grouping/partition.
  //
  // dataModelAdditions.metrics/columns formulas are BARE (unqualified), never
  // q()-qualified: they land ON the View element they'll be merged into
  // (scripts/dm-merge.mjs), so they reference that element's own sibling
  // columns the same way any same-element DM metric/calc column does elsewhere
  // in this project (see converters/bobj.mjs::translateBobjExpr — `Sum(Table.Col)`
  // becomes a bare `Sum([Col])`, never `[TableView/Col]`). Qualifying a
  // same-element formula would make it a self-referential cross-element path.
  const dataModelAdditions = { metrics: [], columns: [] };
  const workbookVarFormula = new Map();   // variable name → qualified workbook formula
  // A DM-placed MEASURE variable's INLINE translated+qualified formula (it
  // re-aggregates the raw View columns, e.g. Sum([View/Net]) / Sum([View/Gross])).
  // This is what a block column that references the measure must resolve to —
  // NOT the metric by column-path — because a DM metric is NOT addressable as
  // `[Element/MetricName]` from a workbook (live-verified in Task 8: POST
  // /v2/workbooks/spec 400s "Dependency not found: 'order fact view/margin
  // pct'"), whereas the raw columns it re-aggregates DO resolve. The metric
  // still lands in dataModelAdditions.metrics (governance/reuse, per the
  // split-by-kind design), and the workbook stays self-resolving — identical to
  // how the existing base-measure path already works (raw column on the View,
  // aggregate applied in the workbook).
  const dmMeasureInline = new Map();      // DM-placed measure var name → inline qualified formula
  // A DM-placed DIMENSION variable becomes a real calc COLUMN on the View, so
  // it IS addressable by column-path `[sourceName/Name]` (unlike a metric).
  const dmColumnNames = new Set();
  for (const v of doc.variables) {
    if (!v.formula) continue;
    const tr = translateWebiFormula(v.formula, { qualification: v.qualification });
    tr.warnings.forEach(w => warnings.push(`Variable "${v.name}": ${w}`));
    // Two DISTINCT resolution forms for the SAME translated formula (tr.sigma),
    // per the DM convention already established in bobj.mjs
    // (translateBobjExpr): a formula that LIVES ON an element references that
    // element's own sibling columns BARE (e.g. `Sum([Net Revenue])` on a table
    // that itself has a "Net Revenue" column) — `[ElementName/Col]` is reserved
    // for a CROSS-element lookup. A DM addition (below) lands ON the bound View
    // element itself, so qualifying it would make it a self-referential
    // cross-element path (`Sum([Order Fact View/Net Revenue])` placed ON "Order
    // Fact View"). `qualified` is still correct — and used — for the WORKBOOK's
    // inline resolution of a DM-placed variable: there, the calc column lives on
    // a separate workbook element that reaches INTO the View from the outside,
    // where `[sourceName/Col]` is a correct, live-verified (Task 8) cross-element
    // reference.
    const qualified = q(tr.sigma);
    if (tr.placement === 'dm') {
      if (tr.kind === 'measure') {
        // DM addition: BARE (same-element sibling ref).
        if (!dataModelAdditions.metrics.some(x => x.name === v.name)) dataModelAdditions.metrics.push({ id: uid('add'), name: v.name, formula: tr.sigma });
        // Workbook inline resolution of this measure: QUALIFIED (cross-element,
        // from the workbook into the View) — see dmMeasureInline's own comment.
        dmMeasureInline.set(v.name, qualified);
      } else {
        // DM addition: BARE (same-element sibling ref) — mirrors the measure
        // case above; a DM-placed dimension's own formula (e.g. the If(...) that
        // becomes a calc column on the View) references its sibling columns
        // bare too.
        if (!dataModelAdditions.columns.some(x => x.name === v.name)) dataModelAdditions.columns.push({ id: uid('add'), name: v.name, formula: tr.sigma });
        dmColumnNames.add(v.name);
      }
    } else {
      workbookVarFormula.set(v.name, qualified);
    }
  }

  // Resolve a block dim/measure name to the right formula source, in order:
  //   1. a workbook-placed variable → its own translated+qualified calc,
  //   2. a DM-placed MEASURE variable → its inline re-aggregated formula
  //      (Sum([View/Net]) / Sum([View/Gross])), NOT a metric column-path ref
  //      (that 400s at workbook POST) and NOT the plain Sum([Name]) default,
  //   3. a DM-placed DIMENSION variable → a qualified column-path ref
  //      `[sourceName/Name]` to the calc column Task 7 adds to the View,
  //   4. none → unchanged existing behavior (fallback: measFormula/dimRef).
  const resolveRef = (name, fallback) => {
    const dn = displayName(name);
    if (workbookVarFormula.has(name)) return workbookVarFormula.get(name);
    if (workbookVarFormula.has(dn)) return workbookVarFormula.get(dn);
    if (dmMeasureInline.has(name)) return dmMeasureInline.get(name);
    if (dmMeasureInline.has(dn)) return dmMeasureInline.get(dn);
    if (dmColumnNames.has(name)) return q(`[${name}]`);
    if (dmColumnNames.has(dn)) return q(`[${dn}]`);
    return fallback(name);
  };
  const resolvedMeasFormula = name => resolveRef(name, measFormula);
  const resolvedDimRef = name => resolveRef(name, dimRef);

  // An inline block-column formula (block.formulaByName, from normalizeBlock —
  // an in-place cell/column expression, NOT a named report variable) takes
  // PRECEDENCE over the name-based resolveRef resolution above: an explicit
  // per-column formula always wins over a name match. Wrapping the resolver
  // per block (rather than threading `q`/formulaByName into blockToElement
  // itself) keeps blockToElement's cell/chart/crosstab/table bodies — and
  // Task 5's resolveRef path they already call through — completely
  // untouched, so this can't regress them.
  const withInlineFormula = (block, resolver) => (name) => {
    const raw = block.formulaByName && (block.formulaByName[name] ?? block.formulaByName[displayName(name)]);
    if (raw == null) return resolver(name);
    const tr = translateWebiFormula(raw, {});
    tr.warnings.forEach(w => warnings.push(`Block "${block.title || block.kind}": ${w}`));
    return q(tr.sigma);
  };

  const pages = [];
  for (const report of doc.reports) {
    const pageId = uid('page');
    const elements = [];
    for (const block of report.blocks) {
      const el = blockToElement(block, src, withInlineFormula(block, resolvedMeasFormula), withInlineFormula(block, resolvedDimRef), warnings);
      if (el) elements.push(el);
      else warnings.push(`Report "${report.name}": block "${block.title || block.kind}" (${block.kind}) produced no element — review manually.`);
    }
    if (report.blocks.length === 0) warnings.push(`Report "${report.name}" had no recognizable blocks.`);
    pages.push({ id: pageId, name: report.name, elements });
  }

  // Document filters → page-1 controls (best-effort: list control per filter).
  if (doc.filters.length && pages.length) {
    for (const f of doc.filters) {
      pages[0].elements.push({
        id: uid('ctrl'), kind: 'control', name: f.name,
        controlType: 'list', controlId: ctrlId(f.name),
      });
      warnings.push(`Filter "${f.name}" emitted as an unbound list control — wire it to a column and default value in Sigma. Expression: ${trunc(f.expression)}`);
    }
  }

  const countKind = pred => pages.reduce((n, p) => n + p.elements.filter(pred).length, 0);
  const stats = {
    pages: pages.length,
    elements: countKind(() => true),
    charts: countKind(e => /-chart$/.test(e.kind) && e.kind !== 'kpi-chart'),
    kpis: countKind(e => e.kind === 'kpi-chart'),
    tables: countKind(e => e.kind === 'table' && !e.hidden),
    pivots: countKind(e => e.kind === 'pivot-table'),
    controls: countKind(e => e.kind === 'control'),
  };

  return {
    workbook: { name: workbookName || doc.name, folderId, schemaVersion, pages },
    dataModelAdditions,
    warnings,
    stats,
  };
}

function ctrlId(name) { return 'p-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function trunc(s) { return !s ? '(none)' : (s.length > 100 ? s.slice(0, 97) + '...' : s); }

function blockToElement(block, src, measFormula, dimRef, warnings) {
  const dims = (block.dimensions || []).map(displayName);
  const meas = (block.measures || []);   // keep raw name for measureMap lookup

  if (block.kind === 'cell') {
    const m = meas[0] || dims[0];
    if (!m) return null;
    const vId = uid('v');
    const isMeas = !!meas[0];
    return { id: uid('kpi'), kind: 'kpi-chart', name: block.title || displayName(m), source: src,
      columns: [{ id: vId, name: displayName(m), formula: isMeas ? measFormula(m) : dimRef(displayName(m)) }], value: { columnId: vId } };
  }

  if (block.kind === 'chart') {
    const kind = sigmaChartKind(block.chartType);
    if (!dims.length && !meas.length) return null;
    const xId = uid('x'), cols = [];
    if (dims[0]) cols.push({ id: xId, name: dims[0], formula: dimRef(dims[0]) });
    const yIds = [];
    for (const m of meas) { const id = uid('y'); cols.push({ id, name: displayName(m), formula: measFormula(m) }); yIds.push(id); }
    const el = { id: uid('chart'), kind, name: block.title || displayName(meas[0] || dims[0]), source: src, columns: cols };
    if (dims[0]) el.xAxis = { columnId: xId };
    if (yIds.length) el.yAxis = { columnIds: yIds };
    if (kind === 'bar-chart' && isHorizontalBar(block.chartType)) el.orientation = 'horizontal';
    if (kind === 'pie-chart' && dims[0]) el.color = { columnId: xId };
    return el;
  }

  if (block.kind === 'crosstab') {
    const cols = [];
    const rowIds = [], colIds_ = [], valIds = [];
    for (const d of (block.rows && block.rows.length ? block.rows.map(displayName) : dims)) { const id = uid('r'); cols.push({ id, name: d, formula: dimRef(d) }); rowIds.push(id); }
    for (const d of (block.cols || []).map(displayName)) { const id = uid('k'); cols.push({ id, name: d, formula: dimRef(d) }); colIds_.push(id); }
    for (const m of meas) { const id = uid('v'); cols.push({ id, name: displayName(m), formula: measFormula(m) }); valIds.push(id); }
    if (!rowIds.length && !colIds_.length) warnings.push(`Crosstab "${block.title || ''}" has no row/column axis — verify.`);
    return { id: uid('pivot'), kind: 'pivot-table', name: block.title || 'Crosstab', source: src,
      columns: cols, rowsBy: rowIds.map(id => ({ id })), columnsBy: colIds_.map(id => ({ id })), values: valIds };
  }

  // default: table
  const cols = [], order = [], colByName = new Map(), measColIds = [];
  for (const d of dims) { const id = uid('c'); cols.push({ id, name: d, formula: dimRef(d) }); order.push(id); colByName.set(d, id); }
  for (const m of meas) { const id = uid('c'); const nm = displayName(m); cols.push({ id, name: nm, formula: measFormula(m) }); order.push(id); colByName.set(nm, id); measColIds.push(id); }
  if (!cols.length) return null;
  const el = { id: uid('tbl'), kind: 'table', name: block.title || 'Table', source: src, columns: cols, order };
  buildGroupings(block, el, colByName, measColIds, warnings);
  return el;
}

// Build Sigma table `groupings` (and, for an ungrouped table, an element-level
// `sort`) from a block's breaks/sections + sort. Productionizes the Task-8 E2E
// harness's groupBySum:
//   - group key order = sections (outermost) then breaks
//   - calculations = every measure column id (per-group subtotals)
//   - a bare-column CumulativeSum([X]) measure is rewritten to
//     CumulativeSum(Sum([X])) so a running total is correct at the group level
//   - sort on a GROUPED table lives INSIDE the grouping entry (a top-level
//     `table.sort` on a grouped table 400s); sort on an UNGROUPED table (no
//     break/section) is the element-level `sort: [{columnId,direction}]`
//     property (live-verified Task 3: accepted, round-trips, orders the rows).
//   - grand total: Sigma's per-column grand total (the table's Totals footer,
//     spec `summary`) can't reference a column already used as a per-group
//     `calculation` and is NOT returned by the data export — so it is not
//     auto-emitted; a warning tells the author to enable it in Sigma.
// Mutates `tableEl` (adds `.groupings`/`.sort`, may rewrite a measure column formula).
function buildGroupings(block, tableEl, colByName, measColIds, warnings) {
  const groupNames = [...nameList(block.sections).map(displayName), ...nameList(block.breaks).map(displayName)];
  // Resolve the block's sort → column ids once; used inside the grouping entry
  // when grouped, or as the element-level `sort` when ungrouped.
  const sortEntries = [];
  for (const s of (block.sort || [])) {
    const cid = colByName.get(s.name) || colByName.get(displayName(s.name));
    if (cid) sortEntries.push({ columnId: cid, direction: s.direction === 'descending' ? 'descending' : 'ascending' });
    else warnings.push(`Table "${tableEl.name}": sort column "${s.name}" not found — skipped.`);
  }
  if (!groupNames.length) {
    // Ungrouped table: a sort is the element-level `sort` property. No
    // groupings key, no grand-total advisory (nothing is grouped).
    if (sortEntries.length) tableEl.sort = sortEntries;
    return;
  }
  const groupBy = [];
  for (const nm of groupNames) {
    const id = colByName.get(nm) || colByName.get(displayName(nm));
    if (!id) { warnings.push(`Table "${tableEl.name}": break/section "${nm}" is not a column on the table — skipped.`); continue; }
    groupBy.push(id);
  }
  if (!groupBy.length) return;
  // group-level running-total rewrite (bare-column CumulativeSum → wrap arg in Sum())
  for (const c of tableEl.columns) {
    const m = c.formula && c.formula.match(/^CumulativeSum\(\s*(\[[^\]]+\])\s*\)$/);
    if (m) c.formula = `CumulativeSum(Sum(${m[1]}))`;
  }
  // sort → inside the grouping entry; default ascending on the outermost key
  const sort = sortEntries.length ? sortEntries : [{ columnId: groupBy[0], direction: 'ascending' }];
  tableEl.groupings = [{ id: `grp-${tableEl.id}`, groupBy, calculations: measColIds.slice(), sort }];
  const secs = nameList(block.sections);
  if (secs.length) warnings.push(`Section "${secs.join(', ')}" approximated as an outer grouping — the master-detail band layout is not reproduced 1:1.`);
  // Per-group subtotals are emitted (the grouping's `calculations`); a
  // report-level grand total is not — enable the table's grand total in Sigma.
  warnings.push(`Table "${tableEl.name}": per-group subtotals emitted; a grand total is not auto-emitted — enable the table's grand total (Totals) in Sigma if the report needs one.`);
}
