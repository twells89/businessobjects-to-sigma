/**
 * Shape adapter for the Sigma WORKBOOK code representation
 * (POST /v2/workbooks/spec, GET|PUT /v2/workbooks/{id}/spec, POST /v2/workbooks/spec/verify).
 *
 * Verified live 2026-08-03/04 (sigma-skills / sigma-migration-skills): this surface
 * nests non-metadata fields under a top-level `document` key and REJECTS the old
 * flat body with HTTP 400 — including on /verify. `document.kind: "workbook"` is
 * required (live 2026-08-08), and every element must be placed in `document.layout`.
 *
 * The DATA-MODEL code-rep surface (`/v2/dataModels/.../spec`) is NOT changing —
 * do NOT use this adapter on data-model payloads (wrapping those 400s on a
 * missing top-level `schemaVersion`).
 *
 * Converter output in this repo may still nest `pages[].elements` for local
 * convenience; `prepareWorkbookForPost` flattens + wraps at the API boundary.
 */

export const DOC_KEYS = [
  'schemaVersion', 'pages', 'elements', 'overlays', 'panels',
  'kind', 'layout', 'settings', 'agents',
];

export const LEGACY_THEME_KEYS = ['themeName', 'themeOverrides'];
export const LEGACY_HORIZONTAL_ALIGN = { start: 'left', middle: 'center', end: 'right' };
export const LEGACY_VERTICAL_ALIGN = { start: 'top', middle: 'center', end: 'bottom' };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function document(response) {
  if (!isObj(response)) return {};
  const doc = isObj(response.document)
    ? response.document
    : Object.fromEntries(Object.entries(response).filter(([k]) => DOC_KEYS.includes(k)));
  return foldLegacyTheme(doc, response);
}

function foldLegacyTheme(doc, source) {
  const name = doc.themeName || source.themeName;
  const overrides = doc.themeOverrides || source.themeOverrides;
  const hasOv = isObj(overrides) && Object.keys(overrides).length > 0;
  const hasLegacyKey = LEGACY_THEME_KEYS.some((k) => k in doc);
  if (!name && !hasOv && !hasLegacyKey) return doc;

  const out = Object.fromEntries(
    Object.entries(doc).filter(([k]) => !LEGACY_THEME_KEYS.includes(k)),
  );
  const settings = { ...(out.settings || {}) };
  const theme = { ...(settings.theme || {}) };
  if (name && !theme.name) theme.name = name;
  if (hasOv) theme.overrides = { ...(theme.overrides || {}), ...overrides };
  if (Object.keys(theme).length === 0) return out;
  settings.theme = theme;
  out.settings = settings;
  return out;
}

/** Set a workbook theme using the current settings.theme shape. */
export function setTheme(doc, { name = null, overrides = null } = {}) {
  const hasOv = isObj(overrides) && Object.keys(overrides).length > 0;
  if (!name && !hasOv) return doc;
  doc.settings = doc.settings || {};
  doc.settings.theme = doc.settings.theme || {};
  if (name) doc.settings.theme.name = name;
  if (hasOv) {
    doc.settings.theme.overrides = { ...(doc.settings.theme.overrides || {}), ...overrides };
  }
  return doc;
}

/** Read a workbook theme from either the current or legacy shape. */
export function theme(spec) {
  const value = (document(spec).settings || {}).theme || {};
  return { name: value.name ?? null, overrides: value.overrides || {} };
}

export function metadata(response) {
  if (!isObj(response)) return {};
  return Object.fromEntries(
    Object.entries(response).filter(
      ([k]) => k !== 'document' && !DOC_KEYS.includes(k) && !LEGACY_THEME_KEYS.includes(k),
    ),
  );
}

export function workbookElements(spec) {
  const doc = document(spec);
  if (Array.isArray(doc.elements)) return doc.elements.filter(isObj);
  return (Array.isArray(doc.pages) ? doc.pages : [])
    .filter(isObj)
    .flatMap((page) => (Array.isArray(page.elements) ? page.elements.filter(isObj) : []));
}

/** Return layout membership as page id -> ordered unique element ids. */
export function workbookPageElementIds(spec) {
  const result = {};
  const layout = String(document(spec).layout || '');
  const pagePattern = /<Page\b[^>]*\bid="([^"]*)"[^>]*>(.*?)<\/Page>/gs;
  for (const match of layout.matchAll(pagePattern)) {
    result[match[1]] = [...new Set(
      [...match[2].matchAll(
        /<(?:Element|Container|TabbedContainer|LayoutElement|GridContainer)\b[^>]*\belementId="([^"]*)"/g,
      )].map((element) => element[1]),
    )];
  }
  return result;
}

/** Return element id -> page metadata, inferred from document.layout. */
export function workbookPageByElement(spec) {
  const doc = document(spec);
  const pages = Array.isArray(doc.pages) ? doc.pages.filter(isObj) : [];
  const pagesById = Object.fromEntries(
    pages.filter((page) => page.id).map((page) => [page.id, page]),
  );
  const result = {};
  for (const [pageId, elementIds] of Object.entries(workbookPageElementIds(doc))) {
    const page = pagesById[pageId] || { id: pageId, name: pageId };
    for (const elementId of elementIds) result[elementId] ||= page;
  }
  return result;
}

/** Return [element, page] pairs without re-nesting the wire representation. */
export function workbookElementsWithPages(spec) {
  const pageByElement = workbookPageByElement(spec);
  return workbookElements(spec).map((element) => [
    element,
    pageByElement[element.id || element.elementId],
  ]);
}

function flattenElements(doc) {
  if (!isObj(doc) || !Array.isArray(doc.pages)) return doc;
  const nested = [];
  const pages = doc.pages.map((page) => {
    const copy = { ...page };
    if (Array.isArray(copy.elements)) nested.push(...copy.elements);
    delete copy.elements;
    return copy;
  });
  const elements = [];
  const seen = new Set();
  for (const element of [...(Array.isArray(doc.elements) ? doc.elements : []), ...nested]) {
    const id = isObj(element) ? element.id : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    elements.push(element);
  }
  return { ...doc, pages, elements };
}

export function canonicalizeLayout(layoutXml) {
  return String(layoutXml || '')
    .replace(/<([/]?)LayoutElement\b/g, '<$1Element')
    .replace(/<([/]?)GridContainer\b/g, '<$1Container');
}

function canonicalizeElement(element) {
  if (!isObj(element)) return element;
  if (element.kind === 'text' && element.verticalAlign in LEGACY_VERTICAL_ALIGN) {
    return { ...element, verticalAlign: LEGACY_VERTICAL_ALIGN[element.verticalAlign] };
  }
  if (element.kind === 'kpi-chart' && isObj(element.layout)) {
    const layout = { ...element.layout };
    if (layout.anchor in LEGACY_HORIZONTAL_ALIGN) {
      layout.anchor = LEGACY_HORIZONTAL_ALIGN[layout.anchor];
    }
    if (layout.verticalAnchor in LEGACY_VERTICAL_ALIGN) {
      layout.verticalAnchor = LEGACY_VERTICAL_ALIGN[layout.verticalAnchor];
    }
    return { ...element, layout };
  }
  if (element.kind === 'tabbed-container' && isObj(element.tabBar)
      && element.tabBar.alignment in LEGACY_HORIZONTAL_ALIGN) {
    return {
      ...element,
      tabBar: {
        ...element.tabBar,
        alignment: LEGACY_HORIZONTAL_ALIGN[element.tabBar.alignment],
      },
    };
  }
  if (element.kind === 'divider' && element.align in LEGACY_VERTICAL_ALIGN) {
    const mapping = element.direction === 'vertical'
      ? LEGACY_HORIZONTAL_ALIGN
      : LEGACY_VERTICAL_ALIGN;
    return { ...element, align: mapping[element.align] };
  }
  return element;
}

function canonicalizeOverlay(overlay) {
  if (!isObj(overlay) || !isObj(overlay.drawer) || !('position' in overlay.drawer)) {
    return overlay;
  }
  const { position: _removed, ...drawer } = overlay.drawer;
  return { ...overlay, drawer };
}

/**
 * Generic full-width stacked layout: one `<Page>` per page, each element spanning
 * 24 columns × `rowSpan` rows. Good enough for migration first-drafts (Webi →
 * workbook); polish in Sigma or replace with a custom layout later.
 *
 * Accepts either legacy `pages[].elements` or already-flat `{ pages, elements }`
 * with membership inferred from a prior layout (pages-only → no elements placed).
 */
export function stackedLayout(pages, { rowSpan = 14, elementsByPageId = null } = {}) {
  const pageXmls = (pages || []).filter(isObj).map((page) => {
    const els = Array.isArray(elementsByPageId?.[page.id])
      ? elementsByPageId[page.id]
      : (Array.isArray(page.elements) ? page.elements : []);
    let row = 1;
    const children = els.filter(isObj).map((el) => {
      const r0 = row;
      const r1 = row + rowSpan;
      row = r1;
      return `  <Element elementId="${el.id}" gridColumn="1 / 25" gridRow="${r0} / ${r1}"/>`;
    });
    return [
      `<Page type="grid" gridTemplateColumns="repeat(24, 1fr)" gridTemplateRows="auto" id="${page.id}">`,
      ...children,
      `</Page>`,
    ].join('\n');
  });
  return ['<?xml version="1.0" encoding="utf-8"?>', ...pageXmls].join('\n');
}

export function wrap(doc, extra = {}) {
  const flattened = flattenElements(doc);
  let canonical = flattened;
  if (isObj(flattened)) {
    canonical = { ...flattened };
    if (Array.isArray(flattened.elements)) {
      canonical.elements = flattened.elements.map(canonicalizeElement);
    }
    if (Array.isArray(flattened.overlays)) {
      canonical.overlays = flattened.overlays.map(canonicalizeOverlay);
    }
    if ('layout' in flattened) canonical.layout = canonicalizeLayout(flattened.layout);
  }
  return { ...extra, document: canonical };
}

/**
 * Turn a converter / probe workbook (flat OR already-wrapped) into the live
 * wire body for POST /v2/workbooks/spec:
 *   { name, folderId, description?, document: { schemaVersion, kind, pages, elements, layout, … } }
 *
 * - Ensures `document.kind === "workbook"` (required since 2026-08-08).
 * - Flattens `pages[].elements` → `document.elements` (API rejects nested).
 * - Synthesizes a stacked `layout` when missing and there are elements to place.
 */
export function prepareWorkbookForPost(workbook) {
  if (!isObj(workbook)) throw new Error('prepareWorkbookForPost: expected a workbook object');

  const outer = metadata(workbook);
  // Prefer explicit outer metadata; fall back to common flat keys.
  if (workbook.name != null && outer.name == null) outer.name = workbook.name;
  if (workbook.folderId != null && outer.folderId == null) outer.folderId = workbook.folderId;
  if (workbook.description != null && outer.description == null) outer.description = workbook.description;

  const rawDoc = document(workbook);
  // Capture nested elements BEFORE flatten loses page membership (needed for layout).
  const elementsByPageId = {};
  for (const page of (Array.isArray(rawDoc.pages) ? rawDoc.pages : [])) {
    if (!isObj(page) || !page.id) continue;
    if (Array.isArray(page.elements)) elementsByPageId[page.id] = page.elements.filter(isObj);
  }

  const flat = flattenElements({ ...rawDoc, kind: rawDoc.kind || 'workbook' });
  const hasElements = Array.isArray(flat.elements) && flat.elements.length > 0;
  if (hasElements && !flat.layout) {
    flat.layout = stackedLayout(flat.pages, { elementsByPageId });
  } else if (flat.layout) {
    flat.layout = canonicalizeLayout(flat.layout);
  }
  if (!flat.kind) flat.kind = 'workbook';
  if (!Array.isArray(flat.elements)) flat.elements = [];
  if (!Array.isArray(flat.pages)) flat.pages = [];

  return wrap(flat, outer);
}
