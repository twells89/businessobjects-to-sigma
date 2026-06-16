#!/usr/bin/env node
/**
 * Migrate one BusinessObjects universe → a Sigma data model.
 *
 * Usage:  node scripts/migrate-universe.mjs <universeId> [--remap <remap.json>]
 *
 * Fetches the universe via RWS, converts it, POSTs the data model to Sigma,
 * then records the binding (dataModelId + View element id + measureMap) in
 * .bo-state.json so migrate-webi.mjs can bind reports to it.
 *
 * --remap <file.json>  When the warehouse was restructured vs. the universe
 *   (renamed / consolidated tables — e.g. a platinum layer), pass a JSON file
 *   { "tableMap": { "OLD_TABLE": "NEW_TABLE" | {table,database,schema}, ... },
 *     "columnMap": { "OLD_TABLE.OLD_COL": "NEW_COL", "*.OLD_COL": "NEW_COL" } }
 *   to repoint the output at the new physical names. Re-running is cheap —
 *   review the "Remap … matched no universe table/column" warnings for typos.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { logon, getUniverse } from './bo-rws.mjs';
import { postDataModel, getDataModelSpec } from './sigma.mjs';
import { convertBobjToSigma } from '../converters/bobj.mjs';

const STATE = '.bo-state.json';

async function main() {
  const args = process.argv.slice(2);
  const universeId = args[0];
  if (!universeId) { console.error('Usage: node scripts/migrate-universe.mjs <universeId> [--remap <remap.json>]'); process.exit(1); }

  // Optional target-layer remap (restructured / platinum layer).
  let tableMap, columnMap;
  const remapIdx = args.indexOf('--remap');
  const remapFile = remapIdx >= 0 ? args[remapIdx + 1] : process.env.BO_REMAP_FILE;
  if (remapFile) {
    const remap = JSON.parse(readFileSync(remapFile, 'utf8'));
    tableMap = remap.tableMap;
    columnMap = remap.columnMap;
    console.log(`Applying target-layer remap from ${remapFile} (${Object.keys(tableMap || {}).length} table(s), ${Object.keys(columnMap || {}).length} column(s)).`);
  }

  await logon();
  const universe = await getUniverse(universeId);

  const result = convertBobjToSigma(universe, {
    connectionId: process.env.SIGMA_CONNECTION_ID,
    database: process.env.SIGMA_DATABASE,
    schema: process.env.SIGMA_SCHEMA,
    tableMap,
    columnMap,
  });
  console.log('Converted universe →', JSON.stringify(result.stats));
  result.warnings.forEach(w => console.log('  ⚠', w));

  const dataModelId = await postDataModel(result.model);
  console.log('Data model created:', dataModelId);

  // Read the spec back for the server-assigned "… View" element id (the single
  // bindable element for a workbook) and build the measureMap from the metrics.
  const spec = await getDataModelSpec(dataModelId);
  const elements = (spec.pages || spec.spec?.pages || [])[0]?.elements || spec.elements || [];
  const view = elements.find(e => /View$/.test(e.name || ''));
  const measureMap = {};
  for (const e of result.model.pages[0].elements) for (const m of (e.metrics || [])) measureMap[m.name] = m.formula;

  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  state[universeId] = {
    dataModelId,
    viewElementId: view?.id || null,
    sourceName: view?.name || null,
    measureMap,
    universeName: universe.universe?.name || universe.name,
  };
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`Recorded binding in ${STATE} (View element: ${view?.name || '—'} ${view?.id || ''}).`);
  console.log(`Next: node scripts/migrate-webi.mjs <docId> --universe ${universeId}`);
}

main().catch(e => { console.error('migrate-universe failed:', e.message); process.exit(1); });
