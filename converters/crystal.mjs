/**
 * Crystal Reports IR → Sigma pixel-perfect Report code representation.
 *
 * The first compatibility profile targets the pinned Meridian customer
 * statement. It deliberately binds to a Snowflake wide view so Sigma Reports
 * uses the live-proven warehouse-table source path and avoids lossy multi-hop
 * data-model relationships. Unsupported Crystal objects remain in a
 * degradation ledger; nothing is silently dropped.
 */

import { sigmaShortId, resetIds } from '../helpers.mjs';
import { translateCrystalFormula } from './crystal-formula.mjs';
import { buildAbsoluteLayout, prepareReportForPost } from '../scripts/report-code-rep.mjs';

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round(value) {
  return Math.round(value);
}

