/**
 * Run the BusinessObjects converters and classify their warnings, preflight
 * blockers, and Crystal degradation ledger. This module does not post to Sigma.
 */
import { convertBobjToSigma, detectBobjInputKind } from '../../businessobjects-to-sigma/converters/bobj.mjs';
import { convertWebiToWorkbook } from '../../businessobjects-to-sigma/converters/webi.mjs';
import { convertCrystalToReport } from '../../businessobjects-to-sigma/converters/crystal.mjs';
import { universePreflight, webiPreflight, webiProviderUniverseIds } from '../../businessobjects-to-sigma/scripts/preflight.mjs';
import {
  addCounted,
  addGap,
  classifyBlockers,
  classifyCrystalDegradation,
  classifyWarnings,
  complexityOf,
  countsOf,
  gap,
  matchUsage,
  sourceHasContexts,
  tagOf,
  UNIVERSE_RULES,
  WEBI_RULES,
} from './scoring.mjs';

const ASSESSMENT_BINDING = {
  dataModelId: 'assessment',
  viewElementId: 'assessment',
  sourceName: 'Assessment View',
};

function baseArtifact(meta, gaps, acquisition) {
  const counts = countsOf(gaps);
  return {
    id: meta.id == null ? meta.name : String(meta.id),
    cuid: meta.cuid || null,
    name: meta.name,
    kind: meta.kind,
    path: meta.path || null,
    owner: meta.owner || null,
    specFile: meta.specFile || null,
    acquisition,
    dependsOn: meta.dependsOn || [],
    gaps: gaps.filter(item => item.bucket !== 'auto'),
    n_auto: counts.auto,
    n_hint: counts.hint,
    n_manual: counts.manual,
    n_unhandled: counts.unhandled,
    n_features: counts.n_features,
    cost: counts.cost,
    complexity: complexityOf(counts, acquisition),
    counts,
  };
}

function failed(meta, message) {
  return baseArtifact(meta, [gap('converter-error', 'unhandled', message, 'Fix the source artifact and rerun the assessment.')], null);
}

export function scoreUniverse(raw, meta) {
  const inputKind = detectBobjInputKind(raw);
  try {
    const result = convertBobjToSigma(raw, { connectionId: 'assessment', database: 'ASSESSMENT', schema: 'PUBLIC' });
    const preflight = universePreflight(raw, result);
    const gaps = [];
    classifyWarnings(UNIVERSE_RULES, result.warnings, gaps);
    classifyBlockers(preflight.blockers, gaps);
    if (sourceHasContexts(raw)) {
      addGap(gaps, gap('universe-contexts', 'manual', 'Universe contexts (alternate join paths) are not modeled.', 'Verify multi-fact routing after conversion. The join graph is used as-is.'));
    }
    addCounted(gaps, 'columns', 'auto', result.stats?.columns || 0, 'Business objects became columns or calculations.', '—');
    addCounted(gaps, 'metrics', 'auto', result.stats?.metrics || 0, 'Measures became data-model metrics.', '—');
    addCounted(gaps, 'relationships', 'auto', result.stats?.relationships || 0, 'Equi-joins became relationships.', '—');
    const acquisition = inputKind === 'json-outline' || gaps.some(item => item.signal === 'outline-only-universe')
      ? 'needs-export'
      : null;
    return { ...baseArtifact({ ...meta, kind: 'universe' }, gaps, acquisition), inputKind, preflight: preflight.verdict };
  } catch (error) {
    return failed({ ...meta, kind: 'universe' }, error.message);
  }
}

export function scoreWebi(raw, meta) {
  const source = raw?.document ? raw : { document: raw };
  const dependsOn = meta.dependsOn || webiProviderUniverseIds(source);
  try {
    const result = convertWebiToWorkbook(source, { ...ASSESSMENT_BINDING, measureMap: meta.measureMap || {} });
    const preflight = webiPreflight(source, result, ASSESSMENT_BINDING);
    const gaps = [];
    classifyWarnings(WEBI_RULES, result.warnings, gaps);
    classifyBlockers(preflight.blockers, gaps);
    const stats = result.stats || {};
    addCounted(gaps, 'tables', 'auto', stats.tables || 0, 'Webi tables became Sigma tables.', '—');
    addCounted(gaps, 'pivots', 'auto', stats.pivots || 0, 'Crosstabs became pivot tables.', '—');
    addCounted(gaps, 'charts', 'auto', stats.charts || 0, 'Charts mapped to Sigma chart kinds.', '—');
    addCounted(gaps, 'kpis', 'auto', stats.kpis || 0, 'Measure cells became KPIs.', '—');
    const acquisition = meta.captureStatus === 'missing' || meta.captureStatus === 'failed' ? 'needs-capture' : null;
    return {
      ...baseArtifact({ ...meta, kind: 'webi', dependsOn }, gaps, acquisition),
      preflight: preflight.verdict,
      captureStatus: meta.captureStatus || 'scored',
    };
  } catch (error) {
    return failed({ ...meta, kind: 'webi', dependsOn }, error.message);
  }
}

export function scoreCrystal(ir, meta) {
  if (!ir) {
    const gaps = [gap('crystal-ir-missing', 'hint', 'The CMS row is known, but the report definition was not extracted.', 'Extract the report with the Crystal SDK or CMS/RAS extractor, then rescore.')];
    return { ...baseArtifact({ ...meta, kind: 'crystal' }, gaps, 'extract-first'), captureStatus: 'metadata-only' };
  }
  try {
    const result = convertCrystalToReport(ir, { folderId: 'assessment', connectionId: 'assessment' });
    const gaps = [];
    const ledger = result.degradationLedger || [];
    const ledgerText = ledger.map(item => item.message || '').join('\n');
    for (const item of ledger) addGap(gaps, classifyCrystalDegradation(item));
    const extraWarnings = (result.warnings || []).filter(warning => !ledgerText || !ledger.some(item => warning.includes(item.message)));
    for (const warning of extraWarnings) {
      if (/No tested Crystal profile/.test(warning)) {
        addGap(gaps, gap('untested-profile', 'hint', 'The report did not match a pinned Crystal profile, so a generic field table was emitted.', 'Review groupings, formulas, and the PDF oracle before acceptance.'));
      } else if (/WhilePrintingRecords|shared variable|global variable|\bUFLs?\b/i.test(warning)) {
        addGap(gaps, gap('multi-pass-or-ufl', 'unhandled', warning, 'Rebuild the multi-pass result in Sigma.'));
      }
    }
    const formulaDegradations = ledger.filter(item => item.sourceType === 'formula').length;
    addCounted(gaps, 'table-columns', 'auto', result.stats?.tableColumns || 0, 'Detail fields became report table columns.', '—');
    addCounted(gaps, 'translated-formulas', 'auto', Math.max(0, (result.stats?.formulas || 0) - formulaDegradations), 'Formulas translated without a ledger entry.', '—');
    return { ...baseArtifact({ ...meta, kind: 'crystal' }, gaps, null), captureStatus: 'scored', degradations: ledger.length };
  } catch (error) {
    return failed({ ...meta, kind: 'crystal' }, error.message);
  }
}

export function applyUsage(artifacts, usageRows) {
  const usageFile = usageRows != null;
  return artifacts.map(artifact => {
    const matched = usageFile ? matchUsage(usageRows, artifact) : null;
    const runs = matched ? matched.runs : null;
    const value = matched ? runs : 10 * Math.max(artifact.n_features, 1);
    const score = value / (1 + artifact.cost);
    const tag = tagOf({
      counts: artifact.counts,
      score,
      runs,
      usageMatched: Boolean(matched),
      acquisition: artifact.acquisition,
    });
    return {
      ...artifact,
      runs,
      value,
      valueBasis: matched ? 'audit-csv' : 'complexity-proxy',
      score: Number(score.toFixed(4)),
      tag,
    };
  });
}

export function rollup(artifacts, { generatedAt, usageFile }) {
  const totals = artifacts.reduce((sum, artifact) => {
    sum.n_auto += artifact.n_auto;
    sum.n_hint += artifact.n_hint;
    sum.n_manual += artifact.n_manual;
    sum.n_unhandled += artifact.n_unhandled;
    sum.n_features += artifact.n_features;
    return sum;
  }, { n_auto: 0, n_hint: 0, n_manual: 0, n_unhandled: 0, n_features: 0 });
  const pct = totals.n_features ? Math.round((totals.n_auto / totals.n_features) * 1000) / 10 : 0;
  const histogram = new Map();
  for (const artifact of artifacts) {
    for (const item of artifact.gaps) {
      const key = `${item.bucket}:${item.signal}`;
      if (!histogram.has(key)) histogram.set(key, { ...item, count: 0, artifacts: [] });
      const entry = histogram.get(key);
      entry.count += item.count;
      entry.artifacts.push(artifact.name);
    }
  }
  return {
    generatedAt,
    usageBasis: usageFile ? 'audit-csv' : 'complexity-proxy',
    usageNote: usageFile
      ? 'Run counts come from the supplied audit CSV. Artifacts missing from that file keep a complexity proxy and are not marked retire.'
      : 'No audit usage file was supplied. Value is 10 × feature count. Zero-use retire tags are not inferred.',
    n_artifacts: artifacts.length,
    n_universes: artifacts.filter(item => item.kind === 'universe').length,
    n_webi: artifacts.filter(item => item.kind === 'webi').length,
    n_crystal: artifacts.filter(item => item.kind === 'crystal').length,
    pct_auto: pct,
    totals,
    by_tag: countBy(artifacts, 'tag'),
    by_complexity: countBy(artifacts, 'complexity'),
    gap_histogram: [...histogram.values()].sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal)),
  };
}

function countBy(artifacts, key) {
  const counts = {};
  for (const artifact of artifacts) counts[artifact[key]] = (counts[artifact[key]] || 0) + 1;
  return counts;
}
