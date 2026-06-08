#!/usr/bin/env node
/**
 * Inventory a BusinessObjects repository: every universe and Web Intelligence
 * document the logon user can see, written to inventory.json + printed.
 *
 * Usage:  node scripts/discover.mjs
 * Requires .bo_env (BO_BASE_URL / BO_USER / BO_PASSWORD / BO_AUTH).
 */
import { writeFileSync } from 'node:fs';
import { logon, listUniverses, listWebiDocuments, cmsQuery } from './bo-rws.mjs';

const name = o => o.name || o.cuid || o.id;

async function main() {
  await logon();
  console.log('Connected to BusinessObjects. Enumerating repository…\n');

  // Prefer the typed SL/Raylight lists; fall back to a CMS query if either is empty.
  let universes = [];
  try { universes = await listUniverses(); } catch (e) { console.warn('universe list:', e.message); }
  let webi = [];
  try { webi = await listWebiDocuments(); } catch (e) { console.warn('webi list:', e.message); }

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

  const inventory = {
    generatedAt: new Date().toISOString(),
    universes: universes.map(u => ({ id: u.id, name: name(u) })),
    webiDocuments: webi.map(d => ({ id: d.id, name: name(d) })),
  };
  writeFileSync('inventory.json', JSON.stringify(inventory, null, 2));
  console.log('\nWrote inventory.json');
  console.log('Next: node scripts/migrate-universe.mjs <universeId>  then  node scripts/migrate-webi.mjs <docId> --universe <universeId>');
}

main().catch(e => { console.error('discover failed:', e.message); process.exit(1); });
