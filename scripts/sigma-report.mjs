/**
 * Sigma pixel-perfect Report lifecycle helpers.
 *
 * Report code rep is JSON:
 *   create/verify: { name, folderId, document }
 *   update:        { document }
 * where document.kind === "report" and layout is absolute-pixel XML.
 */

import { writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  prepareReportForPost,
  prepareReportForUpdate,
  reportDocument,
  validateReportSpec,
} from './report-code-rep.mjs';
import {
  prepareWorkbookForPost,
  workbookElements,
  workbookPageElementIds,
} from './code_rep.mjs';
import { SIGMA_BASE, sigmaRequest, sigmaToken } from './sigma.mjs';

export async function referenceReportSchemaVersion() {
  const list = await sigmaRequest('GET', '/v2/reports?limit=1');
  const entry = list.entries?.[0] || list.data?.[0] || list[0];
  const reportId = entry?.reportId || entry?.id;
  if (!reportId) return 1;
  const spec = await getReportSpec(reportId);
  return Number(spec.document?.schemaVersion ?? spec.schemaVersion ?? 1);
}

export async function verifyReport(report) {
  const body = prepareReportForPost(report);
  const offline = validateReportSpec(body);
  if (!offline.valid) {
    throw new Error(`Report offline validation failed: ${offline.errors.join('; ')}`);
  }
  return sigmaRequest('POST', '/v2/reports/spec/verify', body);
}

export async function postReport(report, { verify = true } = {}) {
  const body = prepareReportForPost(report);
  const offline = validateReportSpec(body);
  if (!offline.valid) {
    throw new Error(`Report offline validation failed: ${offline.errors.join('; ')}`);
  }
  if (verify) {
    const result = await sigmaRequest('POST', '/v2/reports/spec/verify', body);
    if (result?.valid === false) {
      throw new Error(`Sigma report verify rejected the spec: ${JSON.stringify(result).slice(0, 1000)}`);
    }
  }
  const result = await sigmaRequest('POST', '/v2/reports/spec', body);
  return {
    reportId: reportIdFromResult(result),
    result,
    body,
    warnings: offline.warnings,
  };
}

export function prepareWorkbookToReportBody({
  name,
  destinationFolderId,
  description,
  pageIds,
  format = { pageSize: 'letter', layout: 'portrait' },
}) {
  if (!name || !String(name).trim()) {
    throw new Error('Workbook-to-report conversion requires a report name');
  }
  if (pageIds != null && !Array.isArray(pageIds)) {
    throw new Error('Workbook-to-report pageIds must be an array');
  }
  return {
    name,
    ...(destinationFolderId ? { destinationFolderId } : {}),
    ...(description ? { description } : {}),
    ...(pageIds?.length ? { pageIds } : {}),
    ...(format ? { format } : {}),
  };
}

/**
 * Persistently convert an existing workbook into a report. Callers must gate
 * this helper behind explicit user approval; the endpoint creates a new report
 * and leaves the source workbook unchanged.
 */
export async function convertWorkbookToReport(workbookId, options) {
  if (!workbookId) throw new Error('Workbook-to-report conversion requires workbookId');
  const body = prepareWorkbookToReportBody(options);
  const result = await sigmaRequest(
    'POST',
    `/v2/workbooks/${workbookId}/convertToReport`,
    body,
  );
  const converted = result?.convertedReport;
  const reportId = typeof converted === 'string'
    ? converted
    : converted?.reportId || converted?.id || converted?.fileId
      || result?.reportId || result?.id || result?.fileId || null;
  const reportUrl = typeof converted === 'object'
    ? converted?.url || result?.url || null
    : result?.url || null;
  const warnings = Array.isArray(result?.warnings)
    ? result.warnings
    : (result?.warnings == null ? [] : [result.warnings]);
  return { reportId, reportUrl, warnings, result, body };
}

/**
 * Compare workbook page/element intent with the generated report readback.
 * Extra hidden/dependency pages are allowed; dropped source pages/elements and
 * changed element kinds/column inventories are material losses.
 */
export function assessConvertedReportCoverage(workbook, report) {
  const source = prepareWorkbookForPost(workbook);
  const target = reportDocument(report);
  const targetPages = Array.isArray(target.pages) ? target.pages : [];
  const targetElements = new Map(
    (Array.isArray(target.elements) ? target.elements : []).map((element) => [element.id, element]),
  );
  const targetMembership = reportPageElementIds(target);
  const sourceElements = new Map(
    workbookElements(source).map((element) => [element.id, element]),
  );
  const sourceMembership = workbookPageElementIds(source);
  const targetByName = new Map();
  for (const page of targetPages) {
    const name = String(page?.name ?? '');
    if (!targetByName.has(name)) targetByName.set(name, []);
    targetByName.get(name).push(page);
  }

  const losses = [];
  const pages = [];
  const nameUse = new Map();
  for (const sourcePage of source.document.pages || []) {
    const name = String(sourcePage?.name ?? '');
    const occurrence = nameUse.get(name) || 0;
    nameUse.set(name, occurrence + 1);
    const targetPage = targetByName.get(name)?.[occurrence];
    if (!targetPage) {
      losses.push({
        type: 'page-dropped',
        sourcePageId: sourcePage.id,
        pageName: name,
        occurrence,
      });
      continue;
    }
    const intended = (sourceMembership[sourcePage.id] || [])
      .map((id) => sourceElements.get(id))
      .filter(Boolean);
    const generated = (targetMembership[targetPage.id] || [])
      .map((id) => targetElements.get(id))
      .filter(Boolean);
    const elementLosses = compareReportElements(intended, generated);
    losses.push(...elementLosses.map((loss) => ({
      ...loss,
      sourcePageId: sourcePage.id,
      reportPageId: targetPage.id,
      pageName: name,
    })));
    pages.push({
      pageName: name,
      sourcePageId: sourcePage.id,
      reportPageId: targetPage.id,
      intendedElements: intended.length,
      generatedElements: generated.length,
      losses: elementLosses,
    });
  }
  const sourcePlaced = Object.values(sourceMembership).reduce(
    (sum, ids) => sum + ids.length,
    0,
  );
  if (sourcePlaced !== sourceElements.size) {
    losses.push({
      type: 'source-unplaced-elements',
      intendedElements: sourceElements.size,
      placedElements: sourcePlaced,
    });
  }
  return {
    valid: losses.length === 0,
    materialLosses: losses,
    pages,
    source: {
      pages: source.document.pages?.length || 0,
      elements: sourceElements.size,
    },
    generated: {
      pages: targetPages.length,
      elements: targetElements.size,
    },
  };
}

export function evaluateConvertedReportAcceptance({
  warnings = [],
  acceptWarnings = false,
  coverage,
  validationFailure = null,
}) {
  const pendingReasons = [];
  if (validationFailure) pendingReasons.push(validationFailure);
  if (coverage && !coverage.valid) {
    pendingReasons.push(
      `generated report has ${coverage.materialLosses?.length || 0} material coverage loss(es)`,
    );
  }
  if (warnings.length && !acceptWarnings) {
    pendingReasons.push(
      `${warnings.length} conversion warning(s) require review; the created report remains pending`,
    );
  }
  return {
    accepted: pendingReasons.length === 0,
    pendingReasons,
    warningsAccepted: Boolean(acceptWarnings),
    materialLossesAccepted: false,
  };
}

export function reportIdFromResult(result) {
  if (result && typeof result === 'object') return result.reportId || result.id || null;
  const match = String(result || '').match(
    /(?:reportId|id)\s*:\s*"?([0-9a-f]{8}-[0-9a-f-]{27,})"?/i,
  );
  return match?.[1] || null;
}

export async function getReportSpec(reportId) {
  return sigmaRequest('GET', `/v2/reports/${reportId}/spec?format=json`);
}

export async function putReportSpec(reportId, spec) {
  const body = prepareReportForUpdate(spec);
  const offline = validateReportSpec(body, { mode: 'update' });
  if (!offline.valid) {
    throw new Error(`Report update validation failed: ${offline.errors.join('; ')}`);
  }
  return sigmaRequest('PUT', `/v2/reports/${reportId}/spec`, body);
}

export async function getReportInventory(reportId) {
  const [pages, elements, controls] = await Promise.all([
    sigmaRequest('GET', `/v2/reports/${reportId}/pages`),
    sigmaRequest('GET', `/v2/reports/${reportId}/elements`),
    sigmaRequest('GET', `/v2/reports/${reportId}/controls`),
  ]);
  return { pages, elements, controls };
}

export async function queryReportElement(reportId, elementId) {
  return sigmaRequest('GET', `/v2/reports/${reportId}/elements/${elementId}/query`);
}

export async function assertReportReadback(reportId, submitted, normalize) {
  const readback = await getReportSpec(reportId);
  const expected = normalize(submitted);
  const actual = normalize(readback);
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error('Report GET readback differs from the submitted normalized document');
  }
  return readback;
}

function reportPageElementIds(spec) {
  const result = {};
  const layout = String(reportDocument(spec).layout || '');
  const pagePattern = /<Page\b[^>]*\bid="([^"]*)"[^>]*>(.*?)<\/Page>/gs;
  for (const match of layout.matchAll(pagePattern)) {
    result[match[1]] = [...new Set(
      [...match[2].matchAll(/<Element\b[^>]*\belementId="([^"]*)"/g)]
        .map((element) => element[1]),
    )];
  }
  return result;
}

function compareReportElements(intended, generated) {
  const losses = [];
  const generatedByLabel = new Map();
  for (const element of generated) {
    const label = reportElementLabel(element);
    if (!generatedByLabel.has(label)) generatedByLabel.set(label, []);
    generatedByLabel.get(label).push(element);
  }
  const used = new Map();
  for (const element of intended) {
    const label = reportElementLabel(element);
    const occurrence = used.get(label) || 0;
    used.set(label, occurrence + 1);
    const candidate = generatedByLabel.get(label)?.[occurrence];
    if (!candidate) {
      losses.push({
        type: 'element-dropped',
        elementName: label,
        sourceElementId: element.id,
        sourceKind: element.kind,
      });
      continue;
    }
    const sourceShape = reportElementCoverageShape(element);
    const generatedShape = reportElementCoverageShape(candidate);
    if (!isDeepStrictEqual(sourceShape, generatedShape)) {
      losses.push({
        type: 'element-changed',
        elementName: label,
        sourceElementId: element.id,
        reportElementId: candidate.id,
        expected: sourceShape,
        actual: generatedShape,
      });
    }
  }
  return losses;
}

function reportElementLabel(element) {
  return String(element?.name ?? element?.body ?? '');
}

function reportElementCoverageShape(element) {
  return {
    kind: element?.kind ?? null,
    name: element?.name ?? null,
    body: element?.body ?? null,
    controlType: element?.controlType ?? null,
    columns: (element?.columns || []).map((column) => ({
      name: column?.name ?? null,
      formula: column?.formula ?? null,
      hidden: Boolean(column?.hidden),
    })),
  };
}

export async function exportReportPdf(
  reportId,
  outputPath,
  { layout = 'portrait', pageId, parameters, maxWaitMs = 120000, pollMs = 1500 } = {},
) {
  const token = await sigmaToken();
  const body = {
    ...(pageId ? { pageId } : {}),
    format: { type: 'pdf', layout },
    ...(parameters ? { parameters } : {}),
  };
  const startResponse = await fetch(`${SIGMA_BASE}/v2/reports/${reportId}/export`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const startText = await startResponse.text();
  if (!startResponse.ok) {
    throw new Error(`Report PDF export → HTTP ${startResponse.status} ${startText.slice(0, 500)}`);
  }
  let queryId;
  try { ({ queryId } = JSON.parse(startText)); } catch { /* handled below */ }
  if (!queryId) throw new Error(`Report PDF export returned no queryId: ${startText.slice(0, 500)}`);

  const startedAt = Date.now();
  let lastStatus = '';
  while (Date.now() - startedAt < maxWaitMs) {
    const response = await fetch(`${SIGMA_BASE}/v2/query/${queryId}/download`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf,*/*' },
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (response.status === 200 && buffer.length > 4) {
      if (buffer.subarray(0, 4).toString() !== '%PDF') {
        throw new Error(`Report export download was not a PDF: ${buffer.subarray(0, 200).toString()}`);
      }
      writeFileSync(outputPath, buffer);
      return { queryId, outputPath, bytes: buffer.length };
    }
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new Error(`Report export download → HTTP ${response.status} ${buffer.toString().slice(0, 500)}`);
    }
    lastStatus = `HTTP ${response.status}`;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`Report PDF export ${queryId} timed out after ${maxWaitMs}ms (${lastStatus})`);
}

