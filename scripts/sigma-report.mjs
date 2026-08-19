/**
 * Sigma pixel-perfect Report lifecycle helpers.
 *
 * Report code rep is JSON:
 *   create/verify: { name, folderId, document }
 *   update:        { document }
 * where document.kind === "report" and layout is absolute-pixel XML.
 */

import { writeFileSync } from 'node:fs';
import { prepareReportForPost, prepareReportForUpdate, validateReportSpec } from './report-code-rep.mjs';
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
    reportId: result.reportId || result.id,
    result,
    body,
    warnings: offline.warnings,
  };
}

export async function getReportSpec(reportId) {
  return sigmaRequest('GET', `/v2/reports/${reportId}/spec`);
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
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error('Report GET readback differs from the submitted normalized document');
  }
  return readback;
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

