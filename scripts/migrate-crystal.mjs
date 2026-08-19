#!/usr/bin/env node
/**
 * Convert a Crystal IR file into a Sigma pixel-perfect report.
 *
 * By default this writes and verifies a report spec without persistent create.
 * Pass --create only after confirming SIGMA_FOLDER_ID and the target org.
 *
 * Usage:
 *   node scripts/migrate-crystal.mjs --ir report.ir.json
 *   node scripts/migrate-crystal.mjs --ir report.ir.json --create --pdf out.pdf
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { convertCrystalToReport } from '../converters/crystal.mjs';
import { normalizeReportForComparison, validateReportSpec } from './report-code-rep.mjs';
import {
  assertReportReadback,
  exportReportPdf,
  postReport,
  referenceReportSchemaVersion,
  verifyReport,
} from './sigma-report.mjs';

const args = process.argv.slice(2);
const value = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const has = flag => args.includes(flag);
const irPath = value('--ir') || args.find(arg => !arg.startsWith('--'));

if (!irPath) {
  console.error('Usage: node scripts/migrate-crystal.mjs --ir report.ir.json [--create] [--pdf output.pdf]');
  process.exit(2);
}

async function main() {
  const absoluteIr = resolve(irPath);
  const ir = JSON.parse(readFileSync(absoluteIr, 'utf8'));
  const outputDir = resolve(value('--artifacts') || 'artifacts/crystal');
  mkdirSync(outputDir, { recursive: true });

  const schemaVersion = await referenceReportSchemaVersion();
  const result = convertCrystalToReport(ir, {
    folderId: process.env.SIGMA_FOLDER_ID,
    connectionId: process.env.SIGMA_CONNECTION_ID,
    database: value('--database') || process.env.CRYSTAL_SNOWFLAKE_DATABASE || 'CRYSTAL_MIGRATION_DEMO',
    schema: value('--schema') || process.env.CRYSTAL_SNOWFLAKE_SCHEMA || 'PUBLIC',
    sourceTable: value('--source-table') || 'CUSTOMER_STATEMENT_ROWS',
    schemaVersion,
    reportName: value('--name') || `${ir.report?.name || basename(absoluteIr, '.json')} (Crystal Migration)`,
  });

  const offline = validateReportSpec(result.report);
  if (!offline.valid) throw new Error(`Offline report validation failed: ${offline.errors.join('; ')}`);
  const stem = basename(absoluteIr).replace(/(\.crystal-ir)?\.json$/i, '');
  const specPath = resolve(outputDir, `${stem}.sigma-report.json`);
  const ledgerPath = resolve(outputDir, `${stem}.degradations.json`);
  writeFileSync(specPath, JSON.stringify(result.report, null, 2));
  writeFileSync(ledgerPath, JSON.stringify(result.degradationLedger, null, 2));
  console.log('Converted Crystal IR →', JSON.stringify(result.stats));
  console.log(`Report spec: ${specPath}`);
  console.log(`Degradation ledger: ${ledgerPath}`);
  for (const warning of result.warnings) console.log('  ⚠', warning);

  const verified = await verifyReport(result.report);
  console.log('Sigma verify:', JSON.stringify(verified));
  if (!has('--create')) {
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

main().catch(error => {
  console.error('migrate-crystal failed:', error.message);
  process.exit(1);
});

