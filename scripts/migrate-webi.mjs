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
import {
  mergeAdditionsIntoView,
  resolveDataModelBindingAfterWrite,
  resolveDataModelViewBySourceName,
} from './dm-merge.mjs';
import { webiPreflight, assertPublishable, applyWarningPolicy } from './preflight.mjs';
import { writeConversionArtifacts } from './artifacts.mjs';
import {
  assessConvertedReportCoverage,
  convertWorkbookToReport,
  createConversionWarningEvidence,
  evaluateConvertedReportAcceptance,
  exportReportPdf,
  getReportSpec,
  verifyConversionWarningEvidence,
  verifyReport,
} from './sigma-report.mjs';
import { validateReportSpec } from './report-code-rep.mjs';
import { resolveTarget, targetWritePolicy } from './target.mjs';

const STATE = '.bo-state.json';

function arg(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const resumeReportId = arg('--resume-report-id');
  const localFile = arg('--file');
  const docId = localFile ? null : process.argv[2];
  const sourceLabel = localFile || docId;
  const universeId = arg('--universe');
  const dryRun = process.argv.includes('--dry-run');
  const create = process.argv.includes('--create');
  const acceptConversionWarnings = process.argv.includes('--accept-conversion-warnings');
  const failOnWarning = process.argv.includes('--fail-on-warning');
  const requestedOutput = arg('--out');
  if (resumeReportId) {
    if (!requestedOutput) {
      throw new Error('--resume-report-id requires --out pointing to the original artifact directory');
    }
    if (create || dryRun) {
      throw new Error('--resume-report-id is acceptance-only; do not combine it with --create or --dry-run');
    }
    await resumeWebiReportAcceptance({
      reportId: resumeReportId,
      artifactDir: resolve(requestedOutput),
      acceptConversionWarnings,
      pdfPath: arg('--pdf'),
      layout: arg('--layout') || 'portrait',
    });
    return;
  }
  const target = resolveTarget('webi', arg('--target') || 'auto');
  const writePolicy = targetWritePolicy(target.sourceType, target.resolvedTarget);
  const persistentRun = !dryRun
    && (target.resolvedTarget === 'workbook' || create);
  if (!sourceLabel || !universeId) {
    console.error('Usage: node scripts/migrate-webi.mjs <docId> --universe <universeId> [--target auto|workbook|report] [--create] [--accept-conversion-warnings] [--dry-run] [--out <dir>]');
    console.error('   or: node scripts/migrate-webi.mjs --file <normalized.json> --universe <universeId> --target report --dry-run');
    console.error('   or: node scripts/migrate-webi.mjs --resume-report-id <reportId> --out <existing-artifact-dir> [--accept-conversion-warnings] [--pdf <path>]');
    process.exit(1);
  }

  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  const qualifiedStateKey = `${BO_BASE}::${universeId}`;
  const bindingStateKey = state[qualifiedStateKey] ? qualifiedStateKey : universeId;
  const savedBinding = state[bindingStateKey] || {};
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
  const convertForBinding = (activeBinding) => {
    const converted = convertWebiToWorkbook({ document }, {
      folderId: process.env.SIGMA_FOLDER_ID,
      dataModelId: activeBinding.dataModelId || '<DATA_MODEL_ID>',
      dataModelElementId: activeBinding.viewElementId || '<VIEW_ELEMENT_ID>',
      sourceName: activeBinding.sourceName || '',
      measureMap: activeBinding.measureMap || {},
      schemaVersion,
      workbookName: document.name,
    });
    converted.warnings.unshift(...captured.warnings.map(warning => `RWS capture: ${warning}`));
    return converted;
  };
  let result = convertForBinding(binding);
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
    const currentView = resolveDataModelViewBySourceName(spec, binding.sourceName);
    const merge = mergeAdditionsIntoView(spec, currentView.id, additions);
    console.log(`  DM additions: +${merge.addedMetrics} metrics, +${merge.addedColumns} cols${merge.skipped.length ? `, skipped ${merge.skipped.join(', ')}` : ''}`);
    await postDataModelSpec(binding.dataModelId, spec);
    const dataModelReadback = await getDataModelSpec(binding.dataModelId);
    const resolvedBinding = resolveDataModelBindingAfterWrite(
      dataModelReadback,
      binding,
      additions,
    );
    const readbackView = resolvedBinding.view;
    const additionVerdict = resolvedBinding.additionsVerdict;
    writeJson(artifactDir, 'data-model-post-put-readback.json', dataModelReadback);
    writeJson(artifactDir, 'data-model-additions-verdict.json', additionVerdict);
    if (!additionVerdict.valid) {
      throw new Error(
        `Data-model additions failed PUT/GET verification: ${additionVerdict.errors.join('; ')}`,
      );
    }

    const previousViewElementId = binding.viewElementId;
    Object.assign(binding, resolvedBinding.binding);
    if (previousViewElementId !== binding.viewElementId) {
      state[bindingStateKey] = {
        ...savedBinding,
        ...binding,
        dataModelId: binding.dataModelId,
        viewElementId: binding.viewElementId,
        sourceName: binding.sourceName,
      };
      writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
      console.log(
        `Updated ${STATE}: View ${binding.sourceName} id changed `
        + `${previousViewElementId} → ${binding.viewElementId}`,
      );
    }
    saveLifecycle('data-model-readback-complete', {
      dataModelId: binding.dataModelId,
      dataModelViewName: binding.sourceName,
      previousViewElementId,
      viewElementId: binding.viewElementId,
      dataModelAdditionsVerified: true,
    });

    // Rebuild after readback even when the id happened to remain stable. The
    // verifier/create body must be derived from the authoritative binding that
    // survived the data-model write, never from the pre-PUT object.
    result = convertForBinding(binding);
    const rebuiltPreflight = applyWarningPolicy(
      webiPreflight(captured, result, binding),
      failOnWarning,
    );
    assertPublishable(rebuiltPreflight, 'Rebuilt Webi document');
    writeJson(artifactDir, 'conversion.json', result);
    writeJson(artifactDir, 'post-data-model-preflight.json', rebuiltPreflight);
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
  const warningEvidence = createConversionWarningEvidence(conversion.warnings, {
    workbookId,
    reportId: conversion.reportId,
  });
  saveLifecycle(
    conversion.reportId ? 'report-created-evidence-pending' : 'report-conversion-id-missing',
    {
      workbookId,
      reportId: conversion.reportId,
      reportUrl: conversion.reportUrl,
      conversionWarnings: conversion.warnings,
      conversionWarningsHash: warningEvidence.hash,
    },
  );
  console.log(`Report created (persistent): ${conversion.reportId || '(ID missing)'}`);
  console.log(`Report URL: ${conversion.reportUrl || '(not returned; recover using the report ID above)'}`);
  writeJson(artifactDir, 'report-conversion.json', conversion.result);
  writeJson(artifactDir, 'report-conversion-request.json', conversion.body);
  writeJson(artifactDir, 'report-conversion-warnings.json', conversion.warnings);
  writeJson(artifactDir, 'report-conversion-warning-evidence.json', warningEvidence);
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

async function resumeWebiReportAcceptance({
  reportId,
  artifactDir,
  acceptConversionWarnings,
  pdfPath,
  layout,
}) {
  const lifecycle = readJson(artifactDir, 'lifecycle.json');
  if (!lifecycle.reportId || lifecycle.reportId !== reportId) {
    throw new Error(
      `Resume report id ${reportId} does not match lifecycle.json `
      + `(${lifecycle.reportId || 'missing'})`,
    );
  }
  if (!lifecycle.workbookId) {
    throw new Error('lifecycle.json has no staging workbookId for coverage comparison');
  }

  const warningEvidence = readJson(
    artifactDir,
    'report-conversion-warning-evidence.json',
  );
  const conversionResult = readJson(artifactDir, 'report-conversion.json');
  const warningVerdict = verifyConversionWarningEvidence(
    warningEvidence,
    conversionResult,
    { workbookId: lifecycle.workbookId, reportId },
  );
  const savedWarnings = readJson(artifactDir, 'report-conversion-warnings.json');
  const savedWarningsHash = createConversionWarningEvidence(savedWarnings, {
    workbookId: lifecycle.workbookId,
    reportId,
  }).hash;
  if (savedWarningsHash !== warningVerdict.hash) {
    throw new Error('Saved conversion warning list does not match its stable evidence hash');
  }
  if (lifecycle.conversionWarningsHash !== warningVerdict.hash) {
    throw new Error('lifecycle.json warning hash does not match conversion-warning evidence');
  }
  console.log(
    `Resuming acceptance only for existing report ${reportId}; `
    + 'no workbook or report will be created.',
  );
  console.log(`Verified conversion warning evidence: sha256:${warningVerdict.hash}`);
  console.log(`Workbook conversion warnings (${warningVerdict.warningCount}):`);
  for (const warning of warningVerdict.warnings) console.log('  ⚠', JSON.stringify(warning));
  const workbookIntent = readJson(
    artifactDir,
    `${lifecycle.workbookId}.workbook-readback.json`,
  );

  const saveLifecycle = (status, extra = {}) => {
    Object.assign(lifecycle, extra, {
      status,
      updatedAt: new Date().toISOString(),
    });
    writeJson(artifactDir, 'lifecycle.json', lifecycle);
  };
  saveLifecycle('resume-evidence-running', {
    resumeReportId: reportId,
    warningEvidenceVerified: true,
  });
  let reportReadback;
  let coverage;
  let validationFailure = null;
  try {
    reportReadback = await getReportSpec(reportId);
    writeJson(artifactDir, `${reportId}.report-readback.json`, reportReadback);
    if (reportReadback?.url) {
      lifecycle.reportUrl = reportReadback.url;
      console.log(`Report URL (readback): ${reportReadback.url}`);
    }
    const validation = validateReportSpec(reportReadback);
    writeJson(artifactDir, `${reportId}.report-validation.json`, validation);
    if (validation.valid) {
      try {
        const reportVerify = await verifyReport(reportReadback);
        writeJson(artifactDir, `${reportId}.report-verify.json`, reportVerify);
        if (reportVerify?.valid === false) {
          validationFailure = `Sigma report verify rejected the converted report: ${JSON.stringify(reportVerify).slice(0, 1000)}`;
        }
      } catch (error) {
        validationFailure = `Converted report verification failed: ${error.message}`;
        writeJson(artifactDir, `${reportId}.report-verify-error.json`, {
          error: error.message,
        });
      }
    } else {
      validationFailure = `Converted report failed offline validation: ${validation.errors.join('; ')}`;
    }

    coverage = assessConvertedReportCoverage(workbookIntent, reportReadback);
    writeJson(artifactDir, `${reportId}.report-coverage.json`, coverage);
    console.log(`Generated report coverage: ${coverage.valid ? 'PASS' : 'MATERIAL LOSS'}`);
    for (const loss of coverage.materialLosses) console.log('  BLOCK', JSON.stringify(loss));

    const outputPath = resolve(pdfPath || join(artifactDir, `${reportId}.pdf`));
    mkdirSync(dirname(outputPath), { recursive: true });
    const exported = await exportReportPdf(reportId, outputPath, { layout });
    console.log(`PDF: ${exported.outputPath} (${exported.bytes} bytes)`);
    saveLifecycle('resume-evidence-complete-evaluation-pending', {
      reportReadbackSaved: true,
      reportValidationFailure: validationFailure,
      coverageValid: coverage.valid,
      materialLosses: coverage.materialLosses,
      pdf: exported,
    });
  } catch (error) {
    saveLifecycle('resume-evidence-failed', { error: error.message });
    throw error;
  }

  const acceptance = evaluateConvertedReportAcceptance({
    warnings: warningVerdict.warnings,
    acceptWarnings: acceptConversionWarnings,
    coverage,
    validationFailure,
  });
  writeJson(artifactDir, `${reportId}.report-acceptance.json`, acceptance);
  if (!acceptance.accepted) {
    saveLifecycle('pending-acceptance', {
      pendingReasons: acceptance.pendingReasons,
      conversionWarningsAccepted: acceptConversionWarnings,
    });
    throw new Error(
      `Existing report ${reportId} remains pending acceptance: `
      + `${acceptance.pendingReasons.join('; ')}.`,
    );
  }
  saveLifecycle('complete', {
    conversionWarningsAccepted: acceptConversionWarnings,
    acceptedByResume: true,
  });
  console.log(`Existing report accepted without creating another resource: ${reportId}`);
}

function readJson(outputDir, filename) {
  const path = join(outputDir, filename);
  if (!existsSync(path)) throw new Error(`Required resume artifact is missing: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(outputDir, filename, value) {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, filename), `${JSON.stringify(value, null, 2)}\n`);
}

main().catch(e => { console.error('migrate-webi failed:', e.message); process.exit(1); });
