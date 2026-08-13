import { collectionItems, reportElementTree, nextPagePath, collectPaginated } from '../scripts/bo-rws.mjs';

let failures = 0;
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failures++;
}

check(collectionItems({ reports: { report: [{ id: 1 }] } }, 'reports', 'report').length === 1, 'nested collection wrapper');
check(collectionItems({ reports: [{ id: 1 }] }, 'reports', 'report').length === 1, 'array under plural wrapper');
check(collectionItems({ report: { id: 1 } }, 'reports', 'report').length === 1, 'single object under singular key');
check(collectionItems([{ id: 1 }], 'reports', 'report').length === 1, 'bare array collection');
check(collectionItems({ reports: { items: [{ id: 1 }] } }, 'reports', 'report').length === 1, 'items collection wrapper');
check(reportElementTree({ reportElements: { reportElement: [{ id: 'e1' }] } })[0].id === 'e1', 'nested report-element wrapper');
check(reportElementTree({ elements: { element: { id: 'e1' } } })[0].id === 'e1', 'single nested element wrapper');
check(nextPagePath({ links: { link: [{ rel: 'next', href: '/page/2' }] } }) === '/page/2', 'next link wrapper');
check(nextPagePath({ pagination: { next: '/page/2' } }) === '/page/2', 'pagination.next');
check(nextPagePath({ reports: { links: [{ rel: 'next', href: '/page/2' }] } }) === '/page/2', 'nested collection next link');

const pages = new Map([
  ['/page/1', { total: 3, reports: { report: [{ id: 1 }, { id: 2 }] }, links: { link: [{ rel: 'next', href: '/page/2' }] } }],
  ['/page/2', { total: 3, reports: { report: [{ id: 3 }] } }],
]);
const result = await collectPaginated('/page/1', async path => pages.get(path), payload => collectionItems(payload, 'reports', 'report'));
check(result.items.map(item => item.id).join(',') === '1,2,3', 'pagination collects every page');
check(result.pages === 2, 'pagination reports page count');
check(result.complete, 'advertised total verifies completeness');

const incomplete = await collectPaginated('/one', async () => ({ total: 2, reports: [{ id: 1 }] }), payload => collectionItems(payload, 'reports', 'report'));
check(!incomplete.complete, 'missing next link is detected when advertised total is larger');

let looped = false;
try {
  await collectPaginated('/loop', async () => ({ reports: [], next: '/loop' }), payload => collectionItems(payload, 'reports', 'report'));
} catch { looped = true; }
check(looped, 'pagination loop is rejected');

console.log(failures ? `\n${failures} RWS check(s) failed` : '\nAll RWS checks passed');
process.exit(failures ? 1 : 0);
