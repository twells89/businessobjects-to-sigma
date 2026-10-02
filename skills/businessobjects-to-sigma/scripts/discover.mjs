#!/usr/bin/env node
/**
 * Inventory a BusinessObjects repository: universes, Web Intelligence
 * documents, and Crystal Report definitions the logon user can see.
 *
 * Usage:  node scripts/discover.mjs [--folder <id>] [--out inventory.json]
 * Requires .bo_env (BO_BASE_URL / BO_USER / BO_PASSWORD / BO_AUTH).
 */
import { writeFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
import { discoverRepository } from './inventory.mjs';

function line(item) {
  const owner = item.owner ? ` — ${item.owner}` : '';
  const path = item.path ? ` (${item.path})` : '';
  return `  [${item.id}] ${item.name}${owner}${path}`;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    valueFlags: ['--folder', '--out'],
    booleanFlags: ['--strict'],
  });
  const inventory = await discoverRepository({
    folderId: args.value('--folder'),
    strict: args.has('--strict'),
  });
  console.log(`Connected to ${inventory.source.baseUrl}. Enumerating repository…\n`);
  console.log(`Universes (${inventory.universes.length}) → data models:`);
  for (const item of inventory.universes) console.log(line(item));
  console.log(`\nWeb Intelligence documents (${inventory.webiDocuments.length}) → workbooks:`);
  for (const item of inventory.webiDocuments) console.log(line(item));
  console.log(`\nCrystal Report definitions (${inventory.crystalReports.length}) → Sigma reports:`);
  for (const item of inventory.crystalReports) console.log(line(item));
  for (const warning of inventory.warnings) console.log(`WARN ${warning}`);

  const output = args.value('--out') || 'inventory.json';
  writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
  console.log(`\nWrote ${output}`);
  console.log('Next: migrate a universe + Webi document, or extract a Crystal id with scripts/extract-crystal-cms.groovy.');
}

main().catch(error => { console.error('discover failed:', error.message); process.exit(1); });
