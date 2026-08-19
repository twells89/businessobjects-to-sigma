#!/usr/bin/env node
/**
 * Full public-sample gate:
 *   pinned .rpt → rpt-rs extraction → Crystal IR → Snowflake seed
 *   → Sigma report verify/create/readback/query/PDF.
 *
 * Persistent report creation has no API cleanup. Set CRYSTAL_E2E_CREATE=true
 * only for an approved target folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { convertCrystalToReport } from '../converters/crystal.mjs';
import { normalizeReportForComparison, validateReportSpec } from './report-code-rep.mjs';
import {
  assertReportReadback,
  exportReportPdf,
  getReportInventory,
  postReport,
  queryReportElement,
  referenceReportSchemaVersion,
  verifyReport,
} from './sigma-report.mjs';
import { syncConnectionPath } from './sigma.mjs';

const manifest = JSON.parse(
  readFileSync('fixtures/crystal/meridian-customer-statement.source.json', 'utf8'),
);
const artifacts = resolve(process.env.CRYSTAL_ARTIFACTS_DIR || 'artifacts/crystal/e2e');
mkdirSync(artifacts, { recursive: true });
const rptPath = resolve(artifacts, '01_customer_statement.rpt');
const irPath = resolve(artifacts, '01_customer_statement.crystal-ir.json');
const specPath = resolve(artifacts, '01_customer_statement.sigma-report.json');
const ledgerPath = resolve(artifacts, '01_customer_statement.degradations.json');

function required(name) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
  return process.env[name];
}

async function download(url, path) {
  if (existsSync(path)) return;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download ${url} → HTTP ${response.status}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

function gitBlobSha(path) {
  const bytes = readFileSync(path);
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest('hex');
}

function run(command, args, extra = {}) {
  const result = spawnSync(command, args, {
    cwd: resolve('.'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...extra,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(0, 2000)}`);
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
}

function scanErrors(value, path = '$', out = []) {
  if (Array.isArray(value)) value.forEach((item, index) => scanErrors(item, `${path}[${index}]`, out));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/error/i.test(key) && child) out.push(`${path}.${key}: ${JSON.stringify(child).slice(0, 300)}`);
      scanErrors(child, `${path}.${key}`, out);
    }
  } else if (typeof value === 'string' && /dependency not found|invalid formula|error-typed/i.test(value)) {
    out.push(`${path}: ${value.slice(0, 300)}`);
  }
  return out;
}

async function main() {
  const connectionId = required('SIGMA_CONNECTION_ID');
  const folderId = required('SIGMA_FOLDER_ID');
  const rptBin = required('RPT_RS_BIN');
  const database = process.env.CRYSTAL_SNOWFLAKE_DATABASE || 'CRYSTAL_MIGRATION_DEMO';
  const schema = process.env.CRYSTAL_SNOWFLAKE_SCHEMA || 'PUBLIC';

  await download(manifest.report.url, rptPath);
  const actualSha = gitBlobSha(rptPath);
  if (actualSha !== manifest.report.sha) {
    throw new Error(`Pinned report blob mismatch: expected ${manifest.report.sha}, got ${actualSha}`);
  }
  run('node', [
    'scripts/extract-crystal-rpt-rs.mjs',
    rptPath,
    '--rpt-bin',
    rptBin,
    '--out',
    irPath,
  ]);
  const ir = JSON.parse(readFileSync(irPath, 'utf8'));
  for (const [key, expected] of Object.entries(manifest.expectedCensus)) {
    if (key === 'sectionKinds') continue;
    const actual = {
      tables: ir.data.tables.length,
      links: ir.data.links.length,
      parameters: ir.data.parameters.length,
      groups: ir.data.groups.length,
      formulas: ir.data.formulas.length,
      pictures: ir.sections.flatMap(section => section.objects).filter(object => object.kind === 'picture').length,
      subreports: ir.subreports.length,
    }[key];
    if (actual !== expected) throw new Error(`Extraction census ${key}: expected ${expected}, got ${actual}`);
  }

  run('python3', [
    'scripts/seed-crystal-snowflake.py',
    '--database',
    database,
    '--schema',
    schema,
  ], { env: process.env });
  for (const path of [
    [],
    [database],
    [database, schema],
    [database, schema, 'CUSTOMER_STATEMENT_ROWS'],
  ]) {
    await syncConnectionPath(connectionId, path);
  }
  console.log(`Synced Sigma source metadata: ${database}.${schema}.CUSTOMER_STATEMENT_ROWS`);

  const schemaVersion = await referenceReportSchemaVersion();
  const converted = convertCrystalToReport(ir, {
    folderId,
    connectionId,
    database,
    schema,
    schemaVersion,
    reportName: `Meridian Customer Statement — Crystal E2E ${new Date().toISOString().slice(0, 16)}`,
  });
  const offline = validateReportSpec(converted.report);
  if (!offline.valid) throw new Error(`Offline report validation: ${offline.errors.join('; ')}`);
  writeFileSync(specPath, JSON.stringify(converted.report, null, 2));
  writeFileSync(ledgerPath, JSON.stringify(converted.degradationLedger, null, 2));

  const verified = await verifyReport(converted.report);
  if (verified?.valid === false) throw new Error(`Sigma verify failed: ${JSON.stringify(verified)}`);
  console.log('Sigma report verify:', JSON.stringify(verified));
  if (process.env.CRYSTAL_E2E_CREATE !== 'true') {
    console.log(`Verified without persistence. Spec: ${specPath}`);
    console.log('Set CRYSTAL_E2E_CREATE=true for the approved persistent create/query/PDF gate.');
    return;
  }

  const resumeReportId = process.env.CRYSTAL_E2E_REPORT_ID;
  const created = resumeReportId
    ? { reportId: resumeReportId, result: { reportId: resumeReportId }, body: converted.report }
    : await postReport(converted.report, { verify: false });
  if (resumeReportId) console.log(`Resuming persistent gate for report ${resumeReportId}`);
  if (!created.reportId) throw new Error(`Create returned no reportId: ${JSON.stringify(created.result)}`);
  const readback = await assertReportReadback(
    created.reportId,
    created.body,
    normalizeReportForComparison,
  );
  writeFileSync(
    resolve(artifacts, `${created.reportId}.readback.json`),
    JSON.stringify(readback, null, 2),
  );
  const inventory = await getReportInventory(created.reportId);
  writeFileSync(
    resolve(artifacts, `${created.reportId}.inventory.json`),
    JSON.stringify(inventory, null, 2),
  );

  const [detail, total] = await Promise.all([
    queryReportElement(created.reportId, 'statement-detail'),
    queryReportElement(created.reportId, 'statement-total'),
  ]);
  const queryProblems = [...scanErrors(detail), ...scanErrors(total)];
  if (queryProblems.length) {
    throw new Error(`Report element query problems: ${queryProblems.join('; ')}`);
  }
  writeFileSync(
    resolve(artifacts, `${created.reportId}.queries.json`),
    JSON.stringify({ detail, total }, null, 2),
  );

  const pdfPath = resolve(artifacts, `${created.reportId}.pdf`);
  const exported = await exportReportPdf(created.reportId, pdfPath, { layout: 'portrait' });
  const summary = {
    reportId: created.reportId,
    reportUrl: created.result.url || null,
    extraction: converted.stats,
    verified,
    inventoryCounts: {
      pages: inventory.pages?.entries?.length ?? inventory.pages?.length,
      elements: inventory.elements?.entries?.length ?? inventory.elements?.length,
      controls: inventory.controls?.entries?.length ?? inventory.controls?.length,
    },
    pdf: exported,
    artifacts,
  };
  writeFileSync(resolve(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error('e2e-crystal-report failed:', error.message);
  process.exit(1);
});

