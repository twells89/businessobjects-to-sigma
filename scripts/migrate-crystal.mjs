#!/usr/bin/env node
/**
 * Convert a Crystal IR file into a Sigma pixel-perfect report or an
 * interactive workbook first draft.
 *
 * By default this writes and verifies a report spec without persistent create.
 * Pass --create only after confirming SIGMA_FOLDER_ID and the target org.
 *
 * Usage:
 *   node scripts/migrate-crystal.mjs --ir report.ir.json
 *   node scripts/migrate-crystal.mjs --ir report.ir.json --create --pdf out.pdf
 *   node scripts/migrate-crystal.mjs --ir report.ir.json --target workbook
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  buildValidatedCrystalDataModelFieldMap,
  convertCrystalToReport,
  convertCrystalToWorkbook,
  normalizeCrystalFieldMap,
} from '../converters/crystal.mjs';
import { normalizeReportForComparison, validateReportSpec } from './report-code-rep.mjs';
import {
  assertReportReadback,
  exportReportPdf,
  postReport,
  referenceReportSchemaVersion,
  verifyReport,
} from './sigma-report.mjs';
import {
  assessWorkbookSemanticReadback,
  getDataModelSpec,
  getWorkbookSpec,
  postWorkbook,
  referenceWorkbookSchemaVersion,
  verifyWorkbook,
} from './sigma.mjs';
import { resolveTarget, targetWritePolicy } from './target.mjs';
import { isDirectRun, parseCliArgs } from './cli-args.mjs';

const VALUE_FLAGS = [
  '--ir', '--target', '--pdf', '--artifacts', '--database', '--schema',
  '--source-table', '--name', '--data-model-id', '--data-model-element-id',
  '--source-name', '--field-map',
];
const BOOLEAN_FLAGS = ['--create', '--dry-run', '--group-customers', '--help'];

export function parseCrystalArgs(argv) {
  const parsed = parseCliArgs(argv, {
    valueFlags: VALUE_FLAGS,
    booleanFlags: BOOLEAN_FLAGS,
  });
  if (parsed.positionals.length > 1) {
    throw new Error(`Unexpected positional arguments: ${parsed.positionals.slice(1).join(' ')}`);
  }
  if (parsed.value('--ir') && parsed.positionals.length) {
    throw new Error(`Unexpected positional argument with --ir: ${parsed.positionals[0]}`);
  }
  return {
    ...parsed,
    irPath: parsed.value('--ir') || parsed.positionals[0] || null,
  };
}

async function main(argv = process.argv.slice(2)) {
  const cli = parseCrystalArgs(argv);
  const { value, has, irPath } = cli;
  if (has('--help') || !irPath) {
    console.error('Usage: node scripts/migrate-crystal.mjs --ir report.ir.json [--target auto|report|workbook] [--field-map mapping.json] [--create] [--pdf output.pdf]');
    if (!has('--help')) process.exitCode = 2;
    return;
  }
  const absoluteIr = resolve(irPath);
  const ir = JSON.parse(readFileSync(absoluteIr, 'utf8'));
  const outputDir = resolve(value('--artifacts') || 'artifacts/crystal');
  mkdirSync(outputDir, { recursive: true });
  const target = resolveTarget('crystal', value('--target') || 'auto');
  const dryRun = has('--dry-run');
  const create = has('--create');
  const targetMetadata = {
    ...target,
    ...targetWritePolicy(target.sourceType, target.resolvedTarget),
    createRequested: create,
    dryRun,
    source: absoluteIr,
    ...(value('--field-map') ? { fieldMapFile: resolve(value('--field-map')) } : {}),
  };
  const stem = basename(absoluteIr).replace(/(\.crystal-ir)?\.json$/i, '');
  const targetPath = resolve(outputDir, `${stem}.target.json`);
  writeFileSync(targetPath, JSON.stringify(targetMetadata, null, 2));

  if (target.resolvedTarget === 'workbook') {
    await migrateWorkbook({ ir, absoluteIr, outputDir, stem, targetPath, dryRun, create, cli });
    return;
  }
  await migrateReport({ ir, absoluteIr, outputDir, stem, targetPath, dryRun, create, cli });
}

function reportConversionOptions(ir, absoluteIr, cli) {
  const { value, has } = cli;
  return {
    folderId: process.env.SIGMA_FOLDER_ID,
    connectionId: process.env.SIGMA_CONNECTION_ID,
    database: value('--database') || process.env.CRYSTAL_SNOWFLAKE_DATABASE || 'CRYSTAL_MIGRATION_DEMO',
    schema: value('--schema') || process.env.CRYSTAL_SNOWFLAKE_SCHEMA || 'PUBLIC',
    sourceTable: value('--source-table') || 'CUSTOMER_STATEMENT_ROWS',
    reportName: value('--name') || `${ir.report?.name || basename(absoluteIr, '.json')} (Crystal Migration)`,
    groupCustomers: has('--group-customers'),
  };
}

function workbookConversionOptions(ir, absoluteIr, cli) {
  const { value } = cli;
  const explicitSourceTable = value('--source-table');
  const fieldMapFile = value('--field-map');
  const fieldMap = fieldMapFile
    ? normalizeCrystalFieldMap(JSON.parse(readFileSync(resolve(fieldMapFile), 'utf8')))
    : {};
  return {
    folderId: process.env.SIGMA_FOLDER_ID,
    connectionId: process.env.SIGMA_CONNECTION_ID,
    database: value('--database')
      || (explicitSourceTable ? process.env.CRYSTAL_SNOWFLAKE_DATABASE : null),
    schema: value('--schema')
      || (explicitSourceTable ? process.env.CRYSTAL_SNOWFLAKE_SCHEMA : null),
    sourceTable: explicitSourceTable,
    workbookName: value('--name')
      || `${ir.report?.name || basename(absoluteIr, '.json')} (Interactive)`,
    dataModelId: value('--data-model-id'),
    dataModelElementId: value('--data-model-element-id'),
    sourceName: value('--source-name'),
    fieldMap,
  };
}

async function migrateReport({
  ir, absoluteIr, outputDir, stem, targetPath, dryRun, create, cli,
}) {
  const { value } = cli;
  const schemaVersion = dryRun
    ? Number(process.env.SIGMA_REPORT_SCHEMA_VERSION || 1)
    : await referenceReportSchemaVersion();
  const result = convertCrystalToReport(ir, {
    ...reportConversionOptions(ir, absoluteIr, cli),
    schemaVersion,
  });
  const offline = validateReportSpec(result.report);
  if (!offline.valid) throw new Error(`Offline report validation failed: ${offline.errors.join('; ')}`);
  const specPath = resolve(outputDir, `${stem}.sigma-report.json`);
  const ledgerPath = resolve(outputDir, `${stem}.degradations.json`);
  writeFileSync(specPath, JSON.stringify(result.report, null, 2));
  writeFileSync(ledgerPath, JSON.stringify(result.degradationLedger, null, 2));
  console.log('Converted Crystal IR →', JSON.stringify(result.stats));
  console.log(`Report spec: ${specPath}`);
  console.log(`Degradation ledger: ${ledgerPath}`);
  console.log(`Target metadata: ${targetPath}`);
  for (const warning of result.warnings) console.log('  ⚠', warning);

  if (dryRun) {
    console.log('Dry run complete; no Sigma verification or persistent report creation was attempted.');
    return;
  }
  const verified = await verifyReport(result.report);
  console.log('Sigma verify:', JSON.stringify(verified));
  if (!create) {
    console.log('Verification complete; no report created. Pass --create for the approved persistent write.');
    return;
  }

  const created = await postReport(result.report, { verify: false });
  if (!created.reportId) throw new Error(`Sigma create returned no reportId: ${JSON.stringify(created.result)}`);
  const createdSpecPath = resolve(outputDir, `${created.reportId}.submitted.json`);
  writeFileSync(createdSpecPath, JSON.stringify(created.body, null, 2));
  const readback = await assertReportReadback(
    created.reportId,
    created.body,
    normalizeReportForComparison,
  );
  const readbackPath = resolve(outputDir, `${created.reportId}.readback.json`);
  writeFileSync(readbackPath, JSON.stringify(readback, null, 2));
  console.log(`Report created: ${created.reportId}`);
  console.log(`Readback: ${readbackPath}`);

  const pdfPath = resolve(value('--pdf') || `${outputDir}/${created.reportId}.pdf`);
  mkdirSync(dirname(pdfPath), { recursive: true });
  const exported = await exportReportPdf(
    created.reportId,
    pdfPath,
    { layout: ir.page?.orientation === 'landscape' ? 'landscape' : 'portrait' },
  );
  console.log(`PDF: ${exported.outputPath} (${exported.bytes} bytes)`);
}

async function migrateWorkbook({
  ir, absoluteIr, outputDir, stem, targetPath, dryRun, create, cli,
}) {
  const conversionOptions = workbookConversionOptions(ir, absoluteIr, cli);
  if (conversionOptions.dataModelId && !dryRun) {
    const dataModelSpec = await getDataModelSpec(conversionOptions.dataModelId);
    const validatedMapping = buildValidatedCrystalDataModelFieldMap(ir, dataModelSpec, {
      dataModelElementId: conversionOptions.dataModelElementId,
      sourceName: conversionOptions.sourceName,
      fieldMap: conversionOptions.fieldMap,
    });
    conversionOptions.fieldMap = validatedMapping.fieldMap;
    conversionOptions.dataModelElementId = validatedMapping.dataModelElementId;
    writeFileSync(
      resolve(outputDir, `${stem}.data-model-field-map.json`),
      JSON.stringify(validatedMapping, null, 2),
    );
  }
  const schemaVersion = dryRun
    ? Number(process.env.SIGMA_WORKBOOK_SCHEMA_VERSION || 1)
    : await referenceWorkbookSchemaVersion();
  const result = convertCrystalToWorkbook(ir, {
    ...conversionOptions,
    schemaVersion,
  });
  const specPath = resolve(outputDir, `${stem}.sigma-workbook.json`);
  const ledgerPath = resolve(outputDir, `${stem}.degradations.json`);
  writeFileSync(specPath, JSON.stringify(result.workbook, null, 2));
  writeFileSync(ledgerPath, JSON.stringify(result.degradationLedger, null, 2));
  console.log('Converted Crystal IR → interactive workbook first draft:', JSON.stringify(result.stats));
  console.log(`Workbook spec: ${specPath}`);
  console.log(`Degradation ledger: ${ledgerPath}`);
  console.log(`Target metadata: ${targetPath}`);
  for (const warning of result.warnings) console.log('  ⚠', warning);

  if (dryRun) {
    console.log('Dry run complete; no Sigma verification or persistent workbook creation was attempted.');
    return;
  }
  const verified = await verifyWorkbook(result.workbook);
  console.log('Sigma workbook verify:', JSON.stringify(verified));
  if (verified?.valid === false) {
    throw new Error(`Sigma workbook verify rejected the spec: ${JSON.stringify(verified).slice(0, 1000)}`);
  }
  if (!create) {
    console.log('Verification complete; no workbook created. Pass --create for the approved persistent write.');
    return;
  }

  const workbookId = await postWorkbook(result.workbook);
  if (!workbookId) throw new Error('Sigma workbook create returned no workbookId');
  const readback = await getWorkbookSpec(workbookId);
  const readbackVerdict = assessWorkbookSemanticReadback(result.workbook, readback);
  const readbackPath = resolve(outputDir, `${workbookId}.readback.json`);
  const verdictPath = resolve(outputDir, `${workbookId}.readback-verdict.json`);
  writeFileSync(readbackPath, JSON.stringify(readback, null, 2));
  writeFileSync(verdictPath, JSON.stringify(readbackVerdict, null, 2));
  if (!readbackVerdict.valid) {
    throw new Error(
      `Crystal workbook semantic readback failed: ${readbackVerdict.errors.join('; ')}`,
    );
  }
  console.log(`Workbook created: ${workbookId}`);
  console.log(`Readback: ${readbackPath}`);
  console.log(`Readback verdict: ${verdictPath}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch(error => {
    console.error('migrate-crystal failed:', error.message);
    process.exitCode = 1;
  });
}

