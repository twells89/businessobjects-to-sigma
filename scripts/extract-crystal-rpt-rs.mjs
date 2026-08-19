#!/usr/bin/env node
/**
 * Linux/macOS extraction smoke path for Crystal .rpt files using rpt-rs.
 *
 * Production extraction uses tools/crystal-extractor (official SAP SDK on
 * Windows). rpt-rs is experimental and reverse-engineered; this command is
 * intentionally explicit about the extractor provenance in the emitted IR.
 *
 * Usage:
 *   node scripts/extract-crystal-rpt-rs.mjs report.rpt --out report.ir.json
 *   node scripts/extract-crystal-rpt-rs.mjs --json rpt-rs-baseline.json --out report.ir.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { normalizeRptRsCrystal } from '../converters/crystal-rpt-rs.mjs';

function value(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const args = process.argv.slice(2);
const jsonInput = value(args, '--json');
const positional = args.find(arg => !arg.startsWith('--') && arg !== jsonInput);
const rptPath = jsonInput ? null : positional;
const inputPath = resolve(jsonInput || rptPath || '');
const outputPath = resolve(value(args, '--out') || `${inputPath}.crystal-ir.json`);

if ((!jsonInput && !rptPath) || !inputPath || !existsSync(inputPath)) {
  console.error('Usage: extract-crystal-rpt-rs.mjs report.rpt --out report.ir.json');
  console.error('   or: extract-crystal-rpt-rs.mjs --json baseline.json --out report.ir.json');
  process.exit(2);
}

let rawPath = inputPath;
let temporary = false;
let extractorVersion = 'baseline-json';

try {
  if (!jsonInput) {
    const rptBin = process.env.RPT_RS_BIN || value(args, '--rpt-bin') || 'rpt';
    rawPath = resolve(tmpdir(), `crystal-${process.pid}-${Date.now()}.json`);
    temporary = true;
    const run = spawnSync(rptBin, ['json-dump', inputPath, rawPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (run.error) throw new Error(`Could not run ${rptBin}: ${run.error.message}`);
    if (run.status !== 0) {
      throw new Error(`${rptBin} json-dump failed (${run.status}): ${(run.stderr || run.stdout || '').slice(0, 1000)}`);
    }
    const version = spawnSync(rptBin, ['--version'], { encoding: 'utf8' });
    extractorVersion = (version.stdout || version.stderr || 'rpt-rs').trim();
  }

  const rawText = readFileSync(rawPath, 'utf8');
  const ir = normalizeRptRsCrystal(rawText, {
    sourceName: basename(inputPath).replace(/\.json$/i, '.rpt'),
    sourcePath: inputPath,
    sourceSha256: jsonInput ? null : sha256(inputPath),
    extractorVersion,
    extractedAt: new Date().toISOString(),
  });
  writeFileSync(outputPath, JSON.stringify(ir, null, 2));
  console.log(`Crystal IR: ${outputPath}`);
  console.log(JSON.stringify({
    sections: ir.sections.length,
    objects: ir.sections.reduce((n, section) => n + section.objects.length, 0),
    tables: ir.data.tables.length,
    links: ir.data.links.length,
    fields: ir.data.fields.length,
    formulas: ir.data.formulas.length,
    parameters: ir.data.parameters.length,
    groups: ir.data.groups.length,
    subreports: ir.subreports.length,
    warnings: ir.warnings.length,
  }));
} finally {
  if (temporary && existsSync(rawPath)) rmSync(rawPath);
}

