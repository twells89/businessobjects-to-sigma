/**
 * Sigma REPORT code-representation adapter and offline validator.
 *
 * Reports and workbooks share a `{ name, folderId, document }` envelope but
 * not layout semantics. Reports require absolute-pixel `<Page>` / `<Panel>`
 * roots and `<Element x y width height>` leaves. Never route reports through
 * scripts/code_rep.mjs (workbook grid layout).
 */

const REPORT_DOC_KEYS = [
  'schemaVersion', 'kind', 'config', 'elements', 'pages', 'panels', 'layout',
  'settings', 'agents',
];

const WORKBOOK_ONLY_KINDS = new Set([
  'chat', 'container', 'form', 'navigation', 'page-break',
  'repeated-container', 'tabbed-container',
]);
const UNSUPPORTED_REPORT_KINDS = new Set(['waterfall-chart', 'progress']);
const SCHEMA_ONLY_KINDS = new Set(['button', 'embed', 'input-table', 'plugin']);
const PROVEN_OR_DOCUMENTED_KINDS = new Set([
  'area-chart', 'bar-chart', 'combo-chart', 'control', 'divider',
  'geography-map', 'image', 'kpi-chart', 'line-chart', 'pivot-table',
  'point-map', 'region-map', 'scatter-chart', 'table', 'text',
]);

export function reportDocument(spec) {
  if (!isObject(spec)) return {};
  if (isObject(spec.document)) return spec.document;
  return Object.fromEntries(
    Object.entries(spec).filter(([key]) => REPORT_DOC_KEYS.includes(key)),
  );
}

export function reportMetadata(spec) {
  if (!isObject(spec)) return {};
  return Object.fromEntries(
    Object.entries(spec).filter(
      ([key]) => key !== 'document' && !REPORT_DOC_KEYS.includes(key),
    ),
  );
}

export function prepareReportForPost(report) {
  if (!isObject(report)) throw new Error('prepareReportForPost: expected an object');
  const metadata = reportMetadata(report);
  for (const key of ['name', 'folderId', 'description']) {
    if (report[key] != null && metadata[key] == null) metadata[key] = report[key];
  }
  const document = { ...reportDocument(report) };
  document.kind ||= 'report';
  document.schemaVersion ??= 1;
  document.elements = Array.isArray(document.elements) ? document.elements : [];
  document.pages = Array.isArray(document.pages) ? document.pages : [];
  document.panels = Array.isArray(document.panels) ? document.panels : [];
  document.config ||= { pageWidth: 816, pageHeight: 1056, margin: 48 };
  if (!document.layout) {
    document.layout = buildAbsoluteLayout({
      pages: document.pages,
      panels: document.panels,
      placements: document.elements.map((element, index) => ({
        elementId: element.id,
        rootId: document.pages[0]?.id,
        rootType: 'page',
        x: document.config.margin,
        y: document.config.margin + index * 48,
        width: Math.max(1, document.config.pageWidth - 2 * document.config.margin),
        height: 40,
      })),
    });
  }
  return { ...metadata, document };
}

export function prepareReportForUpdate(spec) {
  const document = reportDocument(spec);
  return { document };
}

export function buildAbsoluteLayout({ pages = [], panels = [], placements = [] }) {
  const byRoot = new Map();
  for (const placement of placements) {
    if (!placement?.rootId || !placement?.elementId) continue;
    const key = `${placement.rootType || 'page'}:${placement.rootId}`;
    if (!byRoot.has(key)) byRoot.set(key, []);
    byRoot.get(key).push(placement);
  }
  const lines = ['<?xml version="1.0" encoding="utf-8"?>'];
  for (const page of pages) {
    lines.push(`<Page id="${xml(page.id)}">`);
    for (const placement of byRoot.get(`page:${page.id}`) || []) {
      lines.push(`  ${elementNode(placement)}`);
    }
    lines.push('</Page>');
  }
  for (const panel of panels) {
    lines.push(`<Panel id="${xml(panel.id)}" type="${xml(panel.type)}">`);
    for (const placement of byRoot.get(`panel:${panel.id}`) || []) {
      lines.push(`  ${elementNode(placement)}`);
    }
    lines.push('</Panel>');
  }
  return lines.join('\n');
}

export function validateReportSpec(spec, { mode = 'create' } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(spec)) return { valid: false, errors: ['spec must be an object'], warnings };
  if (mode === 'update') {
    const keys = Object.keys(spec);
    if (keys.length !== 1 || keys[0] !== 'document') {
      errors.push('update body must contain exactly { document }');
    }
  } else {
    if (!nonEmpty(spec.name)) errors.push('create body requires outer name');
    if (!nonEmpty(spec.folderId)) errors.push('create body requires outer folderId');
    if (!isObject(spec.document)) errors.push('create body requires document');
  }

  const doc = reportDocument(spec);
  if (doc.kind !== 'report') errors.push('document.kind must be "report"');
  if (!Number.isFinite(Number(doc.schemaVersion))) errors.push('document.schemaVersion must be numeric');
  if (!Array.isArray(doc.elements)) errors.push('document.elements must be an array');
  if (!Array.isArray(doc.pages) || doc.pages.length === 0) errors.push('document.pages must be a non-empty array');
  if (doc.pages?.length > 1000) errors.push('report exceeds 1,000-page policy limit');
  if (!isObject(doc.config)) errors.push('document.config is required');

  const width = Number(doc.config?.pageWidth);
  const height = Number(doc.config?.pageHeight);
  const margin = Number(doc.config?.margin);
  if (!(width > 0 && width <= 10000)) errors.push('config.pageWidth must be > 0 and <= 10000');
  if (!(height > 0 && height <= 10000)) errors.push('config.pageHeight must be > 0 and <= 10000');
  if (!(margin >= 0) || margin * 2 >= width || margin * 2 >= height) {
    errors.push('config.margin must leave a positive page content area');
  }

  const elements = Array.isArray(doc.elements) ? doc.elements : [];
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const panels = Array.isArray(doc.panels) ? doc.panels : [];
  const allIds = new Set();
  for (const [collectionName, collection] of [['element', elements], ['page', pages], ['panel', panels]]) {
    for (const item of collection) {
      if (!nonEmpty(item?.id)) {
        errors.push(`${collectionName} is missing id`);
      } else if (allIds.has(item.id)) {
        errors.push(`duplicate id: ${item.id}`);
      } else {
        allIds.add(item.id);
      }
    }
  }

  const pageIds = new Set(pages.map(page => page.id));
  const panelIds = new Set(panels.map(panel => panel.id));
  const panelById = new Map(panels.map(panel => [panel.id, panel]));
  const elementIds = new Set(elements.map(element => element.id));
  for (const panel of panels) {
    if (!['header', 'footer'].includes(panel.type)) {
      errors.push(`panel ${panel.id} type must be header or footer`);
    }
    if (!(Number(panel.config?.height) > 0)) {
      errors.push(`panel ${panel.id} config.height must be positive`);
    }
    for (const pageId of panel.pages || []) {
      if (!pageIds.has(pageId)) errors.push(`panel ${panel.id} references unknown page ${pageId}`);
    }
  }

  for (const element of elements) {
    if (WORKBOOK_ONLY_KINDS.has(element.kind)) {
      errors.push(`element ${element.id} uses workbook-only kind ${element.kind}`);
    } else if (UNSUPPORTED_REPORT_KINDS.has(element.kind)) {
      errors.push(`element ${element.id} uses unsupported report kind ${element.kind}`);
    } else if (element.kind === 'control' && element.controlType === 'synced') {
      errors.push(`element ${element.id} uses unsupported synced control`);
    } else if (SCHEMA_ONLY_KINDS.has(element.kind)) {
      warnings.push(`element ${element.id} uses schema-only kind ${element.kind}; require live PDF evidence`);
    } else if (!PROVEN_OR_DOCUMENTED_KINDS.has(element.kind)) {
      warnings.push(`element ${element.id} uses unknown report kind ${element.kind}`);
    }
  }

  const layout = String(doc.layout || '');
  if (!layout.trim()) errors.push('document.layout is required');
  if (/grid(Column|Row|Template)|<\s*(Container|TabbedContainer|Tab|Overlay)\b/i.test(layout)) {
    errors.push('layout contains workbook grid/container syntax');
  }
  const roots = parseLayoutRoots(layout);
  const pageRootIds = new Set(roots.filter(root => root.type === 'page').map(root => root.id));
  const panelRootIds = new Set(roots.filter(root => root.type === 'panel').map(root => root.id));
  for (const id of pageIds) if (!pageRootIds.has(id)) errors.push(`page ${id} has no matching layout root`);
  for (const id of panelIds) if (!panelRootIds.has(id)) errors.push(`panel ${id} has no matching layout root`);
  for (const root of roots) {
    if (root.type === 'page' && !pageIds.has(root.id)) errors.push(`layout references unknown page ${root.id}`);
    if (root.type === 'panel' && !panelIds.has(root.id)) errors.push(`layout references unknown panel ${root.id}`);
    if (root.type === 'panel' && panelById.get(root.id)?.type !== root.panelType) {
      errors.push(`panel ${root.id} layout type does not match metadata`);
    }
  }

  const placements = roots.flatMap(root =>
    root.elements.map(element => ({ ...element, root })));
  const placementCount = new Map();
  for (const placement of placements) {
    placementCount.set(placement.elementId, (placementCount.get(placement.elementId) || 0) + 1);
    if (!elementIds.has(placement.elementId)) errors.push(`layout references undeclared element ${placement.elementId}`);
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(placement[key])) errors.push(`element ${placement.elementId} ${key} is not numeric`);
    }
    if (placement.x < 0 || placement.y < 0 || !(placement.width > 0) || !(placement.height > 0)) {
      errors.push(`element ${placement.elementId} has invalid bounds`);
    }
    const boundWidth = placement.root.type === 'page'
      ? width
      : width;
    const boundHeight = placement.root.type === 'page'
      ? height
      : Number(panelById.get(placement.root.id)?.config?.height);
    if (placement.x + placement.width > boundWidth + 0.001 ||
        placement.y + placement.height > boundHeight + 0.001) {
      errors.push(`element ${placement.elementId} exceeds ${placement.root.type} ${placement.root.id} bounds`);
    }
  }
  for (const id of elementIds) {
    const count = placementCount.get(id) || 0;
    if (count !== 1) errors.push(`element ${id} must be placed exactly once (found ${count})`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function normalizeReportForComparison(spec) {
  const doc = reportDocument(spec);
  return {
    kind: doc.kind,
    schemaVersion: doc.schemaVersion,
    config: doc.config,
    pages: sortById(doc.pages),
    panels: sortById(doc.panels),
    elements: sortById(doc.elements).map(normalizeElement),
    layout: String(doc.layout || '').replace(/\s+/g, ' ').trim(),
  };
}

function parseLayoutRoots(layout) {
  const roots = [];
  const rootRe = /<(Page|Panel)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const match of layout.matchAll(rootRe)) {
    const type = match[1].toLowerCase();
    const attrs = parseAttrs(match[2]);
    const elements = [];
    for (const child of match[3].matchAll(/<Element\b([^>]*)\/>/g)) {
      const a = parseAttrs(child[1]);
      elements.push({
        elementId: a.elementId,
        x: Number(a.x),
        y: Number(a.y),
        width: Number(a.width),
        height: Number(a.height),
      });
    }
    roots.push({ type, id: attrs.id, panelType: attrs.type, elements });
  }
  return roots;
}

function parseAttrs(source) {
  const attrs = {};
  for (const match of String(source).matchAll(/([A-Za-z][\w-]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function elementNode(placement) {
  return `<Element elementId="${xml(placement.elementId)}" x="${finite(placement.x)}" y="${finite(placement.y)}" width="${positive(placement.width)}" height="${positive(placement.height)}"/>`;
}

function finite(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid report coordinate: ${value}`);
  return round(n);
}

function positive(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid report dimension: ${value}`);
  return round(n);
}

function round(value) {
  return Math.round(value);
}

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sortById(value) {
  return [...(Array.isArray(value) ? value : [])]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function normalizeElement(value) {
  const element = { ...value };
  if (typeof element.body === 'string') element.body = normalizeMarkdown(element.body);
  if (Array.isArray(element.columns)) {
    element.columns = sortById(element.columns).map(column => ({
      ...column,
      ...(typeof column.formula === 'string'
        ? { formula: normalizeFormulaReferences(column.formula) }
        : {}),
    }));
  }
  const hiddenIds = new Set(
    (element.columns || []).filter(column => column.hidden).map(column => column.id),
  );
  if (Array.isArray(element.order)) {
    element.order = element.order.filter(id => !hiddenIds.has(id));
  }
  if (Array.isArray(element.sort)) {
    element.sort = element.sort.map(item => {
      if (item.nulls !== 'connection-default') return item;
      const { nulls, ...rest } = item;
      return rest;
    });
  }
  return element;
}

function normalizeFormulaReferences(formula) {
  return formula.replace(/\[([^/\]]+)\/([^\]]+)\]/g, (_, source, column) =>
    `[${normalizeReferencePart(source)}/${normalizeReferencePart(column)}]`);
}

function normalizeReferencePart(value) {
  return String(value).trim().replace(/[\s_]+/g, '_').toUpperCase();
}

function normalizeMarkdown(value) {
  return String(value)
    .replace(/\*\*(<span\b[^>]*>)([\s\S]*?)(<\/span>)\*\*/gi, '$1**$2**$3')
    .replace(/ {2,}\n|\\\n/g, '\n')
    .replace(/\n{2,}/g, '\n');
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

