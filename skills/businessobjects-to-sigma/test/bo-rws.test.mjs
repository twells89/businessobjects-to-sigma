import { collectionItems, reportElementTree, nextPagePath, collectPaginated, cmsQuery, redact, redactSecrets, resetSessionForTests } from '../scripts/bo-rws.mjs';

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

check(redact({ password: 's3cret', name: 'Sales' }).password === '<REDACTED>' && redact({ password: 's3cret', name: 'Sales' }).name === 'Sales', 'credential keys are redacted');
check(redactSecrets('logon password=s3cret rejected') === 'logon password=<REDACTED> rejected', 'error text redacts secret values');

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

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

resetSessionForTests('stale');
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init.method, hasSignal: Boolean(init.signal), token: init.headers['X-SAP-LogonToken'] || null });
  if (calls.length === 1) return jsonResponse({ error: 'expired' }, 401);
  if (String(url).endsWith('/logon/long')) return jsonResponse({ logonToken: 'fresh' }, 200, { 'x-sap-logontoken': 'fresh' });
  return jsonResponse({ entries: { entry: [{ SI_ID: 7, SI_NAME: 'Doc', SI_KIND: 'Webi' }] } });
};
const cmsRows = await cmsQuery("SELECT SI_ID FROM CI_INFOOBJECTS");
check(cmsRows[0].SI_ID === 7, 'CMS query returns entries');
check(calls[0].method === 'POST' && calls[0].hasSignal && calls[0].token === 'stale', 'CMS query uses POST, timeout, and the logon token');
check(calls.some(call => call.url.endsWith('/logon/long')), '401 re-authenticates');
check(calls.at(-1).token === 'fresh', 'the retried CMS query uses the new token');

resetSessionForTests('ok');
let attempts = 0;
globalThis.fetch = async (_url, init) => {
  attempts++;
  check(Boolean(init.signal), 'retried CMS query keeps a timeout');
  if (attempts === 1) return jsonResponse({ error: 'busy' }, 500);
  return jsonResponse({ entries: [{ SI_ID: 1 }] });
};
const retried = await cmsQuery('SELECT SI_ID FROM CI_INFOOBJECTS');
check(retried.length === 1 && attempts === 2, 'CMS query retries a 500 once');

resetSessionForTests('ok');
let originCalls = 0;
globalThis.fetch = async () => {
  originCalls++;
  return jsonResponse({ entries: [], next: 'https://evil.example/page' });
};
let refused = false;
try { await cmsQuery('SELECT SI_ID FROM CI_INFOOBJECTS'); } catch (error) { refused = /different origin/.test(error.message); }
check(refused && originCalls === 1, 'CMS pagination refuses a different origin');

globalThis.fetch = originalFetch;
if (saved.base == null) delete process.env.BO_BASE_URL; else process.env.BO_BASE_URL = saved.base;
if (saved.user == null) delete process.env.BO_USER; else process.env.BO_USER = saved.user;
if (saved.password == null) delete process.env.BO_PASSWORD; else process.env.BO_PASSWORD = saved.password;
if (saved.token == null) delete process.env.BO_LOGON_TOKEN; else process.env.BO_LOGON_TOKEN = saved.token;
resetSessionForTests(process.env.BO_LOGON_TOKEN || '');

console.log(failures ? `\n${failures} RWS check(s) failed` : '\nAll RWS checks passed');
process.exit(failures ? 1 : 0);
