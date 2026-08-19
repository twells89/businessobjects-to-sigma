#!/usr/bin/env node
/**
 * Inventory a BusinessObjects repository: universes, Web Intelligence
 * documents, and Crystal Report definitions the logon user can see.
 *
 * Usage:  node scripts/discover.mjs
 * Requires .bo_env (BO_BASE_URL / BO_USER / BO_PASSWORD / BO_AUTH).
 */
import { writeFileSync } from 'node:fs';
import {
  logon,
  listUniversesDetailed,
  listWebiDocumentsDetailed,
  listCrystalReports,
  cmsQuery,
  BO_BASE,
} from './bo-rws.mjs';

const name = o => o.name || o.cuid || o.id;

async function main() {
  await logon();
  console.log('Connected to BusinessObjects. Enumerating repository…\n');

  // Prefer the typed SL/Raylight lists; fall back to a CMS query if either is empty.
  let universes = [];
  let universePages = 0;
  try { const result = await listUniversesDetailed(); universes = result.items; universePages = result.pages; } catch (e) { console.warn('universe list:', e.message); }
  let webi = [];
  let webiPages = 0;
  try { const result = await listWebiDocumentsDetailed(); webi = result.items; webiPages = result.pages; } catch (e) { console.warn('webi list:', e.message); }
  let crystal = [];
  try { crystal = await listCrystalReports(); } catch (e) { console.warn('Crystal report list:', e.message); }

  if (!universes.length || !webi.length) {
    try {
      const rows = await cmsQuery("SELECT SI_ID, SI_NAME, SI_KIND FROM CI_APPOBJECTS WHERE SI_KIND IN ('Universe','DSL.Universe','Webi')");
      if (!universes.length) universes = rows.filter(r => /universe/i.test(r.SI_KIND || r.kind || '')).map(r => ({ id: r.SI_ID || r.id, name: r.SI_NAME || r.name }));
      if (!webi.length) webi = rows.filter(r => /webi/i.test(r.SI_KIND || r.kind || '')).map(r => ({ id: r.SI_ID || r.id, name: r.SI_NAME || r.name }));
    } catch (e) { console.warn('cmsquery fallback:', e.message); }
  }

  console.log(`Universes (${universes.length}) → data models:`);
  for (const u of universes) console.log(`  [${u.id}] ${name(u)}`);
  console.log(`\nWeb Intelligence documents (${webi.length}) → workbooks:`);
  for (const d of webi) console.log(`  [${d.id}] ${name(d)}`);
  console.log(`\nCrystal Report definitions (${crystal.length}) → Sigma reports:`);
  for (const report of crystal) console.log(`  [${report.id}] ${name(report)}${report.cuid ? ` (${report.cuid})` : ''}`);

  const inventory = {
    generatedAt: new Date().toISOString(),
    source: { baseUrl: BO_BASE },
    pagination: { universePages, webiPages },
    universes: universes.map(u => ({ id: u.id, name: name(u) })),
    webiDocuments: webi.map(d => ({ id: d.id, name: name(d) })),
    crystalReports: crystal.map(report => ({
      id: report.id,
      cuid: report.cuid,
      name: name(report),
      parentId: report.parentId,
      instance: report.instance,
      sourceType: 'cms-ras',
    })),
  };
  writeFileSync('inventory.json', JSON.stringify(inventory, null, 2));
  console.log('\nWrote inventory.json');
  console.log('Next: migrate a universe + Webi document, or extract a Crystal id with scripts/extract-crystal-cms.groovy.');
}

main().catch(e => { console.error('discover failed:', e.message); process.exit(1); });
