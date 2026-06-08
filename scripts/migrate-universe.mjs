#!/usr/bin/env node
/**
 * Migrate one BusinessObjects universe → a Sigma data model.
 *
 * Usage:  node scripts/migrate-universe.mjs <universeId>
 *
 * Fetches the universe via RWS, converts it, POSTs the data model to Sigma,
 * then records the binding (dataModelId + View element id + measureMap) in
 * .bo-state.json so migrate-webi.mjs can bind reports to it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { logon, getUniverse } from './bo-rws.mjs';
import { postDataModel, getDataModelSpec } from './sigma.mjs';
import { convertBobjToSigma } from '../converters/bobj.mjs';

const STATE = '.bo-state.json';

async function main() {
  const universeId = process.argv[2];
  if (!universeId) { console.error('Usage: node scripts/migrate-universe.mjs <universeId>'); process.exit(1); }

  await logon();
  const universe = await getUniverse(universeId);

  const result = convertBobjToSigma(universe, {
    connectionId: process.env.SIGMA_CONNECTION_ID,
    database: process.env.SIGMA_DATABASE,
    schema: process.env.SIGMA_SCHEMA,
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
