/**
 * Sigma pixel-perfect Report lifecycle helpers.
 *
 * Report code rep is JSON:
 *   create/verify: { name, folderId, document }
 *   update:        { document }
 * where document.kind === "report" and layout is absolute-pixel XML.
 */

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  const reportId = convertedReportIdFromResult(result);
  const reportUrl = typeof converted === 'object'
    ? converted?.url || result?.url || null
    : result?.url || null;
  const warnings = conversionWarningsFromResult(result);
  return { reportId, reportUrl, warnings, result, body };
}

export function conversionWarningsFromResult(result) {
  return Array.isArray(result?.warnings)
    ? result.warnings
    : (result?.warnings == null ? [] : [result.warnings]);
}

export function convertedReportIdFromResult(result) {
  const converted = result?.convertedReport;
  return typeof converted === 'string'
    ? converted
    : converted?.reportId || converted?.id || converted?.fileId
      || result?.reportId || result?.id || result?.fileId || null;
}

export function stableEvidenceHash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function createConversionWarningEvidence(
  warnings = [],
  { workbookId = null, reportId = null } = {},
) {
  const normalized = Array.isArray(warnings) ? warnings : [warnings];
  const payload = { workbookId, reportId, warnings: normalized };
  return {
    version: 1,
    algorithm: 'sha256',
    workbookId,
    reportId,
    warningCount: normalized.length,
    warnings: normalized,
    hash: stableEvidenceHash(payload),
  };
}

/**
 * Validate the saved warning checksum against both its embedded warning list
 * and the saved convertToReport response artifact. This is an integrity
 * checksum, not a signature; it prevents accidental acceptance against edited
 * or mismatched evidence.
 */
export function verifyConversionWarningEvidence(
  evidence,
  conversionResult,
  { workbookId = evidence?.workbookId ?? null, reportId = evidence?.reportId ?? null } = {},
) {
  if (evidence?.version !== 1 || evidence?.algorithm !== 'sha256') {
    throw new Error('Unsupported or missing conversion-warning evidence format');
  }
  if (!Array.isArray(evidence.warnings)) {
    throw new Error('Conversion-warning evidence does not contain a warning array');
  }
  const evidenceHash = stableEvidenceHash({
    workbookId: evidence.workbookId ?? null,
    reportId: evidence.reportId ?? null,
    warnings: evidence.warnings,
  });
  if (evidence.hash !== evidenceHash || evidence.warningCount !== evidence.warnings.length) {
    throw new Error('Conversion-warning evidence checksum/count does not match its warning list');
  }
  const responseWarnings = conversionWarningsFromResult(conversionResult);
  const responseHash = stableEvidenceHash({
    workbookId: evidence.workbookId ?? null,
    reportId: evidence.reportId ?? null,
    warnings: responseWarnings,
  });
  if (responseHash !== evidence.hash) {
    throw new Error('Conversion-warning evidence does not match the saved convertToReport response');
  }
  if ((evidence.workbookId ?? null) !== workbookId || (evidence.reportId ?? null) !== reportId) {
    throw new Error('Conversion-warning evidence is bound to different workbook/report ids');
  }
  const responseReportId = convertedReportIdFromResult(conversionResult);
  if (reportId && responseReportId !== reportId) {
    throw new Error('Saved convertToReport response identifies a different report');
  }
  const responseWorkbookId = conversionResult?.sourceWorkbook?.workbookId
    || conversionResult?.sourceWorkbook?.id
    || null;
  if (workbookId && responseWorkbookId && responseWorkbookId !== workbookId) {
    throw new Error('Saved convertToReport response identifies a different workbook');
  }
  return {
    valid: true,
    hash: evidence.hash,
    workbookId,
    reportId,
    warnings: evidence.warnings,
    warningCount: evidence.warningCount,
  };
}

/**
 * Compare workbook intent with generated-report readback after remapping
 * server-assigned page, element, column, and grouping ids. Target-only
 * defaults and hidden dependency content are allowed, but every source field
 * must survive: sources, formulas, filters, groupings, sorts, conditional
 * formats, and chart/KPI bindings are all compared.
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
  const pagePairs = [];
  const sourcePageIds = new Map();
  const targetPageIds = new Map();
  for (const [sourceIndex, sourcePage] of (source.document.pages || []).entries()) {
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
    const targetIndex = targetPages.indexOf(targetPage);
    const pageToken = `page:${name}#${occurrence + 1}`;
    sourcePageIds.set(sourcePage.id, pageToken);
    targetPageIds.set(targetPage.id, pageToken);
    const intended = (sourceMembership[sourcePage.id] || [])
      .map((id) => sourceElements.get(id))
      .filter(Boolean);
    const generated = (targetMembership[targetPage.id] || [])
      .map((id) => targetElements.get(id))
      .filter(Boolean);
    const matched = matchReportElements(intended, generated);
    const pageRecord = {
      pageName: name,
      sourcePageId: sourcePage.id,
      reportPageId: targetPage.id,
      sourceIndex,
      reportIndex: targetIndex,
      intendedElements: intended.length,
      generatedElements: generated.length,
      losses: matched.losses,
    };
    pages.push(pageRecord);
    pagePairs.push({ sourcePage, targetPage, intended, generated, matched, pageRecord });
    losses.push(...matched.losses.map((loss) => ({
      ...loss,
      sourcePageId: sourcePage.id,
      reportPageId: targetPage.id,
      pageName: name,
    })));
  }

  const mappedIndices = pagePairs.map(pair => targetPages.indexOf(pair.targetPage));
  if (mappedIndices.some((value, index) => index > 0 && value <= mappedIndices[index - 1])) {
    losses.push({
      type: 'page-order-changed',
      expected: pagePairs.map(pair => pair.sourcePage.name),
      actual: [...pagePairs]
        .sort((left, right) =>
          targetPages.indexOf(left.targetPage) - targetPages.indexOf(right.targetPage))
        .map(pair => pair.targetPage.name),
    });
  }

  const sourceElementIds = new Map();
  const targetElementIds = new Map();
  for (const pair of pagePairs) {
    for (const [index, match] of pair.matched.pairs.entries()) {
      const token = `element:${pair.sourcePage.name}#${index + 1}:${reportElementLabel(match.source)}`;
      sourceElementIds.set(match.source.id, token);
      targetElementIds.set(match.target.id, token);
    }
  }
  const sourceRefs = new Map([...sourcePageIds, ...sourceElementIds]);
  const targetRefs = new Map([...targetPageIds, ...targetElementIds]);
  for (const pair of pagePairs) {
    for (const match of pair.matched.pairs) {
      const comparison = compareReportElementIntent(
        match.source,
        match.target,
        sourceRefs,
        targetRefs,
      );
      if (!comparison.equal) {
        const loss = {
          type: 'element-changed',
          elementName: reportElementLabel(match.source),
          sourceElementId: match.source.id,
          reportElementId: match.target.id,
          expected: comparison.expected,
          actual: comparison.actual,
          sourcePageId: pair.sourcePage.id,
          reportPageId: pair.targetPage.id,
          pageName: pair.sourcePage.name,
        };
        losses.push(loss);
        pair.pageRecord.losses.push(loss);
      }
    }
  }

  const placedSourceIds = new Set(Object.values(sourceMembership).flat());
  const unplacedSourceIds = [...sourceElements.keys()]
    .filter(elementId => !placedSourceIds.has(elementId));
  if (unplacedSourceIds.length) {
    losses.push({
      type: 'source-unplaced-elements',
      intendedElements: sourceElements.size,
      placedElements: placedSourceIds.size,
      unplacedSourceElementIds: unplacedSourceIds,
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
    documentedRewrites: [
      'server-assigned page, element, column, and grouping identifiers',
      'target-only report defaults and hidden dependency pages/elements',
      'absolute report layout coordinates generated from workbook grid placement',
    ],
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
  if (!coverage) {
    pendingReasons.push('generated report coverage evidence is missing');
  } else if (!coverage.valid) {
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

function matchReportElements(intended, generated) {
  const losses = [];
  const pairs = [];
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
    pairs.push({ source: element, target: candidate });
  }
  return { losses, pairs };
}

function reportElementLabel(element) {
  return String(element?.name ?? element?.body ?? '');
}

const SERVER_ONLY_INTENT_KEYS = new Set([
  'createdAt', 'updatedAt', 'version', 'url', 'workbookId', 'reportId',
]);
const ID_REFERENCE_KEYS = new Set([
  'columnId', 'columnIds', 'order', 'groupBy', 'calculations', 'values',
  'pageId', 'pageIds', 'elementId', 'elementIds', 'targetElementId',
  'sourceElementId', 'containerId',
]);

function compareReportElementIntent(source, target, sourceRefs, targetRefs) {
  const sourceColumns = Array.isArray(source?.columns) ? source.columns : [];
  const targetColumns = Array.isArray(target?.columns) ? target.columns : [];
  const sourceColumnRefs = new Map(sourceRefs);
  const targetColumnRefs = new Map(targetRefs);
  const targetByName = new Map();
  for (const column of targetColumns) {
    const name = String(column?.name ?? '');
    if (!targetByName.has(name)) targetByName.set(name, []);
    targetByName.get(name).push(column);
  }
  const nameUse = new Map();
  const columnPairs = sourceColumns.map((column) => {
    const name = String(column?.name ?? '');
    const occurrence = nameUse.get(name) || 0;
    nameUse.set(name, occurrence + 1);
    const candidate = targetByName.get(name)?.[occurrence];
    const token = `column:${name}#${occurrence + 1}`;
    if (column?.id != null) sourceColumnRefs.set(column.id, token);
    if (candidate?.id != null) targetColumnRefs.set(candidate.id, token);
    return { source: column, target: candidate };
  });

  const keys = Object.keys(source || {})
    .filter(key => key !== 'id' && key !== 'columns' && !SERVER_ONLY_INTENT_KEYS.has(key));
  const expected = {};
  const actual = {};
  for (const key of keys) {
    expected[key] = normalizeIntentValue(source[key], sourceColumnRefs, key);
    actual[key] = key in (target || {})
      ? normalizeIntentProjection(source[key], target[key], targetColumnRefs, key)
      : { missing: true };
  }
  if ('columns' in (source || {})) {
    expected.columns = columnPairs.map(pair =>
      normalizeIntentValue(pair.source, sourceColumnRefs));
    actual.columns = columnPairs.map(pair => pair.target
      ? normalizeIntentProjection(pair.source, pair.target, targetColumnRefs)
      : { missing: true });
  }
  return {
    equal: isDeepStrictEqual(expected, actual),
    expected,
    actual,
  };
}

function normalizeIntentValue(value, refs, key = '') {
  if (Array.isArray(value)) return value.map(item => normalizeIntentValue(item, refs, key));
  if (value == null || typeof value !== 'object') {
    return typeof value === 'string' && ID_REFERENCE_KEYS.has(key) && refs.has(value)
      ? refs.get(value)
      : value;
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'id' || SERVER_ONLY_INTENT_KEYS.has(key)) continue;
    result[key] = normalizeIntentValue(child, refs, key);
  }
  return result;
}

/**
 * Project a readback value onto exactly the submitted shape. Readback-only
 * defaults are ignored; missing or changed submitted fields remain visible.
 */
function normalizeIntentProjection(expected, actual, refs, key = '') {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { missing: true };
    return expected.map((item, index) => index < actual.length
      ? normalizeIntentProjection(item, actual[index], refs, key)
      : { missing: true });
  }
  if (expected != null && typeof expected === 'object') {
    if (actual == null || typeof actual !== 'object' || Array.isArray(actual)) {
      return { missing: true };
    }
    const result = {};
    for (const key of Object.keys(expected)) {
      if (key === 'id' || SERVER_ONLY_INTENT_KEYS.has(key)) continue;
      result[key] = key in actual
        ? normalizeIntentProjection(expected[key], actual[key], refs, key)
        : { missing: true };
    }
    return result;
  }
  return normalizeIntentValue(actual, refs, key);
}

function stableJson(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item == null || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.keys(item).sort().map(key => [key, canonical(item[key])]),
    );
  };
  return JSON.stringify(canonical(value));
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

