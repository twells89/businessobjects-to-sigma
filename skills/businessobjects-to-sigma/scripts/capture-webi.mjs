#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logon, getWebiDocument, boBaseUrl, redact } from './bo-rws.mjs';
import { writeConversionArtifacts } from './artifacts.mjs';
import { isDirectRun } from './cli-args.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
}

export function snapshotState(directory) {
  const manifestPath = join(directory, 'manifest.json');
  const normalizedPath = join(directory, 'normalized.json');
  if (!existsSync(manifestPath) || !existsSync(normalizedPath)) return { status: 'missing', warnings: [] };
  let manifest = {};
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return { status: 'partial', warnings: ['manifest.json is not valid JSON'] }; }
  const warnings = Array.isArray(manifest.warnings) ? manifest.warnings : [];
  const partial = warnings.some(warning => /\/dataproviders:|\/elements:|\/reports\//.test(warning));
  return { status: partial ? 'partial' : 'complete', warnings };
}

export async function captureWebiSnapshot(documentId, outputDir) {
  await logon();
  const captured = await getWebiDocument(documentId);
  const sourceBaseUrl = boBaseUrl();
  writeConversionArtifacts(outputDir, {
    manifest: {
      capturedAt: new Date().toISOString(),
      sourceBaseUrl,
      documentId: String(documentId),
      reports: captured.document.reports.length,
      variables: captured.document.variables.length,
      filters: captured.document.filters.length,
      dataProviders: captured.dataproviders.length,
      warnings: captured.warnings,
    },
    snapshot: redact(captured.snapshot),
    normalized: redact({ document: captured.document, dataproviders: captured.dataproviders, warnings: captured.warnings }),
  });
  return { outputDir, warnings: captured.warnings, document: captured.document, dataproviders: captured.dataproviders };
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId || documentId.startsWith('--')) {
    console.error('Usage: node scripts/capture-webi.mjs <docId> [--out <directory>]');
    process.exit(1);
  }
  const host = new URL(boBaseUrl()).host.replace(/[^a-z0-9.-]+/gi, '-');
  const outputDir = arg('--out') || `snapshots/${host}/webi-${documentId}`;
  const captured = await captureWebiSnapshot(documentId, outputDir);
  console.log(`Captured Webi ${documentId} to ${outputDir}`);
  captured.warnings.forEach(warning => console.log('  WARN', warning));
}

if (isDirectRun(import.meta.url)) {
  main().catch(error => { console.error('capture-webi failed:', error.message); process.exit(1); });
}
