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
import { logon, getWebiDocument } from './bo-rws.mjs';
import { postWorkbook, referenceWorkbookSchemaVersion } from './sigma.mjs';
import { convertWebiToWorkbook } from '../converters/webi.mjs';

const STATE = '.bo-state.json';

function arg(flag) { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : undefined; }

async function main() {
  const docId = process.argv[2];
  const universeId = arg('--universe');
  if (!docId || !universeId) { console.error('Usage: node scripts/migrate-webi.mjs <docId> --universe <universeId>'); process.exit(1); }
  if (!existsSync(STATE)) { console.error(`${STATE} not found — run migrate-universe.mjs ${universeId} first`); process.exit(1); }

  const binding = JSON.parse(readFileSync(STATE, 'utf8'))[universeId];
  if (!binding?.dataModelId) { console.error(`No binding for universe ${universeId} in ${STATE}`); process.exit(1); }

  await logon();
  const { document } = await getWebiDocument(docId);

  const schemaVersion = await referenceWorkbookSchemaVersion();
  const result = convertWebiToWorkbook({ document }, {
    folderId: process.env.SIGMA_FOLDER_ID,
    dataModelId: binding.dataModelId,
    dataModelElementId: binding.viewElementId,
    sourceName: binding.sourceName,
    measureMap: binding.measureMap || {},
    schemaVersion,
    workbookName: document.name,
  });
  console.log('Converted document →', JSON.stringify(result.stats));
  result.warnings.forEach(w => console.log('  ⚠', w));

  const workbookId = await postWorkbook(result.workbook);
  console.log('Workbook created:', workbookId);
  console.log(`Open: ${process.env.SIGMA_BASE_URL || 'https://app.sigmacomputing.com'} → workbook ${workbookId}`);
}

main().catch(e => { console.error('migrate-webi failed:', e.message); process.exit(1); });
