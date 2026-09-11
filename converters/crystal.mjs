/**
 * Crystal Reports IR → Sigma pixel-perfect Report code representation.
 *
 * The first compatibility profile targets the pinned Meridian customer
 * statement. It deliberately binds to a Snowflake wide view so Sigma Reports
 * uses the live-proven warehouse-table source path and avoids lossy multi-hop
 * data-model relationships. Unsupported Crystal objects remain in a
 * degradation ledger; nothing is silently dropped.
 */

import {
  formatFromMask,
  sigmaDisplayName,
  sigmaShortId,
  resetIds,
} from '../helpers.mjs';
import { translateCrystalFormula } from './crystal-formula.mjs';
import { buildAbsoluteLayout, prepareReportForPost } from '../scripts/report-code-rep.mjs';
import { prepareWorkbookForPost } from '../scripts/code_rep.mjs';

const MERIDIAN_COLUMNS = [
  ['customer_id', 'Customer Id', null],
  ['customer_name', 'Customer', null],
  ['invoice_number', 'Invoice #', null],
  ['invoice_date', 'Invoice Date', dateFormat()],
  ['due_date', 'Due Date', dateFormat()],
  ['status_name', 'Status', null],
  ['currency_code', 'Cur', null],
  ['charges', 'Charges', moneyFormat()],
  ['payments', 'Payments', moneyFormat()],
  ['balance', 'Balance', moneyFormat()],
];

export function convertCrystalToReport(ir, options = {}) {
  if (!ir?.sections || !ir?.data) throw new Error('convertCrystalToReport: expected Crystal IR');
  resetIds();
  const {
    folderId = '<FOLDER_ID>',
    connectionId = '<CONNECTION_ID>',
    database = 'CRYSTAL_MIGRATION_DEMO',
    schema = 'PUBLIC',
    sourceTable = 'CUSTOMER_STATEMENT_ROWS',
    schemaVersion = 1,
    reportName = ir.report?.name || 'Crystal Report',
    profile = detectProfile(ir),
    // Sigma table groupings aggregate the displayed rows. Preserve invoice
    // detail by default; opt in only when the target should be a customer-level
    // summary rather than the Crystal statement's transaction lines.
    groupCustomers = false,
  } = options;
  const warnings = [];
  const degradationLedger = [];
  const source = {
    kind: 'warehouse-table',
    connectionId,
    path: [database, schema, sourceTable],
  };

  const formulas = (ir.data.formulas || []).map(formula => ({
    name: formula.name,
    ...translateCrystalFormula(formula.text),
  }));
  for (const formula of formulas) {
    for (const warning of formula.warnings) {
      warnings.push(`Formula "${formula.name}": ${warning}`);
    }
    if (!formula.fullyTranslated) {
      degradationLedger.push({
        sourceType: 'formula',
        sourceId: formula.name,
        disposition: 'translated-with-warning',
        message: formula.warnings.join(' '),
        source: formula.source,
      });
    }
  }

  if (profile !== 'meridian-customer-statement') {
    warnings.push(`No tested Crystal profile matched "${reportName}"; emitted a generic field table.`);
  }

  const pageWidth = clamp(Math.round(ir.page.widthTwips / 15), 320, 10000);
  const pageHeight = clamp(Math.round(ir.page.heightTwips / 15), 320, 10000);
  const margin = clamp(Math.round(Math.max(
    ir.page.marginsTwips?.left || 0,
    ir.page.marginsTwips?.right || 0,
    ir.page.marginsTwips?.top || 0,
    ir.page.marginsTwips?.bottom || 0,
  ) / 15), 0, Math.floor(Math.min(pageWidth, pageHeight) / 4));
  const pageId = 'crystal-page-1';
  const headerId = 'crystal-page-header';
  const footerId = 'crystal-page-footer';

  const columns = buildColumns(profile, ir, sourceTable);
  const columnByPhysical = new Map(columns.map(column => [column.physical, column]));
  const tableId = 'statement-detail';
  const table = {
    id: tableId,
    kind: 'table',
    name: 'Customer Statement Detail',
    source,
    columns: columns.map(({ physical, ...column }) => column),
    order: columns.filter(column => !column.hidden).map(column => column.id),
    sort: [
      { columnId: columnByPhysical.get('customer_id')?.id, direction: 'ascending' },
      { columnId: columnByPhysical.get('invoice_date')?.id, direction: 'ascending' },
      { columnId: columnByPhysical.get('invoice_number')?.id, direction: 'ascending' },
    ].filter(sort => sort.columnId),
  };
  if (groupCustomers && columnByPhysical.has('customer_id')) {
    const totalId = 'col-customer-balance-total';
    table.columns.push({
      id: totalId,
      name: 'Customer Balance Total',
      formula: `Sum([${sourceTable}/BALANCE])`,
      format: moneyFormat(),
      hidden: true,
    });
    table.groupings = [{
      id: 'group-customer',
      groupBy: [columnByPhysical.get('customer_id').id],
      calculations: [totalId],
      sort: [{ columnId: columnByPhysical.get('customer_id').id, direction: 'ascending' }],
    }];
  }

  const totalColumnId = 'kpi-total-balance';
  const totalKpi = {
    id: 'statement-total',
    kind: 'kpi-chart',
    name: 'Grand Total Due (USD)',
    source,
    columns: [{
      id: totalColumnId,
      name: 'Grand Total Due',
      formula: `Sum([${sourceTable}/USD_BALANCE])`,
      format: moneyFormat('$'),
    }],
    value: { columnId: totalColumnId },
  };

  const title = {
    id: 'statement-title',
    kind: 'text',
    body: '## STATEMENT OF ACCOUNT',
  };
  const company = {
    id: 'company-heading',
    kind: 'text',
    body: '**MERIDIAN GLOBAL LOGISTICS**  \nWeena 340 · 3012 NJ Rotterdam · Netherlands',
  };
  const agingNote = {
    id: 'aging-note',
    kind: 'text',
    body: 'Amounts and payment totals come from the live Snowflake sample.',
  };
  const headerText = {
    id: 'header-text',
    kind: 'text',
    body: '**<span style="color: #FFFFFF">MERIDIAN · CUSTOMER STATEMENT</span>**',
  };
  const footerText = {
    id: 'footer-text',
    kind: 'text',
    body: 'Crystal Reports migration proof · Validate totals against Snowflake',
  };

  const elements = [title, company, totalKpi, agingNote, table, headerText, footerText];
  const headerHeight = 42;
  const footerHeight = 30;
  const contentWidth = Math.max(1, pageWidth - margin * 2);
  // Page-root coordinates are relative to Sigma's already-margined body.
  // Panel roots use the full physical page, so their children still need the
  // explicit margin below.
  const bodyTop = 16;
  const tableTop = bodyTop + 158;
  const tableHeight = Math.max(
    120,
    Math.min(680, pageHeight - tableTop - margin * 2 - headerHeight - footerHeight),
  );
  const placements = [
    place(pageId, 'page', title.id, 0, bodyTop, contentWidth * 0.62, 58),
    place(pageId, 'page', company.id, 0, bodyTop + 62, contentWidth * 0.62, 54),
    place(pageId, 'page', totalKpi.id, contentWidth * 0.66, bodyTop, contentWidth * 0.34, 92),
    place(pageId, 'page', agingNote.id, 0, bodyTop + 118, contentWidth, 34),
    place(pageId, 'page', table.id, 0, tableTop, contentWidth, tableHeight),
    place(headerId, 'panel', headerText.id, margin, 8, contentWidth, 26),
    place(footerId, 'panel', footerText.id, margin, 5, contentWidth, 20),
  ];

  for (const section of ir.sections) {
    for (const object of section.objects || []) {
      if (['picture', 'line', 'box'].includes(object.kind)) {
        degradationLedger.push({
          sourceType: 'report-object',
          sourceId: object.id,
          sourceSection: section.name,
          disposition: object.kind === 'picture' ? 'omitted-image' : 'redesigned-in-table',
          message: object.kind === 'picture'
            ? 'Embedded Crystal image is not yet available as a portable URL/data URI.'
            : `${object.kind} geometry was normalized into the Sigma table/page design.`,
        });
      } else if (['subreport', 'chart', 'crosstab', 'ole', 'map', 'unknown'].includes(object.kind)) {
        degradationLedger.push({
          sourceType: 'report-object',
          sourceId: object.id,
          sourceSection: section.name,
          disposition: 'manual-or-static-fallback',
          message: `${object.kind} is not emitted in the first compatibility profile.`,
        });
      }
    }
  }
  for (const parameter of ir.data.parameters || []) {
    degradationLedger.push({
      sourceType: 'parameter',
      sourceId: parameter.name,
      disposition: 'warehouse-default',
      message: 'First proof uses warehouse defaults/current date; author a non-synced report control after targeted live validation.',
    });
  }
  warnings.push(...degradationLedger.map(item => `${item.sourceType} "${item.sourceId}": ${item.message}`));

  const report = prepareReportForPost({
    name: reportName,
    folderId,
    description: 'Migrated from SAP Crystal Reports; see degradation ledger in migration artifacts.',
    document: {
      schemaVersion,
      kind: 'report',
      config: { pageWidth, pageHeight, margin },
      elements,
      pages: [{ id: pageId, name: 'Customer Statement' }],
      panels: [
        {
          id: headerId,
          type: 'header',
          title: 'Statement header',
          pages: [pageId],
          config: { height: headerHeight, backgroundColor: '#1F3A5F' },
        },
        {
          id: footerId,
          type: 'footer',
          title: 'Statement footer',
          pages: [pageId],
          config: { height: footerHeight, backgroundColor: '#F5F7FA' },
        },
      ],
      layout: buildAbsoluteLayout({
        pages: [{ id: pageId }],
        panels: [{ id: headerId, type: 'header' }, { id: footerId, type: 'footer' }],
        placements,
      }),
    },
  });

  return {
    report,
    dataModelAdditions: {
      columns: formulas.filter(formula => formula.placement === 'dm' && formula.kind === 'dimension')
        .map(formula => ({ name: formula.name, formula: formula.sigma })),
      metrics: formulas.filter(formula => formula.placement === 'dm' && formula.kind === 'measure')
        .map(formula => ({ name: formula.name, formula: formula.sigma })),
    },
    formulas,
    warnings,
    degradationLedger,
    stats: {
      pages: 1,
      panels: 2,
      elements: elements.length,
      tableColumns: table.columns.length,
      sourceSections: ir.sections.length,
      sourceObjects: ir.sections.reduce((count, section) => count + (section.objects?.length || 0), 0),
      formulas: formulas.length,
      parameters: ir.data.parameters?.length || 0,
      degradations: degradationLedger.length,
    },
  };
}

/**
 * Crystal IR → responsive Sigma workbook first draft.
 *
 * This target intentionally redesigns fixed bands as one ungrouped interactive
 * detail table. It preserves source fields and translatable formulas
 * while recording controls, groups, summaries, and fixed-page behavior in the
 * degradation ledger until they can be rebuilt without changing grain.
 */
export function convertCrystalToWorkbook(ir, options = {}) {
  if (!ir?.sections || !ir?.data) throw new Error('convertCrystalToWorkbook: expected Crystal IR');
  resetIds();
  const {
    folderId = '<FOLDER_ID>',
    connectionId = '<CONNECTION_ID>',
    dataModelId = null,
    dataModelElementId = null,
    sourceName = null,
    schemaVersion = 1,
    workbookName = `${ir.report?.name || 'Crystal Report'} (Interactive)`,
  } = options;
  const tables = ir.data.tables || [];
  const explicitSourceName = typeof sourceName === 'string' && sourceName.trim()
    ? sourceName.trim()
    : null;
  const hasAnyDataModelBinding = Boolean(dataModelId || dataModelElementId);
  const hasCompleteDataModelBinding = Boolean(
    dataModelId && dataModelElementId && explicitSourceName,
  );
  if (hasAnyDataModelBinding && !hasCompleteDataModelBinding) {
    throw new Error(
      'Crystal workbook data-model binding requires dataModelId, dataModelElementId, and explicit sourceName',
    );
  }
  const explicitWideSource = typeof options.sourceTable === 'string'
    && options.sourceTable.trim().length > 0;
  if (!hasCompleteDataModelBinding && tables.length > 1 && !explicitWideSource) {
    throw new Error(
      'Crystal workbook multi-table IR requires an explicit wide warehouse source '
      + '(sourceTable/database/schema) or a complete data-model binding',
    );
  }
  const singleTable = tables.length === 1 ? tables[0] : null;
  const qualifiedParts = String(singleTable?.qualifiedName || '').split('.').filter(Boolean);
  const sourceTable = explicitWideSource
    ? options.sourceTable.trim()
    : singleTable?.name || qualifiedParts.at(-1);
  const database = options.database
    ?? singleTable?.database
    ?? (qualifiedParts.length >= 3 ? qualifiedParts.at(-3) : null);
  const schema = options.schema
    ?? singleTable?.schema
    ?? (qualifiedParts.length >= 2 ? qualifiedParts.at(-2) : null);
  if (!hasCompleteDataModelBinding && (!sourceTable || !database || !schema)) {
    throw new Error(
      'Crystal workbook warehouse binding requires sourceTable, database, and schema; '
      + 'single-table IR values are used when available',
    );
  }

  const warnings = [];
  const degradationLedger = [];
  const source = hasCompleteDataModelBinding
    ? { kind: 'data-model', dataModelId, elementId: dataModelElementId }
    : { kind: 'warehouse-table', connectionId, path: [database, schema, sourceTable] };
  const qualifier = hasCompleteDataModelBinding ? explicitSourceName : sourceTable;
  const fields = ir.data.fields || [];
  const duplicateNames = new Set();
  const counts = new Map();
  for (const field of fields) {
    const key = String(field.physicalName || field.name || field.id).toLowerCase();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) if (count > 1) duplicateNames.add(key);

  const usedIds = new Set();
  const makeId = (prefix, value) => {
    const base = `${prefix}-${String(value || 'item').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item'}`;
    let id = base;
    let suffix = 2;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    return id;
  };
  const fieldMap = {};
  const fieldColumns = [];
  const columnByReference = new Map();
  for (const field of fields) {
    const physical = field.physicalName || field.name || field.id;
    const duplicate = duplicateNames.has(String(physical).toLowerCase());
    const display = duplicate && field.table
      ? `${sigmaDisplayName(field.table)} ${sigmaDisplayName(physical)}`
      : sigmaDisplayName(field.name || physical);
    const id = makeId('field', field.id || `${field.table}-${physical}`);
    const targetColumn = dataModelId ? display : physical;
    const column = {
      id,
      name: display,
      formula: `[${qualifier}/${targetColumn}]`,
      ...fieldFormat(field),
    };
    fieldColumns.push(column);
    for (const key of [
      field.id,
      field.name,
      field.physicalName,
      field.table && `${field.table}.${field.physicalName || field.name}`,
    ].filter(Boolean)) {
      fieldMap[key] = display;
      fieldMap[String(key).toLowerCase()] = display;
      columnByReference.set(String(key).toLowerCase(), column);
    }
    columnByReference.set(display.toLowerCase(), column);
  }

  const formulaMap = Object.fromEntries(
    (ir.data.formulas || []).flatMap((formula) => [
      [formula.name, formula.name],
      [String(formula.name).toLowerCase(), formula.name],
    ]),
  );
  const formulas = (ir.data.formulas || []).map((formula) => ({
    name: formula.name,
    ...translateCrystalFormula(formula.text, { fieldMap, formulaMap }),
  }));
  const formulaNames = new Set(formulas.map((formula) => formula.name.toLowerCase()));
  const blockedFormulaNames = new Set(
    formulas.filter((formula) => !formula.fullyTranslated || formula.parameters.length)
      .map((formula) => formula.name.toLowerCase()),
  );
  let propagated;
  do {
    propagated = false;
    for (const formula of formulas) {
      const name = formula.name.toLowerCase();
      if (blockedFormulaNames.has(name)) continue;
      const blockedDependency = formula.dependencies.some((dependency) =>
        formulaNames.has(String(dependency).toLowerCase())
        && blockedFormulaNames.has(String(dependency).toLowerCase()));
      if (blockedDependency) {
        blockedFormulaNames.add(name);
        propagated = true;
      }
    }
  } while (propagated);
  const formulaColumns = [];
  const formulaColumnByName = new Map();
  for (const formula of formulas) {
    for (const warning of formula.warnings) {
      warnings.push(`Formula "${formula.name}": ${warning}`);
    }
    if (blockedFormulaNames.has(formula.name.toLowerCase())) {
      const blockedDependencies = formula.dependencies.filter((dependency) =>
        blockedFormulaNames.has(String(dependency).toLowerCase()));
      degradationLedger.push({
        sourceType: 'formula',
        sourceId: formula.name,
        disposition: formula.parameters.length
          ? 'not-emitted-unbound-parameter'
          : 'not-emitted-unverified',
        message: formula.parameters.length
          ? `Formula depends on omitted parameter control(s): ${formula.parameters.join(', ')}.`
          : blockedDependencies.length
            ? `Formula depends on formula(s) that were not emitted safely: ${blockedDependencies.join(', ')}.`
            : formula.warnings.join(' ') || 'Formula could not be translated safely.',
        source: formula.source,
      });
      continue;
    }
    const column = {
      id: makeId('formula', formula.name),
      name: formula.name,
      formula: formula.sigma,
    };
    formulaColumns.push(column);
    formulaColumnByName.set(formula.name.toLowerCase(), column);
  }

  for (const summary of ir.data.summaries || []) {
    degradationLedger.push({
      sourceType: 'summary',
      sourceId: summary.name || summary.field || 'summary',
      disposition: 'not-emitted-grain-redesign',
      message: 'Crystal summary was not added to the detail table because doing so can change '
        + 'its grain; rebuild it in a separate grouped/KPI element after validating group scope.',
      source: summary,
    });
  }

  const table = {
    id: makeId('table', ir.report?.name || 'crystal-detail'),
    kind: 'table',
    name: `${ir.report?.title || ir.report?.name || 'Crystal Report'} Detail`,
    source,
    columns: [...fieldColumns, ...formulaColumns],
    order: [...fieldColumns, ...formulaColumns].map((column) => column.id),
  };
  for (const group of ir.data.groups || []) {
    degradationLedger.push({
      sourceType: 'group',
      sourceId: group.name,
      disposition: 'not-emitted-detail-preserved',
      message: `Crystal group "${group.conditionField || ''}" was not applied to the detail table; `
        + 'build a separate grouped summary element after validating its level and calculations.',
      source: group,
    });
  }
  const sort = [];
  for (const item of ir.data.sorts || []) {
    const key = item.field || item.fieldName || item.name;
    const column = columnByReference.get(String(key || '').toLowerCase())
      || formulaColumnByName.get(String(key || '').toLowerCase());
    if (column) {
      sort.push({
        columnId: column.id,
        direction: /desc/i.test(item.direction || item.sortDirection || '')
          ? 'descending'
          : 'ascending',
      });
    } else {
      degradationLedger.push({
        sourceType: 'sort',
        sourceId: key || 'sort',
        disposition: 'not-emitted-unresolved',
        message: 'Crystal detail sort did not resolve to an emitted detail column.',
        source: item,
      });
    }
  }
  if (sort.length) table.sort = sort;

  const title = {
    id: makeId('text', 'title'),
    kind: 'text',
    body: `# ${ir.report?.title || ir.report?.name || 'Crystal Report'}`,
    verticalAlign: 'top',
  };
  for (const parameter of ir.data.parameters || []) {
    degradationLedger.push({
      sourceType: 'parameter',
      sourceId: parameter.name,
      disposition: 'omitted-unbound-control',
      message: 'No workbook control was emitted because the source domain and safe target binding '
        + 'are unknown; author a complete current control shape after choosing filter/formula scope.',
      source: parameter,
    });
  }

  const pageAndLayout = {
    pagination: {
      sourcePage: ir.page,
      disposition: 'responsive-single-page',
      message: 'Physical paper size, page breaks, and keep-together rules do not apply to the workbook canvas.',
    },
    panels: (ir.sections || [])
      .filter((section) => section.kind === 'page-header' || section.kind === 'page-footer')
      .map((section) => ({
        sourceSectionId: section.id,
        sourceKind: section.kind,
        disposition: 'non-repeating-page-content',
      })),
    layout: {
      source: 'absolute-twips',
      target: 'stacked-responsive-grid',
      message: 'Crystal x/y geometry and overlap order were replaced by full-width stacked workbook elements.',
    },
  };
  degradationLedger.push(
    {
      sourceType: 'pagination',
      sourceId: 'report-pages',
      disposition: pageAndLayout.pagination.disposition,
      message: pageAndLayout.pagination.message,
    },
    {
      sourceType: 'layout',
      sourceId: 'report-geometry',
      disposition: pageAndLayout.layout.target,
      message: pageAndLayout.layout.message,
    },
  );
  for (const panel of pageAndLayout.panels) {
    degradationLedger.push({
      sourceType: 'panel',
      sourceId: panel.sourceSectionId,
      disposition: panel.disposition,
      message: `${panel.sourceKind} does not repeat on an interactive workbook canvas.`,
    });
  }

  if (tables.length > 1) {
    degradationLedger.push({
      sourceType: 'source-topology',
      sourceId: 'crystal-tables',
      disposition: hasCompleteDataModelBinding ? 'explicit-data-model-binding' : 'explicit-wide-source',
      message: `${tables.length} Crystal tables require the explicit target binding supplied for this draft; `
        + 'confirm it exposes every emitted field and preserves the source join grain.',
    });
  }
  for (const section of ir.sections || []) {
    if (section.suppressFormula || section.newPageBefore || section.newPageAfter) {
      degradationLedger.push({
        sourceType: 'section-behavior',
        sourceId: section.id,
        disposition: 'not-emitted',
        message: 'Conditional suppression and section page-break behavior require an interactive redesign.',
      });
    }
    for (const object of section.objects || []) {
      if (['field', 'formula', 'summary'].includes(object.kind)) continue;
      if (object.kind === 'text' && object.id === 'report-title') continue;
      degradationLedger.push({
        sourceType: 'report-object',
        sourceId: object.id,
        sourceSection: section.name,
        disposition: ['picture', 'subreport', 'chart', 'crosstab', 'map', 'ole'].includes(object.kind)
          ? 'manual-interactive-rebuild'
          : 'normalized-into-stacked-design',
        message: `${object.kind} fixed-layout object was not reproduced as an independent workbook element.`,
      });
    }
  }
  for (const [kind, expression] of [
    ['record-selection', ir.report?.recordSelectionFormula],
    ['group-selection', ir.report?.groupSelectionFormula],
  ]) {
    if (!expression) continue;
    degradationLedger.push({
      sourceType: kind,
      sourceId: kind,
      disposition: 'not-emitted-filter',
      message: 'Source selection formula was preserved for manual filter/control wiring.',
      source: expression,
    });
  }
  warnings.push(...degradationLedger.map((item) =>
    `${item.sourceType} "${item.sourceId}": ${item.message}`));

  const pageId = makeId('page', 'interactive-report');
  const elements = [title, table];
  const workbook = prepareWorkbookForPost({
    name: workbookName,
    folderId,
    description: 'Interactive first draft migrated from SAP Crystal Reports; review the degradation ledger.',
    schemaVersion,
    kind: 'workbook',
    pages: [{ id: pageId, name: 'Interactive Report', elements }],
  });
  return {
    workbook,
    formulas,
    warnings,
    degradationLedger,
    adaptation: pageAndLayout,
    stats: {
      pages: 1,
      elements: elements.length,
      fields: fieldColumns.length,
      formulas: formulaColumns.length,
      summaries: ir.data.summaries?.length || 0,
      emittedSummaries: 0,
      groups: ir.data.groups?.length || 0,
      emittedGroups: 0,
      controls: 0,
      degradations: degradationLedger.length,
    },
  };
}

function buildColumns(profile, ir, sourceTable) {
  if (profile === 'meridian-customer-statement') {
    return MERIDIAN_COLUMNS.map(([physical, name, format]) => ({
      id: `col-${physical.replace(/_/g, '-')}`,
      physical,
      name,
      formula: `[${sourceTable}/${physical.toUpperCase()}]`,
      ...(format ? { format } : {}),
      ...(physical === 'customer_id' ? { hidden: true } : {}),
    }));
  }
  const seen = new Set();
  const columns = [];
  for (const section of ir.sections || []) {
    for (const object of section.objects || []) {
      if (!object.fieldId) continue;
      const physical = object.fieldId.split('.').at(-1);
      if (!physical || seen.has(physical.toLowerCase())) continue;
      seen.add(physical.toLowerCase());
      columns.push({
        id: sigmaShortId(),
        physical,
        name: physical.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase()),
        formula: `[${sourceTable}/${physical}]`,
      });
    }
  }
  return columns;
}

function detectProfile(ir) {
  const names = new Set((ir.data.formulas || []).map(formula => formula.name));
  return names.has('InvoiceNumber') && names.has('AgingBucket') && names.has('UsdBalance')
    ? 'meridian-customer-statement'
    : 'generic';
}

function place(rootId, rootType, elementId, x, y, width, height) {
  return { rootId, rootType, elementId, x: round(x), y: round(y), width: round(width), height: round(height) };
}

function moneyFormat(symbol = '') {
  return {
    kind: 'number',
    formatString: `${symbol},.2f`,
    ...(symbol ? { currencySymbol: symbol } : {}),
  };
}

function dateFormat() {
  return { kind: 'datetime', formatString: '%Y-%m-%d' };
}

function fieldFormat(field) {
  const mask = field.numberFormat || field.format?.numberFormat || field.format?.dateFormat;
  const fromMask = formatFromMask(mask);
  if (fromMask) return { format: fromMask };
  if (/date|time/i.test(field.dataType || '')) return { format: dateFormat() };
  if (/currency|money/i.test(field.dataType || '')) return { format: moneyFormat('$') };
  return {};
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value);
}

