#!/usr/bin/env node
/**
 * Read-only BusinessObjects migration assessment.
 *
 *   node assess.mjs --offline --input <file-or-dir> --out <dir>
 *   node assess.mjs --live --out <dir> [--folder <id>] [--capture-webi] [--extract-crystal]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../businessobjects-to-sigma/scripts/cli-args.mjs';
import { discoverRepository } from '../../businessobjects-to-sigma/scripts/inventory.mjs';
import { captureWebiSnapshot, snapshotState } from '../../businessobjects-to-sigma/scripts/capture-webi.mjs';
import { getUniverse, redact, redactSecrets } from '../../businessobjects-to-sigma/scripts/bo-rws.mjs';
import { loadInputs } from './load-inputs.mjs';
import { applyUsage, rollup, scoreCrystal, scoreUniverse, scoreWebi } from './score-coverage.mjs';
import { parseUsageCsv } from './scoring.mjs';
import { buildMigrationPlan } from './plan.mjs';
import { writeReadouts } from './render-readout.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const crystalScript = join(here, '../../businessobjects-to-sigma/scripts/extract-crystal-cms.groovy');

function collect(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === flag) values.push(argv[++index]);
  }
  return values.filter(value => value != null && !value.startsWith('--'));
}

function flag(argv, name) {
  return argv.includes(name);
}

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function defaultCrystalRunner(args) {
  return spawnSync('groovy', args, { encoding: 'utf8' });
}

export async function extractCrystal(reports, { outDir, refresh = false, runner = defaultCrystalRunner } = {}) {
  const warnings = [];
  if (!process.env.BO_SDK_LIB || !process.env.BO_CMS) {
    warnings.push('Crystal extraction skipped: set BO_SDK_LIB and BO_CMS. CMS inventory remains metadata-only.');
    return { reports, warnings };
  }
  const updated = [];
  for (const report of reports) {
    const reportDir = join(outDir, 'crystal', String(report.id));
    if (!refresh && findIr(reportDir)) {
      updated.push({ ...report, specFile: findIr(reportDir), raw: null, captureStatus: 'extracted' });
      continue;
    }
    mkdirSync(reportDir, { recursive: true });
    const args = [
      '-cp', `${process.env.BO_SDK_LIB}/*`, crystalScript,
      '--cms', process.env.BO_CMS,
      '--user', process.env.BO_USER || '',
      '--password', process.env.BO_PASSWORD || '',
      '--auth', process.env.BO_AUTH || 'secEnterprise',
      '--id', String(report.id),
      '--out-dir', reportDir,
    ];
    const result = runner(args);
    if (result.status !== 0) {
      warnings.push(`Crystal ${report.id}: ${redactSecrets(result.stderr || result.stdout || 'extractor failed')}`);
      updated.push(report);
      continue;
    }
    const irPath = findIr(reportDir);
    updated.push(irPath ? { ...report, specFile: irPath, captureStatus: 'extracted' } : report);
  }
  return { reports: updated, warnings };
}

function findIr(directory) {
  if (!existsSync(directory)) return null;
  const match = readdirSync(directory).find(name => name.endsWith('.crystal-ir.json') || name.endsWith('.ir.json'));
  return match ? join(directory, match) : null;
}

function readJsonIf(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function captureLiveDetails(inventory, { outDir, captureWebi = false, refresh = false, extract = false, runner } = {}) {
  const warnings = [...inventory.warnings];
  mkdirSync(join(outDir, 'specs'), { recursive: true });
  const universes = [];
  for (const universe of inventory.universes) {
    const specFile = join(outDir, 'specs', `universe-${universe.id}.json`);
    if (!(refresh === false && existsSync(specFile))) {
      try {
        const body = redact(await getUniverse(universe.id));
        writeFileSync(specFile, `${JSON.stringify(body, null, 2)}\n`);
      } catch (error) {
        warnings.push(`Universe ${universe.id}: ${redactSecrets(error.message)}`);
        universes.push({ ...universe, captureStatus: 'failed' });
        continue;
      }
    }
    universes.push({ ...universe, specFile, raw: readJsonIf(specFile), captureStatus: 'outline-or-export' });
  }
  const webi = [];
  for (const document of inventory.webiDocuments) {
    const dir = join(outDir, 'snapshots', 'webi', String(document.id));
    let state = snapshotState(dir);
    if (captureWebi && (refresh || state.status !== 'complete')) {
      try {
        await captureWebiSnapshot(document.id, dir);
        state = snapshotState(dir);
      } catch (error) {
        warnings.push(`Webi ${document.id}: ${redactSecrets(error.message)}`);
        state = { status: 'failed', warnings: [redactSecrets(error.message)] };
      }
    }
    const normalized = join(dir, 'normalized.json');
    webi.push({
      ...document,
      specFile: existsSync(normalized) ? normalized : null,
      raw: readJsonIf(normalized),
      captureStatus: state.status,
    });
  }
  let crystal = inventory.crystalReports.map(report => ({ ...report, raw: null, captureStatus: 'metadata-only' }));
  if (extract) {
    const extracted = await extractCrystal(crystal, { outDir, refresh, runner });
    warnings.push(...extracted.warnings);
    crystal = extracted.reports.map(report => ({
      ...report,
      raw: readJsonIf(report.specFile || findIr(join(outDir, 'crystal', String(report.id)))),
      specFile: report.specFile || findIr(join(outDir, 'crystal', String(report.id))),
    }));
  }
  return { ...inventory, warnings, universes, webiDocuments: webi, crystalReports: crystal };
}

export function scoreInventory(inventory, { usageRows = null, generatedAt }) {
  const artifacts = [
    ...inventory.universes.map(item => item.raw ? scoreUniverse(item.raw, item) : scoreUniverse({ universe: { name: item.name, classes: [] } }, item)),
    ...inventory.webiDocuments.map(item => item.raw ? scoreWebi(item.raw, item) : scoreWebi({ document: { name: item.name, reports: [] } }, { ...item, captureStatus: item.captureStatus || 'missing' })),
    ...inventory.crystalReports.map(item => scoreCrystal(item.raw, item)),
  ];
  const scored = applyUsage(artifacts, usageRows);
  const coverage = {
    rollup: rollup(scored, { generatedAt, usageFile: usageRows != null }),
    artifacts: scored.map(({ counts, ...artifact }) => artifact),
  };
  const plan = buildMigrationPlan(coverage.artifacts);
  return { coverage, plan };
}

export function writeAssessment(outDir, { inventory, coverage, plan }) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
  writeFileSync(join(outDir, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`);
  writeFileSync(join(outDir, 'migration-plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeReadouts(outDir, { inventory, coverage, plan });
}

function offlineInventory(artifacts) {
  const grouped = { universe: [], webi: [], crystal: [] };
  for (const artifact of artifacts) grouped[artifact.kind].push(artifact);
  return {
    generatedAt: null,
    readOnly: true,
    mode: 'offline',
    source: { baseUrl: null, folderId: null },
    warnings: [],
    universes: grouped.universe,
    webiDocuments: grouped.webi,
    crystalReports: grouped.crystal,
    folders: [],
    completeness: {
      universes: { complete: true, count: grouped.universe.length },
      webiDocuments: { complete: true, count: grouped.webi.length },
      crystalReports: { complete: true, count: grouped.crystal.length },
    },
  };
}

export async function runAssessment(options) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  let inventory;
  if (options.live) {
    inventory = await discoverRepository({ folderId: options.folder, strict: false });
    inventory.mode = 'live';
    inventory = await captureLiveDetails(inventory, options);
  } else {
    inventory = offlineInventory(loadInputs(options.inputs));
  }
  if (options.crystalIr?.length) {
    const attached = loadInputs(options.crystalIr);
    inventory.crystalReports = inventory.crystalReports.map(report => {
      const match = attached.find(item => item.name === report.name || String(item.id) === String(report.id));
      return match ? { ...report, raw: match.raw, specFile: match.specFile, captureStatus: 'scored' } : report;
    });
    if (!inventory.crystalReports.length) {
      inventory.crystalReports = attached.map(item => ({ ...item, captureStatus: 'scored' }));
    }
  }
  const usageRows = options.usageText == null ? null : parseUsageCsv(options.usageText);
  inventory.generatedAt = generatedAt;
  const { coverage, plan } = scoreInventory(inventory, { usageRows, generatedAt });
  const publicInventory = { ...inventory };
  for (const list of ['universes', 'webiDocuments', 'crystalReports']) {
    publicInventory[list] = inventory[list].map(({ raw, ...item }) => item);
  }
  writeAssessment(options.outDir, { inventory: publicInventory, coverage, plan });
  return { inventory: publicInventory, coverage, plan };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.length === 0) {
    console.log(`Usage:
  node assess.mjs --offline --input <file-or-dir> [--input ...] --out <dir> [--usage file.csv] [--generated-at ISO]
  node assess.mjs --live --out <dir> [--folder <id>] [--capture-webi] [--extract-crystal] [--crystal-ir <dir>]`);
    process.exit(argv.includes('--help') ? 0 : 2);
  }
  const live = flag(argv, '--live');
  const inputs = collect(argv, '--input');
  const outDir = value(argv, '--out');
  if (!outDir || (live && flag(argv, '--offline')) || (!live && !inputs.length)) {
    console.error('Pass --out and either --live or --offline --input.');
    process.exit(2);
  }
  const usagePath = value(argv, '--usage');
  const result = await runAssessment({
    live,
    inputs,
    outDir,
    folder: value(argv, '--folder'),
    captureWebi: flag(argv, '--capture-webi'),
    refresh: flag(argv, '--refresh'),
    extract: flag(argv, '--extract-crystal'),
    crystalIr: collect(argv, '--crystal-ir'),
    generatedAt: value(argv, '--generated-at'),
    usageText: usagePath ? readFileSync(usagePath, 'utf8') : null,
  });
  const incomplete = Object.values(result.inventory.completeness || {}).some(item => item && item.complete === false);
  console.log(`Wrote ${outDir} (${result.coverage.artifacts.length} artifacts, ${result.coverage.rollup.pct_auto}% auto).`);
  if (incomplete && flag(argv, '--fail-on-incomplete')) process.exit(2);
}

if (isDirectRun(import.meta.url)) {
  main().catch(error => { console.error(redactSecrets(error.message)); process.exit(1); });
}
