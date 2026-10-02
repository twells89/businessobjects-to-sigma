/**
 * Dependency-aware waves. Universes precede the Webi documents that bind to
 * them. Missing usage never produces a retire tag; that decision is made in
 * scoring only when an audit row exists.
 */
const WAVE_TAGS = {
  1: new Set(['migrate-first', 'easy-win']),
  2: new Set(['moderate']),
  3: new Set(['needs-review']),
};

function waveFor(tag) {
  for (const [wave, tags] of Object.entries(WAVE_TAGS)) {
    if (tags.has(tag)) return Number(wave);
  }
  return null;
}

function handoff(artifact) {
  if (artifact.kind === 'universe') {
    return `node scripts/migrate-universe.mjs --file ${artifact.specFile || '<sdk-export>'} --source-universe-id ${artifact.id} --dry-run`;
  }
  if (artifact.kind === 'webi') {
    const universe = artifact.dependsOn?.[0] || '<universeId>';
    return `node scripts/migrate-webi.mjs ${artifact.id} --universe ${universe} --dry-run`;
  }
  return `node scripts/migrate-crystal.mjs --ir ${artifact.specFile || '<crystal-ir.json>'}`;
}

export function buildMigrationPlan(artifacts) {
  const byId = new Map(artifacts.map(artifact => [String(artifact.id), artifact]));
  const prerequisites = [];
  const retire = [];
  const blocked = new Set();
  for (const artifact of artifacts) {
    if (artifact.tag === 'retire') {
      retire.push(member(artifact));
      continue;
    }
    if (artifact.tag === 'needs-export' || artifact.tag === 'extract-first' || artifact.tag === 'needs-capture') {
      prerequisites.push({
        ...member(artifact),
        action: artifact.tag,
      });
      blocked.add(String(artifact.id));
    }
  }
  const deferred = [];
  const waves = [1, 2, 3].map(id => ({
    id,
    title: id === 1 ? 'Migrate first' : id === 2 ? 'Moderate' : 'Needs review',
    members: [],
  }));
  const placed = new Map();
  const ordered = [
    ...artifacts.filter(artifact => artifact.kind === 'universe'),
    ...artifacts.filter(artifact => artifact.kind !== 'universe'),
  ];
  for (const artifact of ordered) {
    if (artifact.tag === 'retire' || blocked.has(String(artifact.id))) continue;
    const dependencyIds = (artifact.dependsOn || []).map(String);
    const missingDependency = dependencyIds.find(id => !byId.has(id));
    const dependencies = dependencyIds.map(id => byId.get(id)).filter(Boolean);
    const blockingDependency = dependencies.find(item => item.tag === 'retire' || blocked.has(String(item.id)));
    if (missingDependency) {
      deferred.push({ ...member(artifact), blockedBy: missingDependency, reason: `Universe ${missingDependency} is missing from the inventory.` });
      continue;
    }
    if (blockingDependency) {
      deferred.push({ ...member(artifact), blockedBy: blockingDependency.id, reason: `Waiting on ${blockingDependency.name} (${blockingDependency.tag}).` });
      continue;
    }
    let wave = waveFor(artifact.tag) || 3;
    for (const dependency of dependencies) {
      const dependencyWave = placed.get(String(dependency.id)) || waveFor(dependency.tag) || wave;
      if (dependencyWave > wave) wave = dependencyWave;
    }
    const bucket = waves.find(item => item.id === wave);
    bucket.members.push(member(artifact));
    placed.set(String(artifact.id), wave);
  }
  for (const wave of waves) {
    wave.members.sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.name.localeCompare(b.name));
  }
  return { waves, prerequisites, blocked: deferred, retire };
}

function kindOrder(kind) {
  if (kind === 'universe') return 0;
  if (kind === 'webi') return 1;
  return 2;
}

function member(artifact) {
  return {
    id: artifact.id,
    name: artifact.name,
    kind: artifact.kind,
    tag: artifact.tag,
    complexity: artifact.complexity,
    score: artifact.score,
    dependsOn: artifact.dependsOn || [],
    handoff: handoff(artifact),
  };
}
