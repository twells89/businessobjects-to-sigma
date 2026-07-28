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
 *
 * NOTE: not committed to git yet (per request) — lives in ~/bobj-webi-converter/.
 */

// ── IR ───────────────────────────────────────────────────────────────────────

/** @typedef {{kind:'table'|'crosstab'|'chart'|'cell', title?:string,
 *   dimensions:string[], measures:string[], chartType?:string,
 *   rows?:string[], cols?:string[]}} WebiBlock */
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
      for (const e of exprs) {
        const nm = e.name || e.label || e.expression || '';
        const q = (e.qualification || e.dataType || e.kind || '').toString().toLowerCase();
        if (/measure/.test(q)) meas.push(nm); else dims.push(nm);
      }
      out.push({
        kind: /cross/i.test(t) ? 'crosstab' : /chart/i.test(t) ? 'chart' : /cell/i.test(t) ? 'cell' : 'table',
        title: n.name || n.title, chartType: n.chartType || t,
        dimensions: dims.filter(Boolean), measures: meas.filter(Boolean), rows: [], cols: [],
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
  const dataModelAdditions = { metrics: [], columns: [] };
  const workbookVarFormula = new Map();   // variable name → qualified workbook formula
  for (const v of doc.variables) {
    if (!v.formula) continue;
    const tr = translateWebiFormula(v.formula, { qualification: v.qualification });
    tr.warnings.forEach(w => warnings.push(`Variable "${v.name}": ${w}`));
    const qualified = q(tr.sigma);
    if (tr.placement === 'dm') {
      const bucket = tr.kind === 'measure' ? dataModelAdditions.metrics : dataModelAdditions.columns;
      if (!bucket.some(x => x.name === v.name)) bucket.push({ id: uid('add'), name: v.name, formula: qualified });
    } else {
      workbookVarFormula.set(v.name, qualified);
    }
  }
  // Names that will become DM columns/metrics (added by Task 7) — a block
  // measure/dimension named after one of these resolves to a qualified ref
  // into the View, not the plain-universe Sum([Name]) default.
  const dmAdditionNames = new Set([...dataModelAdditions.metrics, ...dataModelAdditions.columns].map(x => x.name));

  // Resolve a block dim/measure name to the right formula source, in order:
  //   1. a workbook-placed variable → its own translated+qualified calc,
  //   2. a DM-placed variable → a qualified ref `[sourceName/Name]` to the
  //      metric/column Task 7 adds to the View (NOT Sum([Name])),
  //   3. neither → unchanged existing behavior (fallback: measFormula/dimRef).
  const resolveRef = (name, fallback) => {
    const dn = displayName(name);
    if (workbookVarFormula.has(name)) return workbookVarFormula.get(name);
    if (workbookVarFormula.has(dn)) return workbookVarFormula.get(dn);
    if (dmAdditionNames.has(name)) return q(`[${name}]`);
    if (dmAdditionNames.has(dn)) return q(`[${dn}]`);
    return fallback(name);
  };
  const resolvedMeasFormula = name => resolveRef(name, measFormula);
  const resolvedDimRef = name => resolveRef(name, dimRef);

  const pages = [];
  for (const report of doc.reports) {
    const pageId = uid('page');
    const elements = [];
    for (const block of report.blocks) {
      const el = blockToElement(block, src, resolvedMeasFormula, resolvedDimRef, warnings);
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
  const cols = [], order = [];
  for (const d of dims) { const id = uid('c'); cols.push({ id, name: d, formula: dimRef(d) }); order.push(id); }
  for (const m of meas) { const id = uid('c'); cols.push({ id, name: displayName(m), formula: measFormula(m) }); order.push(id); }
  if (!cols.length) return null;
  return { id: uid('tbl'), kind: 'table', name: block.title || 'Table', source: src, columns: cols, order };
}
