import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

process.env.SIGMA_BASE_URL = 'https://aws-api.sigmacomputing.com';
process.env.SIGMA_API_TOKEN = 'unit-test-token';

const sigma = await import('../scripts/sigma.mjs');
const reports = await import('../scripts/sigma-report.mjs');

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? '✅' : '❌'} ${message}`);
  if (!condition) failures++;
}

console.log('Sigma auth and workbook/report lifecycle');

const tempHome = mkdtempSync(join(tmpdir(), 'bo-sigma-auth-'));
const neutralDir = join(tempHome, '.sigma-migration');
const marker = join(tempHome, 'unsafe-command-ran');
mkdirSync(neutralDir);
writeFileSync(join(neutralDir, 'env'), [
  "export SIGMA_BASE_URL='https://api.sigmacomputing.com'",
  "export SIGMA_CLIENT_ID='file-id'",
  `export SIGMA_CLIENT_SECRET='$(touch ${marker})'`,
  "export SIGMA_FOLDER_ID='from-file'",
  "export NODE_OPTIONS='--require malicious.js'",
].join('\n'));
const moduleUrl = pathToFileURL(resolve('scripts/sigma.mjs')).href;
const isolatedEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('SIGMA_')),
);
const loadResult = spawnSync(process.execPath, ['--input-type=module', '-e', `
  await import(${JSON.stringify(`${moduleUrl}?loader-test=1`)});
  console.log(JSON.stringify({
    id: process.env.SIGMA_CLIENT_ID,
    secret: process.env.SIGMA_CLIENT_SECRET,
    base: process.env.SIGMA_BASE_URL,
    folder: process.env.SIGMA_FOLDER_ID,
    nodeOptions: process.env.NODE_OPTIONS || null
  }));
`], {
  encoding: 'utf8',
  env: { ...isolatedEnv, HOME: tempHome, SIGMA_CLIENT_ID: 'explicit-id' },
});
const loaded = loadResult.status === 0 ? JSON.parse(loadResult.stdout.trim()) : {};
check(loadResult.status === 0, `isolated neutral env loads (${loadResult.stderr.trim()})`);
check(
  loaded.id === 'explicit-id' && loaded.base === 'https://api.sigmacomputing.com'
    && loaded.folder === 'from-file',
  'neutral env fills missing Sigma vars without overriding explicit values',
);
check(
  loaded.secret === `$(touch ${marker})` && !existsSync(marker),
  'neutral env command substitution remains literal and is never executed',
);
check(loaded.nodeOptions == null, 'neutral env ignores non-Sigma process variables');

try {
  sigma.validateSigmaBaseUrl('http://aws-api.sigmacomputing.com');
  check(false, 'non-HTTPS base rejected');
} catch (error) {
  check(/must use https/.test(error.message), 'non-HTTPS base rejected');
}
try {
  sigma.validateSigmaBaseUrl('https://sigmacomputing.com.evil.example');
  check(false, 'lookalike Sigma host rejected');
} catch (error) {
  check(/not a sigmacomputing.com host/.test(error.message), 'lookalike Sigma host rejected');
}
check(
  sigma.validateSigmaBaseUrl('http://localhost:3000', { allowInsecure: true, warn: () => {} })
    === 'http://localhost:3000',
  'explicit insecure override permits self-hosted development URL',
);
try {
  sigma.assertSigmaCredentials('same-value', 'same-value');
  check(false, 'client id copied into secret rejected');
} catch (error) {
  check(/identical/.test(error.message), 'client id copied into secret rejected');
}

const authResult = spawnSync(process.execPath, ['--input-type=module', '-e', `
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, headers: init.headers, body: String(init.body) };
    return new Response(JSON.stringify({ access_token: 'safe-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const mod = await import(${JSON.stringify(`${moduleUrl}?mint-test=1`)});
  await mod.sigmaToken();
  console.log(JSON.stringify(request));
`], {
  encoding: 'utf8',
  env: {
    ...isolatedEnv,
    HOME: mkdtempSync(join(tmpdir(), 'bo-sigma-mint-')),
    SIGMA_BASE_URL: 'https://aws-api.sigmacomputing.com',
    SIGMA_CLIENT_ID: 'client-id',
    SIGMA_CLIENT_SECRET: 'client-secret',
  },
});
const authRequest = authResult.status === 0 ? JSON.parse(authResult.stdout.trim()) : {};
check(authResult.status === 0, `isolated token mint succeeds (${authResult.stderr.trim()})`);
check(
  authRequest.headers?.Authorization
    === `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
  'token exchange uses Basic authorization',
);
check(
  authRequest.body === 'grant_type=client_credentials'
    && !/client_(?:id|secret)/.test(authRequest.body || ''),
  'token request body does not duplicate credentials',
);

const workbook = {
  name: 'Lifecycle workbook',
  folderId: 'folder',
  description: 'Strict metadata',
  schemaVersion: 2,
  kind: 'workbook',
  pages: [{
    id: 'page-1',
    name: 'Page',
    elements: [{
      id: 'table-1',
      kind: 'table',
      columns: [{ id: 'column-1', name: 'Amount', formula: '[SOURCE/AMOUNT]' }],
      order: ['column-1'],
    }],
  }],
};
const prepared = sigma.normalizeWorkbookForComparison(workbook);
check(
  prepared.name === 'Lifecycle workbook'
    && prepared.folderId === 'folder'
    && prepared.description === 'Strict metadata',
  'strict workbook normalization preserves outer metadata',
);
check(
  JSON.stringify(prepared)
    !== JSON.stringify(sigma.normalizeWorkbookForComparison({ ...workbook, name: 'Changed' })),
  'strict workbook normalization detects metadata changes',
);
const reorderedPages = structuredClone(workbook);
reorderedPages.pages.push({ id: 'page-2', name: 'Second', elements: [] });
const reversedPages = structuredClone(reorderedPages);
reversedPages.pages.reverse();
check(
  JSON.stringify(sigma.normalizeWorkbookForComparison(reorderedPages))
    !== JSON.stringify(sigma.normalizeWorkbookForComparison(reversedPages)),
  'strict workbook normalization preserves page order',
);
const spacedReference = structuredClone(workbook);
spacedReference.pages[0].elements[0].columns[0].formula = '[Sales Data/Net Amount]';
const underscoredReference = structuredClone(workbook);
underscoredReference.pages[0].elements[0].columns[0].formula = '[Sales_Data/Net_Amount]';
check(
  JSON.stringify(sigma.normalizeWorkbookForComparison(spacedReference))
    !== JSON.stringify(sigma.normalizeWorkbookForComparison(underscoredReference)),
  'strict workbook normalization does not conflate whitespace and underscores in formula refs',
);
const requests = [];
const workbookId = '11111111-1111-4111-8111-111111111111';
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({ url, method: init.method || 'GET', body });
  if (url.endsWith('/v2/workbooks/spec/verify')) {
    return new Response(JSON.stringify({ valid: true }), { status: 200 });
  }
  if (url.endsWith('/v2/workbooks/spec')) {
    return new Response(JSON.stringify({ workbookId }), { status: 200 });
  }
  if (url.includes(`/v2/workbooks/${workbookId}/spec?format=json`)) {
    const submitted = (await import('../scripts/code_rep.mjs')).prepareWorkbookForPost(workbook);
    return new Response(JSON.stringify({
      workbookId,
      name: submitted.name,
      folderId: submitted.folderId,
      description: submitted.description,
      document: submitted.document,
    }), { status: 200 });
  }
  if (url.endsWith(`/v2/workbooks/${workbookId}/convertToReport`)) {
    return new Response(JSON.stringify({
      convertedReport: {
        reportId: '22222222-2222-4222-8222-222222222222',
        url: 'https://app.sigmacomputing.com/report/2222',
      },
      sourceWorkbook: { workbookId },
      warnings: [{ code: 'UNSUPPORTED_ACTION', details: { elementId: 'button-1' } }],
    }), { status: 201 });
  }
  throw new Error(`Unexpected fetch: ${init.method || 'GET'} ${url}`);
};

const verified = await sigma.verifyWorkbook(workbook);
check(verified.valid === true, 'workbook verify response returned');
const verifyRequest = requests.at(-1);
check(
  verifyRequest.body.document.kind === 'workbook'
    && verifyRequest.body.document.elements[0].id === 'table-1'
    && !('elements' in verifyRequest.body.document.pages[0]),
  'workbook verify sends the canonical prepared body',
);
const createdId = await sigma.postWorkbook(workbook);
check(createdId === workbookId, 'workbook create parses JSON workbookId');
const readback = await sigma.assertWorkbookReadback(workbookId, workbook);
check(readback.workbookId === workbookId, 'workbook readback requests and compares JSON spec');
check(
  requests.some(request => request.url.endsWith(`/v2/workbooks/${workbookId}/spec?format=json`)),
  'workbook readback requests format=json',
);
check(
  JSON.stringify(prepared) === JSON.stringify(sigma.normalizeWorkbookForComparison(readback)),
  'workbook comparison normalizer ignores response metadata',
);

const { prepareWorkbookForPost } = await import('../scripts/code_rep.mjs');
const reassigned = prepareWorkbookForPost(workbook);
reassigned.document.pages[0].id = 'server-page';
reassigned.document.elements[0].id = 'server-table';
reassigned.document.elements[0].columns[0].id = 'server-column';
reassigned.document.elements[0].order = ['server-column'];
reassigned.document.layout = reassigned.document.layout
  .replace(/page-1/g, 'server-page')
  .replace(/table-1/g, 'server-table');
check(
  JSON.stringify(sigma.normalizeWorkbookForComparison(workbook))
    !== JSON.stringify(sigma.normalizeWorkbookForComparison(reassigned)),
  'strict workbook comparison remains ID-sensitive',
);
const semantic = sigma.assessWorkbookSemanticReadback(workbook, reassigned);
check(semantic.valid && semantic.idsChanged, 'semantic readback allows server-assigned IDs');
const droppedDescription = structuredClone(reassigned);
delete droppedDescription.description;
check(
  !sigma.assessWorkbookSemanticReadback(workbook, droppedDescription).valid,
  'semantic readback still rejects dropped non-empty description metadata',
);
const resolvedPages = sigma.resolveWorkbookReadbackPageIds(workbook, reassigned);
check(
  resolvedPages.pageIds.join(',') === 'server-page',
  'conversion page IDs are derived from readback page-name mapping',
);
const droppedReadback = structuredClone(reassigned);
droppedReadback.document.elements = [];
droppedReadback.document.layout = droppedReadback.document.layout
  .replace(/<Element\b[^>]*\/>/g, '');
check(
  !sigma.assessWorkbookSemanticReadback(workbook, droppedReadback).valid,
  'semantic readback still rejects material element drops',
);

const converted = await reports.convertWorkbookToReport(workbookId, {
  name: 'Converted report',
  destinationFolderId: 'folder',
  description: 'Test conversion',
  pageIds: ['page-1'],
  format: { pageSize: 'a4', layout: 'landscape' },
});
check(
  converted.reportId === '22222222-2222-4222-8222-222222222222',
  'workbook-to-report conversion extracts nested report id',
);
check(
  converted.reportUrl === 'https://app.sigmacomputing.com/report/2222',
  'workbook-to-report conversion preserves the irreversible report URL',
);
check(
  converted.warnings[0]?.code === 'UNSUPPORTED_ACTION',
  'workbook-to-report conversion preserves warning objects',
);
const warningEvidence = reports.createConversionWarningEvidence(converted.warnings, {
  workbookId,
  reportId: converted.reportId,
});
check(
  reports.verifyConversionWarningEvidence(
    warningEvidence,
    converted.result,
    { workbookId, reportId: converted.reportId },
  ).valid
    && warningEvidence.hash.length === 64,
  'conversion warning evidence has a stable verified SHA-256 checksum',
);
const reorderedWarningResult = structuredClone(converted.result);
reorderedWarningResult.warnings = [{
  details: { elementId: 'button-1' },
  code: 'UNSUPPORTED_ACTION',
}];
check(
  reports.verifyConversionWarningEvidence(
    warningEvidence,
    reorderedWarningResult,
    { workbookId, reportId: converted.reportId },
  ).valid,
  'warning evidence hash is independent of object key insertion order',
);
try {
  reports.verifyConversionWarningEvidence(
    { ...warningEvidence, warnings: [{ code: 'EDITED' }] },
    converted.result,
    { workbookId, reportId: converted.reportId },
  );
  check(false, 'edited warning evidence is rejected');
} catch (error) {
  check(/checksum\/count/.test(error.message), 'edited warning evidence is rejected');
}
try {
  reports.verifyConversionWarningEvidence(
    warningEvidence,
    converted.result,
    { workbookId, reportId: 'different-report' },
  );
  check(false, 'warning evidence cannot be reused for another report');
} catch (error) {
  check(/different workbook\/report ids/.test(error.message), 'warning evidence cannot be reused for another report');
}
const convertRequest = requests.at(-1);
check(
  JSON.stringify(convertRequest.body) === JSON.stringify({
    name: 'Converted report',
    destinationFolderId: 'folder',
    description: 'Test conversion',
    pageIds: ['page-1'],
    format: { pageSize: 'a4', layout: 'landscape' },
  }),
  'convertToReport sends the documented request body',
);

const generatedReport = {
  name: 'Converted report',
  folderId: 'folder',
  document: {
    schemaVersion: 1,
    kind: 'report',
    config: { pageWidth: 816, pageHeight: 1056, margin: 48 },
    pages: [{ id: 'report-page', name: 'Page' }],
    panels: [],
    elements: [{
      ...workbook.pages[0].elements[0],
      id: 'report-table',
      columns: [{ ...workbook.pages[0].elements[0].columns[0], id: 'report-column' }],
      order: ['report-column'],
    }],
    layout: '<Page id="report-page"><Element elementId="report-table" x="0" y="0" width="700" height="500"/></Page>',
  },
};
check(
  reports.assessConvertedReportCoverage(workbook, generatedReport).valid,
  'generated report coverage accepts reassigned IDs with preserved intent',
);
const reportWithLoss = structuredClone(generatedReport);
reportWithLoss.document.elements = [];
reportWithLoss.document.layout = '<Page id="report-page"></Page>';
check(
  !reports.assessConvertedReportCoverage(workbook, reportWithLoss).valid,
  'generated report coverage gates material element loss',
);

const intentWorkbook = {
  name: 'Intent workbook',
  folderId: 'folder',
  schemaVersion: 2,
  kind: 'workbook',
  pages: [{
    id: 'intent-page-a',
    name: 'A',
    elements: [{
      id: 'intent-chart',
      kind: 'kpi-chart',
      name: 'Intent KPI',
      source: { kind: 'data-model', dataModelId: 'dm', elementId: 'view' },
      columns: [
        { id: 'intent-dimension', name: 'Region', formula: '[View/Region]' },
        { id: 'intent-value', name: 'Revenue', formula: 'Sum([View/Revenue])' },
      ],
      order: ['intent-dimension', 'intent-value'],
      filters: [{ columnId: 'intent-dimension', condition: '=', value: 'West' }],
      groupings: [{
        id: 'intent-group',
        groupBy: ['intent-dimension'],
        calculations: ['intent-value'],
        sort: [{ columnId: 'intent-value', direction: 'descending' }],
      }],
      sort: [{ columnId: 'intent-dimension', direction: 'ascending' }],
      conditionalFormats: [{
        type: 'single',
        columnIds: ['intent-value'],
        condition: '>',
        value: 100,
        style: { color: '#008000' },
      }],
      value: { columnId: 'intent-value' },
      xAxis: { columnId: 'intent-dimension' },
      yAxis: { columnIds: ['intent-value'] },
    }],
  }, {
    id: 'intent-page-b',
    name: 'B',
    elements: [{ id: 'intent-text', kind: 'text', body: 'Second page' }],
  }],
};
const intentPrepared = prepareWorkbookForPost(intentWorkbook);
const intentReport = {
  name: 'Intent report',
  folderId: 'folder',
  document: {
    schemaVersion: 1,
    kind: 'report',
    config: { pageWidth: 816, pageHeight: 1056, margin: 48 },
    pages: [
      { id: 'report-page-a', name: 'A' },
      { id: 'report-page-b', name: 'B' },
    ],
    panels: [],
    elements: JSON.parse(JSON.stringify(intentPrepared.document.elements)
      .replaceAll('intent-chart', 'report-chart')
      .replaceAll('intent-text', 'report-text')
      .replaceAll('intent-dimension', 'report-dimension')
      .replaceAll('intent-value', 'report-value')
      .replaceAll('intent-group', 'report-group')),
    layout: [
      '<Page id="report-page-a"><Element elementId="report-chart" x="0" y="0" width="700" height="500"/></Page>',
      '<Page id="report-page-b"><Element elementId="report-text" x="0" y="0" width="700" height="50"/></Page>',
    ].join(''),
  },
};
check(
  reports.assessConvertedReportCoverage(intentWorkbook, intentReport).valid,
  'generated report coverage remaps IDs across full semantic intent',
);
for (const [label, mutate] of [
  ['source', report => { report.document.elements[0].source.elementId = 'other-view'; }],
  ['column formula', report => { report.document.elements[0].columns[1].formula = '0'; }],
  ['filters', report => { report.document.elements[0].filters[0].value = 'East'; }],
  ['groupings', report => { report.document.elements[0].groupings[0].calculations = []; }],
  ['sorts', report => { report.document.elements[0].sort[0].direction = 'descending'; }],
  ['conditional formats', report => {
    report.document.elements[0].conditionalFormats[0].condition = '<';
  }],
  ['chart/KPI bindings', report => {
    report.document.elements[0].value.columnId = 'report-dimension';
  }],
]) {
  const changed = structuredClone(intentReport);
  mutate(changed);
  check(
    !reports.assessConvertedReportCoverage(intentWorkbook, changed).valid,
    `generated report coverage detects changed ${label}`,
  );
}
const reorderedReportPages = structuredClone(intentReport);
reorderedReportPages.document.pages.reverse();
reorderedReportPages.document.layout = [
  '<Page id="report-page-b"><Element elementId="report-text"/></Page>',
  '<Page id="report-page-a"><Element elementId="report-chart"/></Page>',
].join('');
check(
  reports.assessConvertedReportCoverage(intentWorkbook, reorderedReportPages)
    .materialLosses.some(loss => loss.type === 'page-order-changed'),
  'generated report coverage detects source-page order changes',
);
check(
  !reports.evaluateConvertedReportAcceptance({
    warnings: converted.warnings,
    coverage: { valid: true, materialLosses: [] },
  }).accepted,
  'convertToReport warnings remain pending by default',
);
check(
  reports.evaluateConvertedReportAcceptance({
    warnings: converted.warnings,
    acceptWarnings: true,
    coverage: { valid: true, materialLosses: [] },
  }).accepted,
  'explicit warning acceptance clears warning-only pending state',
);
check(
  !reports.evaluateConvertedReportAcceptance({
    warnings: [],
    acceptWarnings: true,
    coverage: { valid: false, materialLosses: [{ type: 'element-dropped' }] },
  }).accepted,
  'material report coverage loss remains blocking despite warning acceptance',
);
check(
  !reports.evaluateConvertedReportAcceptance({
    warnings: [],
    acceptWarnings: true,
  }).accepted,
  'report acceptance requires coverage evidence',
);

console.log(failures ? `\n❌ ${failures} Sigma lifecycle check(s) failed` : '\n✅ all Sigma lifecycle checks passed');
process.exit(failures ? 1 : 0);
