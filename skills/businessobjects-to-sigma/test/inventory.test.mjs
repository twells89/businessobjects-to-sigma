import { mergeByKind, normalizeCmsRow, selectFolderScope, folderPath } from '../scripts/inventory.mjs';
import { snapshotState } from '../scripts/capture-webi.mjs';
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

console.log(failures ? `\n${failures} inventory check(s) failed` : '\nAll inventory checks passed');
process.exit(failures ? 1 : 0);
