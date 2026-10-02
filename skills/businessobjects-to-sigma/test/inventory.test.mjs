import { mergeByKind, normalizeCmsRow, selectFolderScope, folderPath, discoverRepository } from '../scripts/inventory.mjs';
import { snapshotState } from '../scripts/capture-webi.mjs';
import { resetSessionForTests } from '../scripts/bo-rws.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failures++;
}

const row = normalizeCmsRow({
  SI_ID: 15,
  SI_CUID: 'AaBb',
  SI_NAME: 'Sales',
  SI_KIND: 'Webi',
  SI_PARENTID: 4,
  SI_OWNER: { SI_NAME: 'Casey' },
  SI_UPDATE_TS: '2026-01-02T00:00:00Z',
});
check(row.kind === 'webi' && row.owner === 'Casey' && row.cuid === 'AaBb', 'CMS rows keep owner, cuid, and content kind');

const merged = mergeByKind(
  [{ id: 15, name: 'Sales' }],
  [row, normalizeCmsRow({ SI_ID: 16, SI_NAME: 'Only CMS', SI_KIND: 'Webi' })],
  'webi',
);
check(merged.find(item => String(item.id) === '15').owner === 'Casey', 'typed rows pick up CMS owner metadata');
check(merged.some(item => item.name === 'Only CMS'), 'CMS-only documents stay in the inventory');

const scoped = selectFolderScope([
  { id: 1, name: 'Root', kind: 'folder', parentId: null },
  { id: 2, name: 'Archive', kind: 'folder', parentId: 9 },
  { id: 10, name: 'In folder', kind: 'webi', parentId: 1 },
  { id: 11, name: 'Nested', kind: 'crystal', parentId: 10 },
  { id: 12, name: 'Outside', kind: 'webi', parentId: 2 },
  { id: 20, name: 'Universe', kind: 'universe', parentId: 99 },
], 1);
check(scoped.items.some(item => item.id === 10) && !scoped.items.some(item => item.id === 12), 'folder scope keeps descendants and drops siblings');
check(scoped.unscopedUniverses && scoped.items.some(item => item.id === 20), 'universes outside the folder are retained and flagged');
const byId = new Map([['1', { id: 1, name: 'Public', parentId: null }]]);
check(folderPath({ id: 10, name: 'Sales', parentId: 1 }, byId) === 'Public/Sales', 'folder path is built from parents');

const dir = mkdtempSync(join(tmpdir(), 'bo-snapshot-'));
check(snapshotState(dir).status === 'missing', 'absent snapshot is missing');
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ warnings: ['/raylight/v1/documents/1/dataproviders: HTTP 404'] }));
writeFileSync(join(dir, 'normalized.json'), '{}');
check(snapshotState(dir).status === 'partial', 'provider capture warnings stay partial so a rerun can resume');
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ warnings: [] }));
check(snapshotState(dir).status === 'complete', 'a clean snapshot is complete');
rmSync(dir, { recursive: true, force: true });

const originalFetch = globalThis.fetch;
const saved = {
  base: process.env.BO_BASE_URL,
  user: process.env.BO_USER,
  password: process.env.BO_PASSWORD,
  token: process.env.BO_LOGON_TOKEN,
};
process.env.BO_BASE_URL = 'https://bo.example:6405/biprws';
process.env.BO_USER = 'migration';
process.env.BO_PASSWORD = 'pw';
delete process.env.BO_LOGON_TOKEN;
resetSessionForTests('');
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.endsWith('/logon/long')) {
    return new Response(JSON.stringify({ logonToken: 'fresh' }), { status: 200, headers: { 'content-type': 'application/json', 'x-sap-logontoken': 'fresh' } });
  }
  if (target.includes('/sl/v1/universes')) return new Response('forbidden', { status: 403 });
  if (target.includes('/raylight/v1/documents')) {
    return new Response(JSON.stringify({ documents: { document: [{ id: 3, name: 'Visible' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const query = JSON.parse(init.body || '{}').query || '';
  if (query.includes('CI_INFOOBJECTS')) {
    return new Response(JSON.stringify({ entries: { entry: [{ SI_ID: 9, SI_NAME: 'Statement', SI_KIND: 'CrystalReport', SI_INSTANCE: 0 }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('forbidden', { status: 403 });
};
const partial = await discoverRepository();
check(partial.webiDocuments.some(item => item.name === 'Visible'), 'partial access still inventories visible Webi documents');
check(partial.crystalReports.some(item => item.name === 'Statement'), 'partial access still inventories Crystal rows from CMS');
check(partial.completeness.universes.complete === false, 'a forbidden universe list is incomplete');
check(partial.warnings.some(warning => warning.startsWith('universes:')), 'universe access failure is recorded');
check(!JSON.stringify(partial).includes('pw'), 'inventory output does not contain the logon password');
globalThis.fetch = originalFetch;
if (saved.base == null) delete process.env.BO_BASE_URL; else process.env.BO_BASE_URL = saved.base;
if (saved.user == null) delete process.env.BO_USER; else process.env.BO_USER = saved.user;
if (saved.password == null) delete process.env.BO_PASSWORD; else process.env.BO_PASSWORD = saved.password;
if (saved.token == null) delete process.env.BO_LOGON_TOKEN; else process.env.BO_LOGON_TOKEN = saved.token;
resetSessionForTests(process.env.BO_LOGON_TOKEN || '');

console.log(failures ? `\n${failures} inventory check(s) failed` : '\nAll inventory checks passed');
process.exit(failures ? 1 : 0);
