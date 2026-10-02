import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Strict dependency-free flag parser. Values consumed by a flag can never
 * become positional arguments.
 */
export function parseCliArgs(
  argv,
  { valueFlags = [], booleanFlags = [], allowPositionals = true } = {},
) {
  const values = {};
  const booleans = new Set();
  const positionals = [];
  const valueSet = new Set(valueFlags);
  const booleanSet = new Set(booleanFlags);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (valueSet.has(token)) {
      const next = argv[index + 1];
      if (next == null || next.startsWith('--')) {
        throw new Error(`${token} requires a value`);
      }
      values[token] = next;
      index++;
    } else if (booleanSet.has(token)) {
      booleans.add(token);
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option ${token}`);
    } else if (allowPositionals) {
      positionals.push(token);
    } else {
      throw new Error(`Unexpected positional argument ${token}`);
    }
  }
  return {
    values,
    booleans,
    positionals,
    value: (flag) => values[flag] ?? null,
    has: (flag) => booleans.has(flag),
  };
}

export function isDirectRun(moduleUrl, argv = process.argv) {
  return Boolean(argv[1])
    && pathToFileURL(resolve(argv[1])).href === moduleUrl;
}
