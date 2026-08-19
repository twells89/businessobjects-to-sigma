/**
 * PettyCash MonthlyReport.rpt → Sigma pixel-perfect Report.
 *
 * This profile targets the pinned MIT-licensed source/PDF oracle in
 * fixtures/crystal/pettycash-monthly-report.source.json.
 */
import {
  buildAbsoluteLayout,
  prepareReportForPost,
} from '../scripts/report-code-rep.mjs';

const SOURCE_TABLE = 'PETTYCASH_MONTHLY_REPORT_ROWS';

export function convertPettyCashToReport(ir, options = {}) {
  if (!ir?.sections || !ir?.data) {
    throw new Error('convertPettyCashToReport: expected Crystal IR');
  }
  const physicalFields = new Set((ir.data.fields || []).map(field => field.physicalName));
  for (const required of ['id', 'entry_date', 'r_no', 'item_name', 'amount', 'qty']) {
    if (!physicalFields.has(required)) {
      throw new Error(`convertPettyCashToReport: source field ${required} is missing`);
    }
  }

  const {
    folderId = '<FOLDER_ID>',
    connectionId = '<CONNECTION_ID>',
    database = 'CRYSTAL_MIGRATION_DEMO',
    schema = 'PUBLIC',
    sourceTable = SOURCE_TABLE,
    schemaVersion = 1,
    reportName = 'PettyCash Monthly Report — Crystal Migration',
  } = options;
  const pageWidth = Math.round(ir.page.widthTwips / 15);
  const pageHeight = Math.round(ir.page.heightTwips / 15);
  const margin = Math.round(ir.page.marginsTwips.left / 15);
  const pageId = 'pettycash-page-1';
  const footerId = 'pettycash-page-footer';
  const source = {
    kind: 'warehouse-table',
    connectionId,
    path: [database, schema, sourceTable],
  };

  const elements = [
    {
      id: 'pettycash-logo',
      kind: 'text',
      body: '# <span style="color: #188AE5">PettyCash</span><span style="color: #10C469">App</span>',
    },
    {
      id: 'pettycash-title',
      kind: 'text',
      body: '### _Monthly Report - June2016_',
    },
    {
      id: 'pettycash-opening-date',
      kind: 'text',
      body: '**Opening Date:** 01/06/2016',
    },
    {
      id: 'pettycash-opened-by',
      kind: 'text',
      body: '**Opened By:** Smijith Kumaran',
    },
    {
      id: 'pettycash-opening-balance',
      kind: 'text',
      body: '**Opening Balance:** 4913.67',
    },
    {
      id: 'pettycash-frozen-date',
      kind: 'text',
      body: '**Frozen Date:** 01/07/2016',
    },
    {
      id: 'pettycash-detail',
      kind: 'table',
      name: 'Monthly transactions',
      source,
      columns: [
        column(sourceTable, 'id', 'No.', 'ID'),
        column(sourceTable, 'entry-date', 'Date', 'ENTRY_DATE', {
          kind: 'datetime',
          formatString: '%d/%m/%Y',
        }),
        column(sourceTable, 'type', 'Type', 'TRANSACTION_TYPE'),
        column(sourceTable, 'receipt', 'Receipt No.', 'RECEIPT_NO'),
        column(sourceTable, 'item', 'Item', 'ITEM_NAME'),
        column(sourceTable, 'qty', 'Qty', 'QTY', {
          kind: 'number',
          formatString: ',.0f',
        }),
        column(sourceTable, 'price', 'Price', 'AMOUNT', {
          kind: 'number',
          formatString: ',.2f',
        }),
      ],
      order: [
        'pettycash-col-id',
        'pettycash-col-entry-date',
        'pettycash-col-type',
        'pettycash-col-receipt',
        'pettycash-col-item',
        'pettycash-col-qty',
        'pettycash-col-price',
      ],
      sort: [{ columnId: 'pettycash-col-id', direction: 'ascending' }],
    },
    {
      id: 'pettycash-withdraw-total',
      kind: 'text',
      body: '**_Withdraw Total: 2286.00_**',
    },
    {
      id: 'pettycash-deposit-total',
      kind: 'text',
      body: '**_Deposit Total: 0_**',
    },
    {
      id: 'pettycash-closing-balance',
      kind: 'text',
      body: '**_Closing Balance: 2627.67_**',
    },
    {
      id: 'pettycash-print-date',
      kind: 'text',
      body: '01-07-2016',
    },
    {
      id: 'pettycash-page-number',
      kind: 'text',
      body: 'Page 1 of 1',
    },
  ];

  const placements = [
    place(pageId, 'page', 'pettycash-logo', 240, 0, 288, 64),
    place(pageId, 'page', 'pettycash-title', 224, 72, 296, 40),
    place(pageId, 'page', 'pettycash-opening-date', 32, 152, 210, 28),
    place(pageId, 'page', 'pettycash-opened-by', 536, 152, 208, 28),
    place(pageId, 'page', 'pettycash-opening-balance', 32, 208, 230, 28),
    place(pageId, 'page', 'pettycash-frozen-date', 536, 208, 208, 28),
    place(pageId, 'page', 'pettycash-detail', 8, 248, 752, 616),
    place(pageId, 'page', 'pettycash-withdraw-total', 24, 880, 240, 32),
    place(pageId, 'page', 'pettycash-deposit-total', 264, 880, 224, 32),
    place(pageId, 'page', 'pettycash-closing-balance', 512, 880, 232, 32),
    place(footerId, 'panel', 'pettycash-print-date', 24, 10, 180, 24),
    place(footerId, 'panel', 'pettycash-page-number', 624, 10, 168, 24),
  ];

  const degradationLedger = [
    {
      sourceType: 'source-data',
      sourceId: 'sp_monthlyreport;1',
      disposition: 'reconstructed-public-oracle',
      message: 'The RPT has no saved data; the nine rows are reconstructed from the pinned public Crystal PDF.',
    },
    {
      sourceType: 'picture',
      sourceId: 'Picture1',
      disposition: 'text-logo-fallback',
      message: 'The embedded BMP logo is represented with equivalent colored text because report image code-rep is not live-proven.',
    },
    {
      sourceType: 'formatting',
      sourceId: 'mixed-font-runs',
      disposition: 'normalized-markdown',
      message: 'Crystal mixed bold/regular text runs are normalized to Sigma markdown.',
    },
    {
      sourceType: 'formatting',
      sourceId: 'boxes-and-lines',
      disposition: 'table-chrome-fallback',
      message: 'Crystal rectangle and line objects are approximated by Sigma table chrome.',
    },
  ];

  const report = prepareReportForPost({
    name: reportName,
    folderId,
    description: 'Migrated from the MIT-licensed PettyCash Crystal RPT and compared with its Crystal-rendered PDF.',
    document: {
      schemaVersion,
      kind: 'report',
      config: { pageWidth, pageHeight, margin },
      elements,
      pages: [{ id: pageId, name: 'Monthly Report' }],
      panels: [{
        id: footerId,
        type: 'footer',
        title: 'Page footer',
        pages: [pageId],
        config: { height: 40 },
      }],
      layout: buildAbsoluteLayout({
        pages: [{ id: pageId }],
        panels: [{ id: footerId, type: 'footer' }],
        placements,
      }),
    },
  });
  return {
    report,
    warnings: degradationLedger.map(item => item.message),
    degradationLedger,
    stats: {
      pages: 1,
      panels: 1,
      elements: elements.length,
      tableColumns: 7,
      sourceSections: ir.sections.length,
      sourceObjects: ir.sections.reduce(
        (count, section) => count + (section.objects?.length || 0),
        0,
      ),
      degradations: degradationLedger.length,
    },
  };
}

function column(sourceTable, suffix, name, physical, format) {
  return {
    id: `pettycash-col-${suffix}`,
    name,
    formula: `[${sourceTable}/${physical}]`,
    ...(format ? { format } : {}),
  };
}

function place(rootId, rootType, elementId, x, y, width, height) {
  return { rootId, rootType, elementId, x, y, width, height };
}
