#!/usr/bin/env node
/**
 * Migrate one Web Intelligence document → a Sigma workbook or report, bound
 * to the data model produced from its universe.
 *
 * Usage:  node scripts/migrate-webi.mjs <docId> --universe <universeId>
 *
 * Reads the universe binding (dataModelId + View element + measureMap) from
 * .bo-state.json (written by migrate-universe.mjs), fetches the Webi document
 * via RWS, converts it, and follows the selected target lifecycle.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { logon, getWebiDocument, BO_BASE } from './bo-rws.mjs';
import {
  getWorkbookSpec,
  getDataModelSpec,
  postDataModelSpec,
  postWorkbook,
  referenceWorkbookSchemaVersion,
  resolveWorkbookReadbackPageIds,
  verifyWorkbook,
} from './sigma.mjs';
import { convertWebiToWorkbook } from '../converters/webi.mjs';
import { mergeAdditionsIntoView } from './dm-merge.mjs';
import { webiPreflight, assertPublishable, applyWarningPolicy } from './preflight.mjs';
import { writeConversionArtifacts } from './artifacts.mjs';
import {
  assessConvertedReportCoverage,
  convertWorkbookToReport,
  evaluateConvertedReportAcceptance,
  exportReportPdf,
  getReportSpec,
  verifyReport,
} from './sigma-report.mjs';
import { validateReportSpec } from './report-code-rep.mjs';
import { resolveTarget, targetWritePolicy } from './target.mjs';

const STATE = '.bo-state.json';

function arg(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const localFile = arg('--file');
  const docId = localFile ? null : process.argv[2];
  const sourceLabel = localFile || docId;
  const universeId = arg('--universe');
  const dryRun = process.argv.includes('--dry-run');
  const create = process.argv.includes('--create');
  const acceptConversionWarnings = process.argv.includes('--accept-conversion-warnings');
  const failOnWarning = process.argv.includes('--fail-on-warning');
  const requestedOutput = arg('--out');
  const target = resolveTarget('webi', arg('--target') || 'auto');
  const writePolicy = targetWritePolicy(target.sourceType, target.resolvedTarget);
  const persistentRun = !dryRun
    && (target.resolvedTarget === 'workbook' || create);
  if (!sourceLabel || !universeId) {
    console.error('Usage: node scripts/migrate-webi.mjs <docId> --universe <universeId> [--target auto|workbook|report] [--create] [--accept-conversion-warnings] [--dry-run] [--out <dir>]');
    console.error('   or: node scripts/migrate-webi.mjs --file <normalized.json> --universe <universeId> --target report --dry-run');
    process.exit(1);
  }

  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const savedBinding = state[`${BO_BASE}::${universeId}`] || state[universeId] || {};
  const binding = {
    ...savedBinding,
    dataModelId: arg('--data-model-id') || savedBinding.dataModelId,
    viewElementId: arg('--view-element-id') || savedBinding.viewElementId,
    sourceName: arg('--source-name') || savedBinding.sourceName,
  };
  if (persistentRun && !binding.dataModelId) {
    console.error(`No binding for universe ${universeId} in ${STATE}`);
    process.exit(1);
  }

  let captured;
  if (localFile) {
    captured = JSON.parse(readFileSync(localFile, 'utf8'));
    captured.warnings ||= [];
    captured.snapshot ||= { importedFrom: localFile };
  } else {
    await logon();
    captured = await getWebiDocument(docId);
  }
  const { document } = captured;

  const schemaVersion = !persistentRun
    ? Number(process.env.SIGMA_WORKBOOK_SCHEMA_VERSION || 1)
    : await referenceWorkbookSchemaVersion();
  const result = convertWebiToWorkbook({ document }, {
    folderId: process.env.SIGMA_FOLDER_ID,
    dataModelId: binding.dataModelId || '<DATA_MODEL_ID>',
    dataModelElementId: binding.viewElementId || '<VIEW_ELEMENT_ID>',
    sourceName: binding.sourceName || '',
    measureMap: binding.measureMap || {},
    schemaVersion,
    workbookName: document.name,
  });
  result.warnings.unshift(...captured.warnings.map(warning => `RWS capture: ${warning}`));
  console.log('Converted document →', JSON.stringify(result.stats));
  result.warnings.forEach(w => console.log('  ⚠', w));

  const preflight = applyWarningPolicy(webiPreflight(captured, result, binding), failOnWarning);
  console.log('Preflight →', preflight.verdict);
  preflight.blockers.forEach(item => console.log(`  BLOCK ${item.code}: ${item.message}`));
  const artifactDir = requestedOutput
    || `artifacts/webi-${String(sourceLabel).replace(/[^a-z0-9_.-]+/gi, '-')}`;
  const targetMetadata = {
    ...target,
    ...writePolicy,
    createRequested: create,
    acceptConversionWarnings,
    dryRun,
    source: sourceLabel,
    universeId,
    ...(target.resolvedTarget === 'report'
      ? {
          reportFormat: {
            pageSize: arg('--page-size') || 'letter',
            layout: arg('--layout') || 'portrait',
          },
        }
      : {}),
  };
  writeConversionArtifacts(artifactDir, {
    source: captured.snapshot,
    normalized: { document, dataproviders: captured.dataproviders, warnings: captured.warnings },
    conversion: result,
    preflight,
    target: targetMetadata,
  });
  const lifecycle = {
    sourceType: 'webi',
    source: sourceLabel,
    target: target.resolvedTarget,
    workbookId: null,
    reportId: null,
    reportUrl: null,
    status: 'artifacts-written',
  };
  const saveLifecycle = (status, extra = {}) => {
    Object.assign(lifecycle, extra, {
      status,
      updatedAt: new Date().toISOString(),
    });
    writeJson(artifactDir, 'lifecycle.json', lifecycle);
  };
  saveLifecycle('artifacts-written');
  console.log('Wrote conversion artifacts:', artifactDir);
  if (dryRun) {
    if (target.resolvedTarget === 'report') {
      console.log(
        'Dry run complete; no Sigma resource was changed. With --create, the generated workbook '
        + 'would be verified, created, read back, converted to a report, reviewed, read back, '
        + 'validated, and exported to PDF.',
      );
    } else {
      console.log('Dry run complete; no data model or workbook was changed in Sigma.');
    }
    saveLifecycle('dry-run-complete');
    if (preflight.blockers.length) process.exitCode = 2;
    return;
  }
  if (target.resolvedTarget === 'report' && !create) {
    console.log(
      'Report target prepared locally; no persistent workbook/report was created. '
      + 'Pass --create only after approving the workbook, report name, and destination folder.',
    );
    saveLifecycle('pending-create-approval');
    if (preflight.blockers.length) process.exitCode = 2;
    return;
  }
  assertPublishable(preflight, 'Webi document');

  // Apply any DM-placed variables (context-free measures/dimensions) to the
  // bound universe's View element BEFORE creating the workbook, so the
  // workbook's qualified refs (e.g. [Order Fact View/Margin Pct]) resolve.
  // mergeAdditionsIntoView dedupes by name against existing columns+metrics,
  // so re-running this script against the same universe/document is safe —
  // it will skip (not double-add) anything already merged in.
  const additions = result.dataModelAdditions;
  if (additions && (additions.metrics.length || additions.columns.length)) {
    const spec = await getDataModelSpec(binding.dataModelId);
    const merge = mergeAdditionsIntoView(spec, binding.viewElementId, additions);
    console.log(`  DM additions: +${merge.addedMetrics} metrics, +${merge.addedColumns} cols${merge.skipped.length ? `, skipped ${merge.skipped.join(', ')}` : ''}`);
    await postDataModelSpec(binding.dataModelId, spec);
  }

  const verified = await verifyWorkbook(result.workbook);
  writeJson(artifactDir, 'workbook-verify.json', verified);
  if (verified?.valid === false) {
    throw new Error(`Sigma workbook verify rejected the spec: ${JSON.stringify(verified).slice(0, 1000)}`);
  }
  const workbookId = await postWorkbook(result.workbook);
  if (!workbookId) throw new Error('Sigma workbook create returned no workbookId');
  console.log('Workbook created:', workbookId);
  saveLifecycle('workbook-created-readback-pending', { workbookId });
  const workbookReadback = await getWorkbookSpec(workbookId);
  writeJson(artifactDir, `${workbookId}.workbook-readback.json`, workbookReadback);
  const requestedPageIds = arg('--page-ids')
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean) || [];
  const pageResolution = resolveWorkbookReadbackPageIds(
    result.workbook,
    workbookReadback,
    requestedPageIds,
  );
  writeJson(artifactDir, `${workbookId}.workbook-readback-verdict.json`, pageResolution.verdict);
  saveLifecycle('workbook-readback-complete', {
    workbookId,
    workbookReadbackValid: pageResolution.verdict.valid,
    workbookPageIds: pageResolution.pageIds,
  });
  console.log(`Open: ${process.env.SIGMA_BASE_URL || 'https://app.sigmacomputing.com'} → workbook ${workbookId}`);

  if (target.resolvedTarget === 'workbook') {
    saveLifecycle('complete', { workbookId });
    return;
  }

  const conversion = await convertWorkbookToReport(workbookId, {
    name: arg('--name') || `${document.name} (Report)`,
    destinationFolderId: arg('--destination-folder-id') || process.env.SIGMA_FOLDER_ID,
    description: arg('--description') || `Converted from SAP Web Intelligence document ${sourceLabel}.`,
    pageIds: pageResolution.pageIds,
    format: {
      pageSize: arg('--page-size') || 'letter',
      layout: arg('--layout') || 'portrait',
    },
  });
  saveLifecycle(
    conversion.reportId ? 'report-created-evidence-pending' : 'report-conversion-id-missing',
    {
      workbookId,
      reportId: conversion.reportId,
      reportUrl: conversion.reportUrl,
      conversionWarnings: conversion.warnings,
    },
  );
  console.log(`Report created (persistent): ${conversion.reportId || '(ID missing)'}`);
  console.log(`Report URL: ${conversion.reportUrl || '(not returned; recover using the report ID above)'}`);
  writeJson(artifactDir, 'report-conversion.json', conversion.result);
  writeJson(artifactDir, 'report-conversion-request.json', conversion.body);
  writeJson(artifactDir, 'report-conversion-warnings.json', conversion.warnings);
  console.log(`Workbook conversion warnings (${conversion.warnings.length}):`);
  for (const warning of conversion.warnings) console.log('  ⚠', JSON.stringify(warning));
  if (!conversion.reportId) {
    throw new Error(`Workbook conversion returned no reportId: ${JSON.stringify(conversion.result).slice(0, 1000)}`);
  }

  let validationFailure = null;
  let coverage;
  let reportReadback;
  try {
    reportReadback = await getReportSpec(conversion.reportId);
    writeJson(artifactDir, `${conversion.reportId}.report-readback.json`, reportReadback);
    if (reportReadback?.url && reportReadback.url !== lifecycle.reportUrl) {
      lifecycle.reportUrl = reportReadback.url;
      console.log(`Report URL (readback): ${reportReadback.url}`);
    }
    const validation = validateReportSpec(reportReadback);
    writeJson(artifactDir, `${conversion.reportId}.report-validation.json`, validation);
    if (validation.valid) {
      try {
        const reportVerify = await verifyReport(reportReadback);
        writeJson(artifactDir, `${conversion.reportId}.report-verify.json`, reportVerify);
        if (reportVerify?.valid === false) {
          validationFailure = `Sigma report verify rejected the converted report: ${JSON.stringify(reportVerify).slice(0, 1000)}`;
        }
      } catch (error) {
        validationFailure = `Converted report verification failed: ${error.message}`;
        writeJson(artifactDir, `${conversion.reportId}.report-verify-error.json`, {
          error: error.message,
        });
      }
    } else {
      validationFailure = `Converted report failed offline validation: ${validation.errors.join('; ')}`;
    }
    coverage = assessConvertedReportCoverage(workbookReadback, reportReadback);
    writeJson(artifactDir, `${conversion.reportId}.report-coverage.json`, coverage);
    console.log(`Generated report coverage: ${coverage.valid ? 'PASS' : 'MATERIAL LOSS'}`);
    for (const loss of coverage.materialLosses) console.log('  BLOCK', JSON.stringify(loss));

    const pdfPath = resolve(arg('--pdf') || join(artifactDir, `${conversion.reportId}.pdf`));
    mkdirSync(dirname(pdfPath), { recursive: true });
    const exported = await exportReportPdf(conversion.reportId, pdfPath, {
      layout: arg('--layout') || 'portrait',
    });
    console.log(`PDF: ${exported.outputPath} (${exported.bytes} bytes)`);
    saveLifecycle('evidence-complete-evaluation-pending', {
      reportUrl: lifecycle.reportUrl,
      reportReadbackSaved: true,
      reportValidationFailure: validationFailure,
      coverageValid: coverage.valid,
      materialLosses: coverage.materialLosses,
      pdf: exported,
    });
  } catch (error) {
    saveLifecycle('evidence-failed', {
      reportUrl: lifecycle.reportUrl,
      error: error.message,
    });
    throw error;
  }

  const acceptance = evaluateConvertedReportAcceptance({
    warnings: conversion.warnings,
    acceptWarnings: acceptConversionWarnings,
    coverage,
    validationFailure,
  });
  writeJson(artifactDir, `${conversion.reportId}.report-acceptance.json`, acceptance);
  if (!acceptance.accepted) {
    saveLifecycle('pending-acceptance', {
      pendingReasons: acceptance.pendingReasons,
      conversionWarningsAccepted: acceptConversionWarnings,
    });
    throw new Error(
      `Converted report evidence is pending acceptance: ${acceptance.pendingReasons.join('; ')}. `
      + 'Do not blindly rerun and create a duplicate; recover the created report from lifecycle.json.',
    );
  }
  saveLifecycle('complete', {
    conversionWarningsAccepted: acceptConversionWarnings,
  });
  console.log(`Report accepted: ${conversion.reportId}`);
}

function writeJson(outputDir, filename, value) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`);
}

main().catch(e => { console.error('migrate-webi failed:', e.message); process.exit(1); });
