/**
 * Shell-neutral Sigma authentication adapter.
 *
 * A valid caller bearer (environment first, then <workdir>/auth.json) is
 * reused. Tokens with known mint metadata are refreshed at 50 minutes through
 * the vendored canonical get_token.py provider, which prefers the browser
 * keychain and falls back to client credentials. Requests refresh and retry
 * exactly once after a 401.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_REFRESH_AGE_MS = 50 * 60 * 1000;
export const DEFAULT_SIGMA_BASE_URL = 'https://aws-api.sigmacomputing.com';

const BEARER_RE = /^[A-Za-z0-9._~+/=-]+$/;
const HERE = dirname(fileURLToPath(import.meta.url));

export function sigmaAuthWorkdir(env = process.env) {
  return resolve(env.SIGMA_WORKDIR || process.cwd());
}

export function readSigmaAuthFile(workdir) {
  if (!workdir) return {};
  const path = join(workdir, 'auth.json');
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return {
      base: value.SIGMA_BASE_URL || value.baseUrl || value.base_url,
      token: value.SIGMA_API_TOKEN || value.token || value.access_token,
      mintedAt: value.SIGMA_TOKEN_MINTED_AT || statSync(path).mtime.toISOString(),
      authMethod: value.SIGMA_AUTH_METHOD,
    };
  } catch {
    return {};
  }
}

export function tokenRefreshDue(mintedAt, now = Date.now()) {
  if (!mintedAt) return false;
  const minted = Date.parse(mintedAt);
  return Number.isFinite(minted) && now - minted >= TOKEN_REFRESH_AGE_MS;
}

export function validateSigmaBaseUrl(
  base,
  {
    allowInsecure = process.env.SIGMA_ALLOW_INSECURE_BASE_URL === '1',
    warn = console.warn,
  } = {},
) {
  if (allowInsecure) {
    let parsed;
    try { parsed = new URL(base); } catch {
      throw new Error(`FATAL: SIGMA_BASE_URL is invalid ('${base}') — refusing to send Sigma credentials.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`FATAL: SIGMA_BASE_URL must use http:// or https:// (got '${base}') — refusing to send Sigma credentials.`);
    }
    warn(`WARNING: SIGMA_ALLOW_INSECURE_BASE_URL=1 — skipping SIGMA_BASE_URL validation (${base})`);
    return base.replace(/\/$/, '');
  }

  let parsed;
  try { parsed = new URL(base); } catch {
    throw new Error(`FATAL: SIGMA_BASE_URL is invalid ('${base}') — refusing to send Sigma credentials.`);
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (parsed.protocol !== 'https:') {
    throw new Error(`FATAL: SIGMA_BASE_URL must use https:// (got '${base}') — refusing to send Sigma credentials.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`FATAL: SIGMA_BASE_URL must not contain user information ('${base}') — refusing to send Sigma credentials.`);
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`FATAL: SIGMA_BASE_URL must not use a non-HTTPS port ('${base}') — refusing to send Sigma credentials.`);
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`FATAL: SIGMA_BASE_URL must be an API origin without a path, query, or fragment ('${base}').`);
  }
  if (host !== 'sigmacomputing.com' && !host.endsWith('.sigmacomputing.com')) {
    throw new Error(
      `FATAL: SIGMA_BASE_URL host '${host}' is not a sigmacomputing.com host — refusing to send Sigma credentials. `
      + 'Set SIGMA_ALLOW_INSECURE_BASE_URL=1 to override (self-hosted/dev).',
    );
  }
  return `https://${host}`;
}

export function validateSigmaBearer(token) {
  if (!token || !BEARER_RE.test(token)) {
    throw new Error('Sigma access token is missing or contains unexpected characters');
  }
  return token;
}

function pythonCommands(env) {
  const commands = [];
  if (env.SIGMA_PYTHON) commands.push([env.SIGMA_PYTHON]);
  commands.push(['python3'], ['python'], ['py', '-3']);
  return commands;
}

export function runCanonicalTokenProvider({
  workdir,
  env = process.env,
  base,
  forceRefresh = false,
  providerPath = env.SIGMA_TOKEN_PROVIDER || join(HERE, 'get_token.py'),
} = {}) {
  if (!workdir) throw new Error('a workdir is required to refresh Sigma authentication');
  if (!existsSync(providerPath)) throw new Error(`Sigma get_token.py provider not found: ${providerPath}`);

  let result = null;
  for (const [command, ...prefix] of pythonCommands(env)) {
    const args = [...prefix, providerPath, '--workdir', workdir];
    if (forceRefresh) args.push('--force-refresh');
    result = spawnSync(command, args, {
      encoding: 'utf8',
      env: { ...env, SIGMA_BASE_URL: base },
    });
    if (!result.error || result.error.code !== 'ENOENT') break;
    result = null;
  }
  if (!result) throw new Error('Python 3 is unavailable; cannot refresh the Sigma token');
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`Sigma token provider failed${detail ? `: ${detail}` : ''}`);
  }

  const auth = readSigmaAuthFile(workdir);
  if (!auth.base || !auth.token || !auth.mintedAt || !auth.authMethod) {
    throw new Error('Sigma token provider wrote incomplete auth.json');
  }
  return auth;
}

export function createSigmaAuthManager({
  env = process.env,
  workdir = sigmaAuthWorkdir(env),
  now = () => Date.now(),
  provider = runCanonicalTokenProvider,
  fetchImpl = (...args) => globalThis.fetch(...args),
  warn = console.warn,
} = {}) {
  let active = null;

  function sourceAuth() {
    const file = readSigmaAuthFile(workdir);
    const envToken = env.SIGMA_API_TOKEN || '';
    return {
      base: env.SIGMA_BASE_URL || file.base || DEFAULT_SIGMA_BASE_URL,
      token: envToken || file.token || '',
      mintedAt: envToken
        ? (env.SIGMA_TOKEN_MINTED_AT || '')
        : (file.mintedAt || ''),
      authMethod: envToken
        ? (env.SIGMA_AUTH_METHOD || '')
        : (file.authMethod || ''),
    };
  }

  function normalize(auth) {
    const base = validateSigmaBaseUrl(auth.base, {
      allowInsecure: env.SIGMA_ALLOW_INSECURE_BASE_URL === '1',
      warn,
    });
    return { ...auth, base, token: validateSigmaBearer(auth.token) };
  }

  function publish(auth) {
    env.SIGMA_BASE_URL = auth.base;
    env.SIGMA_API_TOKEN = auth.token;
    if (auth.mintedAt) env.SIGMA_TOKEN_MINTED_AT = auth.mintedAt;
    else delete env.SIGMA_TOKEN_MINTED_AT;
    if (auth.authMethod) env.SIGMA_AUTH_METHOD = auth.authMethod;
    else delete env.SIGMA_AUTH_METHOD;
    active = auth;
    return auth;
  }

  function refresh(base, forceRefresh) {
    const refreshed = provider({ workdir, env, base, forceRefresh });
    return publish(normalize(refreshed));
  }

  function current({ forceRefresh = false } = {}) {
    const candidate = active || sourceAuth();
    validateSigmaBaseUrl(candidate.base, {
      allowInsecure: env.SIGMA_ALLOW_INSECURE_BASE_URL === '1',
      warn,
    });
    const refreshDue = tokenRefreshDue(candidate.mintedAt, now());
    if (forceRefresh || !candidate.token || refreshDue) {
      return refresh(candidate.base, forceRefresh || refreshDue);
    }
    return publish(normalize(candidate));
  }

  async function authenticatedFetch(path, init = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new Error(`Sigma request path must be origin-relative: ${path}`);
    }
    let auth = current();
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = new Headers(init.headers || {});
      headers.set('Authorization', `Bearer ${auth.token}`);
      response = await fetchImpl(`${auth.base}${path}`, { ...init, headers });
      if (response.status !== 401 || attempt === 1) break;
      auth = current({ forceRefresh: true });
    }
    return response;
  }

  return {
    get base() {
      const auth = active || sourceAuth();
      return validateSigmaBaseUrl(auth.base, {
        allowInsecure: env.SIGMA_ALLOW_INSECURE_BASE_URL === '1',
        warn,
      });
    },
    current,
    refresh: () => current({ forceRefresh: true }),
    fetch: authenticatedFetch,
  };
}
