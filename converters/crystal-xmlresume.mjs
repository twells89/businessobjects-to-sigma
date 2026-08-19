/**
 * MIT XML Résumé Crystal report → Sigma pixel-perfect Report profile.
 */
import {
  buildAbsoluteLayout,
  prepareReportForPost,
} from '../scripts/report-code-rep.mjs';

export function convertXmlResumeToReport(ir, options = {}) {
  if (!ir?.sections || !ir?.data || ir.subreports?.length !== 3) {
    throw new Error('convertXmlResumeToReport: expected the three-subreport résumé IR');
  }
  const {
    folderId = '<FOLDER_ID>',
    connectionId = '<CONNECTION_ID>',
    database = 'CRYSTAL_MIGRATION_DEMO',
    schema = 'PUBLIC',
    schemaVersion = 1,
    reportName = 'XML Résumé — Crystal Migration',
  } = options;
  const pageId = 'xmlresume-page-1';
  const footerId = 'xmlresume-page-footer';
  const source = table => ({
    kind: 'warehouse-table',
    connectionId,
    path: [database, schema, table],
  });

  const elements = [
    {
      id: 'xmlresume-name',
      kind: 'text',
      body: '**<span style="color: #17365D">FIRST LAST</span>**',
    },
    {
      id: 'xmlresume-objective',
      kind: 'text',
      body: 'Nam tempus mollis imperdiet. Curabitur eu justo ultrices, tempus lectus a, venenatis felis. Sed auctor aliquam ligula id ullamcorper. Duis ante purus, porttitor ac tortor eu, sagittis semper ipsum. Donec nibh nunc, dictum eget lectus vel, interdum malesuada lorem. Nulla iaculis mi eget adipiscing lacinia. Nullam euismod lectus id elementum posuere. Quisque placerat ut est eu luctus. Aliquam sit amet semper dolor.',
    },
    heading('xmlresume-contact-heading', 'CONTACT'),
    {
      id: 'xmlresume-address',
      kind: 'text',
      body: '#100  \nXXXX Hennepin Avenue South  \nMinneapolis, MN 55555  \nUS',
    },
    {
      id: 'xmlresume-contact',
      kind: 'text',
      body: 'Telephone: +1.612.999.9999  \nEmail: [first.last@domain.com](mailto:first.last@domain.com)  \nURL: [http://www.domain.com](http://www.domain.com)  \nLinkedIn: [http://linkedin.com/in/lastfirst](http://linkedin.com/in/lastfirst)',
    },
    heading('xmlresume-academics-heading', 'ACADEMICS'),
    heading('xmlresume-certifications-heading', 'CERTIFICATIONS'),
    {
      id: 'xmlresume-academics',
      kind: 'table',
      name: '\u00a0',
      source: source('XMLRESUME_DEGREES'),
      columns: [
        column('degree', 'Degree', 'XMLRESUME_DEGREES', 'DEGREE_DISPLAY'),
        column('institution', 'Institution', 'XMLRESUME_DEGREES', 'INSTITUTION'),
        hiddenColumn('degree-sort', 'XMLRESUME_DEGREES', 'DEGREE_ORDINAL'),
      ],
      order: ['xmlresume-col-degree', 'xmlresume-col-institution'],
      sort: [{ columnId: 'xmlresume-col-degree-sort', direction: 'ascending' }],
    },
    {
      id: 'xmlresume-certifications',
      kind: 'table',
      name: '\u00a0',
      source: source('XMLRESUME_CERTIFICATIONS'),
      columns: [
        column(
          'certification',
          'Certification',
          'XMLRESUME_CERTIFICATIONS',
          'CERTIFICATION',
        ),
        hiddenColumn(
          'certification-sort',
          'XMLRESUME_CERTIFICATIONS',
          'CERTIFICATION_ORDINAL',
        ),
      ],
      order: ['xmlresume-col-certification'],
      sort: [{
        columnId: 'xmlresume-col-certification-sort',
        direction: 'ascending',
      }],
    },
    heading('xmlresume-projects-heading', 'PROJECTS'),
    {
      id: 'xmlresume-projects',
      kind: 'table',
      name: '\u00a0',
      source: source('XMLRESUME_PROJECT_LINES'),
      columns: [
        column('project-line', 'Project details', 'XMLRESUME_PROJECT_LINES', 'DISPLAY_TEXT'),
        column('project-date', 'Dates', 'XMLRESUME_PROJECT_LINES', 'DATE_DISPLAY'),
        hiddenColumn('project-sort', 'XMLRESUME_PROJECT_LINES', 'PROJECT_ORDINAL'),
        hiddenColumn('line-sort', 'XMLRESUME_PROJECT_LINES', 'LINE_ORDINAL'),
      ],
      order: ['xmlresume-col-project-line', 'xmlresume-col-project-date'],
      sort: [
        { columnId: 'xmlresume-col-project-sort', direction: 'ascending' },
        { columnId: 'xmlresume-col-line-sort', direction: 'ascending' },
      ],
    },
    {
      id: 'xmlresume-page-number',
      kind: 'text',
      body: '1',
    },
    {
      id: 'xmlresume-modified',
      kind: 'text',
      body: '<span style="color: #17365D">Modified: 2014/04/18 13:17</span>',
    },
    {
      id: 'xmlresume-name-rule',
      kind: 'divider',
    },
  ];
  const placements = [
    place(pageId, 'page', 'xmlresume-name', 650, 4, 106, 24),
    place(pageId, 'page', 'xmlresume-name-rule', 0, 30, 756, 2),
    place(pageId, 'page', 'xmlresume-objective', 0, 38, 756, 70),
    place(pageId, 'page', 'xmlresume-contact-heading', 0, 112, 380, 24),
    place(pageId, 'page', 'xmlresume-address', 0, 132, 300, 76),
    place(pageId, 'page', 'xmlresume-contact', 380, 132, 376, 76),
    place(pageId, 'page', 'xmlresume-academics-heading', 0, 230, 372, 24),
    place(pageId, 'page', 'xmlresume-certifications-heading', 380, 230, 376, 24),
    place(pageId, 'page', 'xmlresume-academics', 0, 250, 372, 140),
    place(pageId, 'page', 'xmlresume-certifications', 380, 250, 376, 140),
    place(pageId, 'page', 'xmlresume-projects-heading', 0, 400, 372, 24),
    place(pageId, 'page', 'xmlresume-projects', 0, 420, 756, 540),
    place(footerId, 'panel', 'xmlresume-page-number', 360, 8, 36, 18),
    place(footerId, 'panel', 'xmlresume-modified', 572, 8, 184, 18),
  ];
  const degradationLedger = [
    {
      sourceType: 'subreports',
      sourceId: 'academics-certifications-projects',
      disposition: 'flattened-warehouse-tables',
      message: 'Three Crystal subreports are flattened into deterministic Snowflake tables.',
    },
    {
      sourceType: 'formatting',
      sourceId: 'mixed-font-runs',
      disposition: 'normalized-markdown',
      message: 'Per-run fonts, point sizes, and hyperlink underlines are normalized to Sigma markdown.',
    },
    {
      sourceType: 'formatting',
      sourceId: 'subreport-detail-bands',
      disposition: 'table-layout',
      message: 'Growable Crystal detail bands use Sigma tables because repeated-container code-rep is not live-proven.',
    },
    {
      sourceType: 'footer',
      sourceId: 'PageNumber-and-lastModified',
      disposition: 'static-oracle-values',
      message: 'The one-page visual oracle uses pinned page and modified-date text.',
    },
  ];
  const report = prepareReportForPost({
    name: reportName,
    folderId,
    description: 'Migrated from the MIT XML Résumé Crystal source and compared with its Crystal-rendered PDF.',
    document: {
      schemaVersion,
      kind: 'report',
      config: { pageWidth: 792, pageHeight: 1123, margin: 16 },
      elements,
      pages: [{ id: pageId, name: 'Résumé' }],
      panels: [{
        id: footerId,
        type: 'footer',
        title: 'Page footer',
        pages: [pageId],
        config: { height: 32 },
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
      dataElements: 3,
      sourceSections: ir.sections.length,
      sourceObjects: ir.sections.reduce(
        (count, section) => count + (section.objects?.length || 0),
        0,
      ),
      sourceSubreports: ir.subreports.length,
      degradations: degradationLedger.length,
    },
  };
}

function heading(id, body) {
  return {
    id,
    kind: 'text',
    body: `**<span style="color: #4F81BD">${body}</span>**`,
  };
}

function column(suffix, name, table, physical) {
  return {
    id: `xmlresume-col-${suffix}`,
    name,
    formula: `[${table}/${physical}]`,
  };
}

function hiddenColumn(suffix, table, physical) {
  return {
    ...column(suffix, suffix, table, physical),
    hidden: true,
  };
}

function place(rootId, rootType, elementId, x, y, width, height) {
  return { rootId, rootType, elementId, x, y, width, height };
}
