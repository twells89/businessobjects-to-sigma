#!/usr/bin/env node
/**
 * Migrate one Web Intelligence document → a Sigma workbook, bound to the data
 * model produced from its universe.
 *
 * Usage:  node scripts/migrate-webi.mjs <docId> --universe <universeId>
 *
 * Reads the universe binding (dataModelId + View element + measureMap) from
 * .bo-state.json (written by migrate-universe.mjs), fetches the Webi document
 * via RWS, converts it, and POSTs the workbook.
 */
import { readFileSync, existsSync } from 'node:fs';
import { logon, getWebiDocument, BO_BASE } from './bo-rws.mjs';
import { postWorkbook, referenceWorkbookSchemaVersion, getDataModelSpec, postDataModelSpec } from './sigma.mjs';
import { convertWebiToWorkbook } from '../converters/webi.mjs';
import { mergeAdditionsIntoView } from './dm-merge.mjs';
import { webiPreflight, assertPublishable, applyWarningPolicy } from './preflight.mjs';
import { writeConversionArtifacts } from './artifacts.mjs';

const STATE = '.bo-state.json';

function arg(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const localFile = arg('--file');
  const docId = localFile ? null : process.argv[2];
  const sourceLabel = localFile || docId;
  const universeId = arg('--universe');
  const dryRun = process.argv.includes('--dry-run');
  const failOnWarning = process.argv.includes('--fail-on-warning');
  const requestedOutput = arg('--out');
  if (!sourceLabel || !universeId) {
    console.error('Usage: node scripts/migrate-webi.mjs <docId> --universe <universeId> [--dry-run] [--out <dir>]');
    console.error('   or: node scripts/migrate-webi.mjs --file <normalized.json> --universe <universeId> --dry-run');
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
  if (!dryRun && !binding.dataModelId) { console.error(`No binding for universe ${universeId} in ${STATE}`); process.exit(1); }

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

  const schemaVersion = dryRun
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
  const artifactDir = requestedOutput || (dryRun ? `artifacts/webi-${String(sourceLabel).replace(/[^a-z0-9_.-]+/gi, '-')}` : null);
  if (artifactDir) {
    writeConversionArtifacts(artifactDir, {
      source: captured.snapshot,
      normalized: { document, dataproviders: captured.dataproviders, warnings: captured.warnings },
      conversion: result,
      preflight,
    });
    console.log('Wrote conversion artifacts:', artifactDir);
  }
  if (dryRun) {
    console.log('Dry run complete; no data model or workbook was changed in Sigma.');
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

  const workbookId = await postWorkbook(result.workbook);
  console.log('Workbook created:', workbookId);
  console.log(`Open: ${process.env.SIGMA_BASE_URL || 'https://app.sigmacomputing.com'} → workbook ${workbookId}`);
}

main().catch(e => { console.error('migrate-webi failed:', e.message); process.exit(1); });
