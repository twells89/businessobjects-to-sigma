#!/usr/bin/env node
import { logon, getWebiDocument, BO_BASE } from './bo-rws.mjs';
import { writeConversionArtifacts } from './artifacts.mjs';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
}

function redact(value, key = '') {
  if (/password|secret|credential|token|authorization/i.test(key)) return '<REDACTED>';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  return value;
}

async function main() {
  const documentId = process.argv[2];
  if (!documentId || documentId.startsWith('--')) {
    console.error('Usage: node scripts/capture-webi.mjs <docId> [--out <directory>]');
    process.exit(1);
  }
  await logon();
  const captured = await getWebiDocument(documentId);
  const host = new URL(BO_BASE).host.replace(/[^a-z0-9.-]+/gi, '-');
  const outputDir = arg('--out') || `snapshots/${host}/webi-${documentId}`;
  writeConversionArtifacts(outputDir, {
    manifest: {
      capturedAt: new Date().toISOString(),
      sourceBaseUrl: BO_BASE,
      documentId,
      reports: captured.document.reports.length,
      variables: captured.document.variables.length,
      filters: captured.document.filters.length,
      dataProviders: captured.dataproviders.length,
      warnings: captured.warnings,
    },
    snapshot: redact(captured.snapshot),
    normalized: redact({ document: captured.document, dataproviders: captured.dataproviders, warnings: captured.warnings }),
  });
  console.log(`Captured Webi ${documentId} to ${outputDir}`);
  captured.warnings.forEach(warning => console.log('  WARN', warning));
}

main().catch(error => { console.error('capture-webi failed:', error.message); process.exit(1); });
