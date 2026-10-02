import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runAssessment, extractCrystal } from '../scripts/assess.mjs';
import { applyUsage, scoreCrystal, scoreUniverse, scoreWebi } from '../scripts/score-coverage.mjs';
import { buildMigrationPlan } from '../scripts/plan.mjs';
import { parseUsageCsv } from '../scripts/scoring.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const converter = join(repoRoot, 'skills/businessobjects-to-sigma');
const fixtures = join(here, '../fixtures');
let failures = 0;
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  if (!condition) failures++;
}

const generatedAt = '2026-10-02T00:00:00.000Z';
const outA = mkdtempSync(join(tmpdir(), 'bo-assessment-a-'));
const outB = mkdtempSync(join(tmpdir(), 'bo-assessment-b-'));
const inputs = [
  fixtures,
  join(converter, 'fixtures/efashion_universe.xml'),
  join(converter, 'fixtures/sample_webi.json'),
  join(converter, 'fixtures/e2e_webi_variables.json'),
  join(converter, 'fixtures/crystal/owned-customer-statement.ir.json'),
];

const first = await runAssessment({ live: false, inputs, outDir: outA, generatedAt, usageText: null });
const second = await runAssessment({ live: false, inputs, outDir: outB, generatedAt, usageText: null });
check(readFileSync(join(outA, 'coverage.json'), 'utf8') === readFileSync(join(outB, 'coverage.json'), 'utf8'), 'coverage is deterministic');
check(readFileSync(join(outA, 'readout.html'), 'utf8') === readFileSync(join(outB, 'readout.html'), 'utf8'), 'readout html is deterministic');
check(readFileSync(join(outA, 'readout.html'), 'utf8').includes('Read-only assessment'), 'readout says it is read-only');
check(readFileSync(join(outA, 'migration-plan.json'), 'utf8').includes('Migrate first'), 'plan has a migrate-first wave');

const byId = new Map(first.coverage.artifacts.map(artifact => [artifact.id, artifact]));
const outline = byId.get('outline-universe');
const context = byId.get('context-universe');
const clean = byId.get('clean-webi');
const blocked = byId.get('blocked-webi');
const multi = byId.get('multi-webi');
const sample = first.coverage.artifacts.find(artifact => artifact.name === 'Retail Performance');
const nofilter = first.coverage.artifacts.find(artifact => artifact.name === 'Retail E2E Tie-Out');
const crystal = first.coverage.artifacts.find(artifact => artifact.kind === 'crystal');
const fullUniverse = byId.get('efashion_universe');

check(outline?.tag === 'needs-export', `outline universe needs an SDK export (got ${outline?.tag})`);
check(context?.gaps.some(gap => gap.signal === 'universe-contexts'), 'universe contexts stay visible');
check(context?.tag !== 'needs-export', 'a full universe with contexts is not an export blocker');
check(clean?.tag === 'migrate-first', `clean Webi is migrate-first (got ${clean?.tag})`);
check(clean?.tag !== 'retire', 'missing usage does not retire a clean document');
check(multi?.tag === 'needs-review' && multi.gaps.some(gap => gap.signal === 'multiple-data-providers'), 'multiple providers are unhandled');
check(sample?.gaps.some(gap => gap.signal === 'unbound-filters'), 'sample Webi filters stay manual');
check(sample?.tag !== 'migrate-first', 'filtered Webi is not migrate-first');
check(byId.get('prompted-webi')?.gaps.some(gap => gap.signal === 'input-controls'), 'input controls stay visible as manual work');
check(nofilter?.gaps.some(gap => gap.signal === 'nofilter') && nofilter.tag === 'needs-review', 'NoFilter is an unhandled review');
check(crystal && crystal.tag !== 'extract-first' && crystal.degradations > 0, 'Crystal IR is scored from the degradation ledger');
check(fullUniverse?.kind === 'universe' && fullUniverse.tag !== 'needs-export', 'SL-SDK XML is not treated as an outline');

const cleanWave = first.plan.waves.find(wave => wave.members.some(member => member.id === 'clean-webi'));
const universeWave = first.plan.waves.find(wave => wave.members.some(member => member.id === 'efashion_universe'));
check(universeWave && cleanWave && universeWave.id <= cleanWave.id, 'the universe is not scheduled after the Webi document that needs it');
if (universeWave && cleanWave && universeWave.id === cleanWave.id) {
  const ids = cleanWave.members.map(member => member.id);
  check(ids.indexOf('efashion_universe') < ids.indexOf('clean-webi'), 'within a wave, the universe precedes its Webi document');
}
check(first.plan.blocked.some(item => item.id === 'blocked-webi'), 'Webi waiting on an outline universe is not scheduled');
check(!first.plan.waves.some(wave => wave.members.some(member => member.id === 'outline-universe')), 'outline universes stay in prerequisites');

const usageOut = mkdtempSync(join(tmpdir(), 'bo-assessment-usage-'));
const withUsage = await runAssessment({
  live: false,
  inputs,
  outDir: usageOut,
  generatedAt,
  usageText: readFileSync(join(fixtures, 'usage.csv'), 'utf8'),
});
const usedClean = withUsage.coverage.artifacts.find(artifact => artifact.id === 'clean-webi');
const usedOutline = withUsage.coverage.artifacts.find(artifact => artifact.id === 'outline-universe');
const unused = withUsage.coverage.artifacts.find(artifact => artifact.id === 'context-universe');
check(usedClean.tag === 'retire' && usedClean.valueBasis === 'audit-csv', 'an audit row with zero runs can retire');
check(usedOutline.tag === 'needs-export', 'acquisition blockers outrank a non-zero usage row');
check(unused.tag !== 'retire' && unused.valueBasis === 'complexity-proxy', 'artifacts missing from the audit file are not retired');

const cleanSource = JSON.parse(readFileSync(join(fixtures, 'clean-webi.json'), 'utf8'));
const partial = scoreWebi(cleanSource, { id: 'partial-webi', name: 'Partial Webi', captureStatus: 'partial' });
check(partial.acquisition === 'needs-capture', 'partial Webi snapshots wait for recapture');
const failedUniverse = scoreUniverse(
  { universe: { name: 'Failed Universe', classes: [] } },
  { id: 'failed-universe', name: 'Failed Universe', captureStatus: 'failed' },
);
check(failedUniverse.acquisition === 'needs-capture', 'failed universe fetches wait for recapture');
const [blankUsage] = applyUsage(
  [scoreWebi(cleanSource, { id: 'clean-webi', name: 'Clean Webi' })],
  parseUsageCsv('id,kind,name,runs\nclean-webi,webi,Clean Webi,\n'),
);
check(blankUsage.tag !== 'retire' && blankUsage.valueBasis === 'complexity-proxy', 'blank audit runs keep the complexity proxy');

const dependencyPlan = buildMigrationPlan([
  { id: 'retired-universe', name: 'Retired Universe', kind: 'universe', tag: 'retire', dependsOn: [] },
  { id: 'retired-webi', name: 'Retired Dependency', kind: 'webi', tag: 'migrate-first', dependsOn: ['retired-universe'] },
  { id: 'missing-webi', name: 'Missing Dependency', kind: 'webi', tag: 'migrate-first', dependsOn: ['missing-universe'] },
]);
check(dependencyPlan.blocked.some(item => item.id === 'retired-webi'), 'Webi depending on a retired universe is blocked');
check(dependencyPlan.blocked.some(item => item.id === 'missing-webi'), 'Webi with a missing universe dependency is blocked');

const metadataOnly = scoreCrystal(null, { id: 'cms-1', name: 'Unextracted', kind: 'crystal' });
check(metadataOnly.acquisition === 'extract-first', 'CMS Crystal rows without an IR wait for extraction');

const savedSdk = process.env.BO_SDK_LIB;
const savedCms = process.env.BO_CMS;
const savedPassword = process.env.BO_PASSWORD;
delete process.env.BO_SDK_LIB;
delete process.env.BO_CMS;
const skipped = await extractCrystal([{ id: '1', name: 'Report' }], { outDir: outA, runner: () => { throw new Error('runner should not be called'); } });
check(/skipped/.test(skipped.warnings.join(' ')), 'Crystal extraction is skipped without the SDK');
process.env.BO_SDK_LIB = '/sdk';
process.env.BO_CMS = 'cms.example:6400';
process.env.BO_PASSWORD = 's3cret';
const failedExtract = await extractCrystal([{ id: '9', name: 'Report' }], {
  outDir: outA,
  runner(args) {
    check(args.includes('--password') && args.includes('s3cret'), 'extractor receives the password only as an argument');
    return { status: 1, stderr: 'logon password=s3cret rejected' };
  },
});
check(failedExtract.warnings.some(warning => warning.includes('<REDACTED>')) && !failedExtract.warnings.some(warning => warning.includes('s3cret')), 'extractor failures redact passwords');
if (savedSdk == null) delete process.env.BO_SDK_LIB; else process.env.BO_SDK_LIB = savedSdk;
if (savedCms == null) delete process.env.BO_CMS; else process.env.BO_CMS = savedCms;
if (savedPassword == null) delete process.env.BO_PASSWORD; else process.env.BO_PASSWORD = savedPassword;

const discover = spawnSync(process.execPath, ['scripts/discover.mjs'], {
  cwd: repoRoot,
  env: { ...process.env, BO_BASE_URL: '', BO_LOGON_TOKEN: '', BO_USER: '', BO_PASSWORD: '' },
  encoding: 'utf8',
});
check(discover.status === 1 && /Missing BO_BASE_URL/.test(`${discover.stderr}`), 'root discover wrapper reaches the skill CLI');

rmSync(outA, { recursive: true, force: true });
rmSync(outB, { recursive: true, force: true });
rmSync(usageOut, { recursive: true, force: true });
console.log(failures ? `\n${failures} assessment check(s) failed` : '\nAll assessment checks passed');
process.exit(failures ? 1 : 0);
