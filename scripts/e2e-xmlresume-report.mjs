#!/usr/bin/env node
/**
 * Pinned MIT Crystal RPT + PDF + XML → Snowflake → Sigma report → PDF.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { convertXmlResumeToReport } from '../converters/crystal-xmlresume.mjs';
import { normalizeReportForComparison, validateReportSpec } from './report-code-rep.mjs';
import {
  assertReportReadback,
  exportReportPdf,
  getReportInventory,
  postReport,
  putReportSpec,
  queryReportElement,
  referenceReportSchemaVersion,
  verifyReport,
} from './sigma-report.mjs';
import { syncConnectionPath } from './sigma.mjs';

const manifest = JSON.parse(
  readFileSync('fixtures/crystal/xmlresume-report.source.json', 'utf8'),
);
const artifacts = resolve(
  process.env.XMLRESUME_ARTIFACTS_DIR || 'artifacts/crystal/xmlresume-e2e',
);
mkdirSync(artifacts, { recursive: true });
const rptPath = resolve(artifacts, 'basic-resume-template.rpt');
const referencePdfPath = resolve(artifacts, 'basic-resume-template.crystal.pdf');
const xmlPath = resolve(artifacts, 'resume.xml');
const irPath = resolve(artifacts, 'basic-resume-template.crystal-ir.json');
const specPath = resolve(artifacts, 'basic-resume-template.sigma-report.json');
const ledgerPath = resolve(artifacts, 'basic-resume-template.degradations.json');

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

function assertBlob(path, expected, label) {
  const actual = gitBlobSha(path);
  if (actual !== expected) {
    throw new Error(`${label} blob mismatch: expected ${expected}, got ${actual}`);
  }
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
    throw new Error(
      `${command} failed (${result.status}): ${(result.stderr || result.stdout || '').slice(0, 2000)}`,
    );
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
}

function scanErrors(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanErrors(item, `${path}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/error/i.test(key) && child) {
        out.push(`${path}.${key}: ${JSON.stringify(child).slice(0, 300)}`);
      }
      scanErrors(child, `${path}.${key}`, out);
    }
  } else if (
    typeof value === 'string'
    && /dependency not found|invalid formula|error-typed/i.test(value)
  ) {
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
  const sourceTables = [
    manifest.sigma.degreesTable,
    manifest.sigma.certificationsTable,
    manifest.sigma.projectLinesTable,
  ];

  await Promise.all([
    download(manifest.report.url, rptPath),
    download(manifest.referencePdf.url, referencePdfPath),
    download(manifest.referenceXml.url, xmlPath),
  ]);
  assertBlob(rptPath, manifest.report.sha, 'Pinned RPT');
  assertBlob(referencePdfPath, manifest.referencePdf.sha, 'Pinned Crystal PDF');
  assertBlob(xmlPath, manifest.referenceXml.sha, 'Pinned résumé XML');

  run('node', [
    'scripts/extract-crystal-rpt-rs.mjs',
    rptPath,
    '--rpt-bin',
    rptBin,
    '--out',
    irPath,
  ]);
  const ir = JSON.parse(readFileSync(irPath, 'utf8'));
  const actualCensus = {
    sections: ir.sections.length,
    objects: ir.sections.reduce(
      (count, section) => count + (section.objects?.length || 0),
      0,
    ),
    tables: ir.data.tables.length,
    links: ir.data.links.length,
    fields: ir.data.fields.length,
    formulas: ir.data.formulas.length,
    parameters: ir.data.parameters.length,
    groups: ir.data.groups.length,
    pictures: ir.sections.flatMap(section => section.objects)
      .filter(object => object.kind === 'picture').length,
    subreports: ir.subreports.length,
    warnings: ir.warnings.length,
  };
  for (const [key, expected] of Object.entries(manifest.expectedCensus)) {
    if (actualCensus[key] !== expected) {
      throw new Error(
        `Extraction census ${key}: expected ${expected}, got ${actualCensus[key]}`,
      );
    }
  }

  run('python3', [
    'scripts/seed-xmlresume-snowflake.py',
    '--source',
    xmlPath,
    '--database',
    database,
    '--schema',
    schema,
  ], { env: process.env });
  for (const path of [[], [database], [database, schema]]) {
    await syncConnectionPath(connectionId, path);
  }
  for (const table of sourceTables) {
    await syncConnectionPath(connectionId, [database, schema, table]);
  }
  console.log(`Synced Sigma résumé sources: ${sourceTables.join(', ')}`);

  const schemaVersion = await referenceReportSchemaVersion();
  const converted = convertXmlResumeToReport(ir, {
    folderId,
    connectionId,
    database,
    schema,
    schemaVersion,
    reportName: `XML Résumé — Crystal E2E ${new Date().toISOString().slice(0, 16)}`,
  });
  const offline = validateReportSpec(converted.report);
  if (!offline.valid) {
    throw new Error(`Offline report validation: ${offline.errors.join('; ')}`);
  }
  writeFileSync(specPath, JSON.stringify(converted.report, null, 2));
  writeFileSync(ledgerPath, JSON.stringify(converted.degradationLedger, null, 2));

  const verified = await verifyReport(converted.report);
  if (verified?.valid === false) {
    throw new Error(`Sigma verify failed: ${JSON.stringify(verified)}`);
  }
  console.log('Sigma report verify:', JSON.stringify(verified));
  if (process.env.XMLRESUME_E2E_CREATE !== 'true') {
    console.log(`Verified without persistence. Spec: ${specPath}`);
    console.log(`Crystal oracle: ${referencePdfPath}`);
    return;
  }

  const resumeReportId = process.env.XMLRESUME_E2E_REPORT_ID;
  if (resumeReportId) {
    await putReportSpec(resumeReportId, converted.report);
    console.log(`Updated report ${resumeReportId} with the current converted document`);
  }
  const created = resumeReportId
    ? { reportId: resumeReportId, result: { reportId: resumeReportId }, body: converted.report }
    : await postReport(converted.report, { verify: false });
  if (!created.reportId) {
    throw new Error(`Create returned no reportId: ${JSON.stringify(created.result)}`);
  }
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
  const queries = {};
  for (const elementId of manifest.sigma.queryElementIds) {
    queries[elementId] = await queryReportElement(created.reportId, elementId);
  }
  const queryProblems = scanErrors(queries);
  if (queryProblems.length) {
    throw new Error(`Report element query problems: ${queryProblems.join('; ')}`);
  }
  writeFileSync(
    resolve(artifacts, `${created.reportId}.queries.json`),
    JSON.stringify(queries, null, 2),
  );

  const sigmaPdfPath = resolve(artifacts, `${created.reportId}.sigma.pdf`);
  const exported = await exportReportPdf(created.reportId, sigmaPdfPath, {
    layout: 'portrait',
  });
  const summary = {
    reportId: created.reportId,
    extraction: actualCensus,
    dataCensus: manifest.expectedDataCensus,
    converted: converted.stats,
    verified,
    inventoryCounts: {
      pages: inventory.pages?.entries?.length ?? inventory.pages?.length,
      elements: inventory.elements?.entries?.length ?? inventory.elements?.length,
      controls: inventory.controls?.entries?.length ?? inventory.controls?.length,
    },
    oracle: {
      crystalPdf: referencePdfPath,
      sigmaPdf: exported.outputPath,
      sourceXml: xmlPath,
    },
    pdf: exported,
    artifacts,
  };
  writeFileSync(resolve(artifacts, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error('e2e-xmlresume-report failed:', error.message);
  process.exit(1);
});
