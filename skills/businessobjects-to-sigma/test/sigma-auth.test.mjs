import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSigmaAuthManager,
  TOKEN_REFRESH_AGE_MS,
} from '../scripts/sigma-auth.mjs';

const BASE = 'https://api.sigmacomputing.com';
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(HERE, '../scripts');

function workdir() {
  return mkdtempSync(join(tmpdir(), 'bo-sigma-auth-'));
}

test('valid environment bearer with unknown age is reused', async () => {
  const env = { SIGMA_BASE_URL: BASE, SIGMA_API_TOKEN: 'caller-token' };
  let providers = 0;
  const manager = createSigmaAuthManager({
    env,
    workdir: workdir(),
    provider: () => { providers++; throw new Error('provider must not run'); },
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.get('Authorization'), 'Bearer caller-token');
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal((await manager.fetch('/v2/whoami')).status, 200);
  assert.equal(providers, 0);
});

test('fresh auth.json bearer is reused without provider invocation', () => {
  const directory = workdir();
  writeFileSync(join(directory, 'auth.json'), JSON.stringify({
    SIGMA_BASE_URL: BASE,
    SIGMA_API_TOKEN: 'file-token',
    SIGMA_TOKEN_MINTED_AT: '2026-10-05T20:00:00Z',
    SIGMA_AUTH_METHOD: 'browser',
  }));
  const manager = createSigmaAuthManager({
    env: {},
    workdir: directory,
    now: () => Date.parse('2026-10-05T20:20:00Z'),
    provider: () => assert.fail('provider must not run for fresh auth.json'),
  });

  assert.equal(manager.current().token, 'file-token');
  assert.equal(manager.current().authMethod, 'browser');
});

test('browser-only mode refreshes without client credentials', () => {
  const env = { SIGMA_BASE_URL: BASE, SIGMA_AUTH_MODE: 'browser' };
  let providers = 0;
  const manager = createSigmaAuthManager({
    env,
    workdir: workdir(),
    now: () => Date.parse('2026-10-05T20:10:00Z'),
    provider: ({ env: providerEnv, forceRefresh }) => {
      providers++;
      assert.equal(providerEnv.SIGMA_AUTH_MODE, 'browser');
      assert.equal(providerEnv.SIGMA_CLIENT_ID, undefined);
      assert.equal(forceRefresh, false);
      return {
        base: BASE,
        token: 'browser-token',
        mintedAt: '2026-10-05T20:00:00Z',
        authMethod: 'browser',
      };
    },
  });

  assert.equal(manager.current().token, 'browser-token');
  assert.equal(manager.current().authMethod, 'browser');
  assert.equal(providers, 1);
});

test('auto mode accepts canonical provider client-credentials fallback', () => {
  const env = {
    SIGMA_BASE_URL: BASE,
    SIGMA_AUTH_MODE: 'auto',
    SIGMA_CLIENT_ID: 'client-id',
    SIGMA_CLIENT_SECRET: 'client-secret',
  };
  const manager = createSigmaAuthManager({
    env,
    workdir: workdir(),
    provider: ({ env: providerEnv }) => {
      assert.equal(providerEnv.SIGMA_AUTH_MODE, 'auto');
      assert.equal(providerEnv.SIGMA_CLIENT_ID, 'client-id');
      return {
        base: BASE,
        token: 'client-token',
        mintedAt: '2026-10-05T20:00:00Z',
        authMethod: 'client-credentials',
      };
    },
  });

  assert.equal(manager.current().token, 'client-token');
  assert.equal(manager.current().authMethod, 'client-credentials');
});

test('known token age refreshes at 50 minutes', () => {
  const mintedAt = '2026-10-05T20:00:00Z';
  const env = {
    SIGMA_BASE_URL: BASE,
    SIGMA_API_TOKEN: 'stale-token',
    SIGMA_TOKEN_MINTED_AT: mintedAt,
  };
  let providers = 0;
  const manager = createSigmaAuthManager({
    env,
    workdir: workdir(),
    now: () => Date.parse(mintedAt) + TOKEN_REFRESH_AGE_MS,
    provider: ({ forceRefresh }) => {
      providers++;
      assert.equal(forceRefresh, true);
      return {
        base: BASE,
        token: 'fresh-token',
        mintedAt: '2026-10-05T20:50:00Z',
        authMethod: 'browser',
      };
    },
  });

  assert.equal(manager.current().token, 'fresh-token');
  assert.equal(providers, 1);
});

test('401 refreshes and retries exactly once', async () => {
  const env = { SIGMA_BASE_URL: BASE, SIGMA_API_TOKEN: 'old-token' };
  const authorizations = [];
  let refreshes = 0;
  let requests = 0;
  const manager = createSigmaAuthManager({
    env,
    workdir: workdir(),
    provider: ({ forceRefresh }) => {
      refreshes++;
      assert.equal(forceRefresh, true);
      return {
        base: BASE,
        token: 'fresh-token',
        mintedAt: '2026-10-05T20:00:00Z',
        authMethod: 'browser',
      };
    },
    fetchImpl: async (_url, init) => {
      requests++;
      authorizations.push(init.headers.get('Authorization'));
      return new Response('unauthorized', { status: 401 });
    },
  });

  const response = await manager.fetch('/v2/files');
  assert.equal(response.status, 401);
  assert.equal(refreshes, 1);
  assert.equal(requests, 2);
  assert.deepEqual(authorizations, ['Bearer old-token', 'Bearer fresh-token']);
});

test('unsafe Sigma host is rejected before provider or fetch', async () => {
  let providers = 0;
  let requests = 0;
  const manager = createSigmaAuthManager({
    env: {
      SIGMA_BASE_URL: 'https://api.sigmacomputing.com.evil.example',
      SIGMA_API_TOKEN: 'caller-token',
    },
    workdir: workdir(),
    provider: () => { providers++; return {}; },
    fetchImpl: async () => { requests++; return new Response('{}'); },
  });

  await assert.rejects(manager.fetch('/v2/whoami'), /not a sigmacomputing\.com host/);
  assert.equal(providers, 0);
  assert.equal(requests, 0);
});

test('vendored browser OAuth runtime matches its recorded canonical digests', () => {
  const expected = {
    'get_token.py': 'f09beab38f8a4bf30e5312d492953c580b73c48582ced674d654240cf0796278',
    'get-token.sh': '9d951f86806d4f835cc8ba45766d7f715f5062bf31981816c252b328122bc76b',
    'browser-login.sh': '64f3d5248e32a59f89765f9e106e238574cd45dbc2460dc6f84a676aab9f8a7e',
    'refresh-token.sh': 'acce747146e6c8eadff609e062811801c0f75eb5211003a6d3ae9f88a353fe46',
    'lib/browser-login-platform.sh': 'dae84d7c1d1af9433f4ae81882952c0e0b8240f467b5620ad9af9115e85303e7',
  };
  for (const [relative, digest] of Object.entries(expected)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(SCRIPTS, relative)))
      .digest('hex');
    assert.equal(actual, digest, `${relative} drifted from the canonical provider runtime`);
  }
});
