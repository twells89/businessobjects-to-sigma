import { detectBobjInputKind } from '../converters/bobj.mjs';

function blocker(code, message, details = {}) {
  return { code, message, details };
}

export function universePreflight(input, result, options = {}) {
  const elements = result?.model?.pages?.flatMap(page => page.elements || []) || [];
  const physical = elements.filter(element => element.source?.kind === 'warehouse-table');
  const views = elements.filter(element => / View$/.test(element.name || ''));
  const blockers = [];
  const inputKind = detectBobjInputKind(input);

  if (options.requireTargetConnection && !options.connectionId) {
    blockers.push(blocker('missing-target-connection', 'SIGMA_CONNECTION_ID is required before this model can be published.'));
  }
  if (options.requireSourceUniverseId && !options.sourceUniverseId) {
    blockers.push(blocker(
      'missing-source-universe-id',
      'A local SDK/IDT export must include --source-universe-id so later Webi provider binding can be verified.',
    ));
  }

  if (inputKind === 'json-outline') {
    blockers.push(blocker(
      'outline-only-universe',
      'RWS outline JSON does not contain physical tables, joins, or object SELECT expressions. Use an SL-SDK/IDT export.',
    ));
  }
  if (!physical.length) {
    blockers.push(blocker('no-physical-elements', 'The conversion produced no physical warehouse-table elements.'));
  }
  if (!views.length) {
    blockers.push(blocker('no-bindable-view', 'The conversion produced no bindable denormalized View element.'));
  }
  if (views.length > 1) {
    blockers.push(blocker(
      'ambiguous-bindable-view',
      'The conversion produced multiple candidate Views; automatic workbook binding would be ambiguous.',
      { views: views.map(view => view.name) },
    ));
  }
  if (physical.length > 1 && Number(result?.stats?.relationships || 0) === 0) {
    blockers.push(blocker(
      'missing-relationships',
      'A multi-table universe produced zero relationships, so a workbook cannot safely reach all dimensions.',
      { physicalElements: physical.length },
    ));
  }

  return {
    verdict: blockers.length ? 'BLOCKED' : (result?.warnings?.length ? 'PASS_WITH_WARNINGS' : 'PASS'),
    inputKind,
    blockers,
    warnings: result?.warnings || [],
    stats: { ...(result?.stats || {}), physicalElements: physical.length, bindableViews: views.length },
  };
}

function providerUniverseId(provider) {
  return provider?.universeId
    ?? provider?.universe?.id
    ?? provider?.dataSource?.universeId
    ?? provider?.dataSource?.id
    ?? provider?.dataSourceId
    ?? null;
}

function reportFilters(document) {
  const reports = Array.isArray(document?.reports) ? document.reports : [];
  return reports.flatMap(report => Array.isArray(report.filters) ? report.filters : []);
}

export function webiPreflight(source, result, binding = {}) {
  const document = source?.document ?? source ?? {};
  const providers = Array.isArray(source?.dataproviders)
    ? source.dataproviders
    : (Array.isArray(document.dataproviders) ? document.dataproviders : []);
  const universeIds = [...new Set(providers.map(providerUniverseId).filter(Boolean).map(String))];
  const filters = [
    ...(Array.isArray(document.filters) ? document.filters : []),
    ...reportFilters(document),
  ];
  const pages = result?.workbook?.pages || [];
  const elements = pages.flatMap(page => page.elements || []);
  const blockers = [];
  const captureWarnings = Array.isArray(source?.warnings) ? source.warnings : [];

  if (!binding.dataModelId || !binding.viewElementId || !binding.sourceName) {
    blockers.push(blocker(
      'incomplete-universe-binding',
      'The workbook binding is missing a data model id, View element id, or View source name.',
    ));
  }
  if (!Array.isArray(document.reports) || !document.reports.length) {
    blockers.push(blocker('no-source-reports', 'The captured Webi document contains no reports.'));
  }
  if (!pages.length || !elements.length) {
    blockers.push(blocker('no-workbook-elements', 'The conversion produced no workbook elements.'));
  }
  if (providers.length > 1) {
    blockers.push(blocker(
      'multiple-data-providers',
      'Documents with more than one data provider require provider-aware source binding and are not safe to publish yet.',
      { dataProviders: providers.length },
    ));
  }
  if (universeIds.length > 1) {
    blockers.push(blocker(
      'multiple-universes',
      'The document depends on multiple universes and cannot be bound safely to one data-model View.',
      { universeIds },
    ));
  }
  if (providers.length && !universeIds.length) {
    blockers.push(blocker(
      'unresolved-provider-source',
      'The captured data provider does not expose a universe/source id, so its source cannot be verified against the requested binding.',
      { dataProviders: providers.length },
    ));
  }
  if (universeIds.length === 1 && binding.sourceUniverseId != null && String(binding.sourceUniverseId) !== universeIds[0]) {
    blockers.push(blocker(
      'universe-binding-mismatch',
      'The Webi data provider references a different universe than the saved Sigma binding.',
      { providerUniverseId: universeIds[0], bindingUniverseId: String(binding.sourceUniverseId) },
    ));
  }
  if (filters.length) {
    blockers.push(blocker(
      'unbound-filters',
      'Source filters are present, but the converter currently emits unbound controls instead of preserving filter scope.',
      { filters: filters.length },
    ));
  }
  if (captureWarnings.some(warning => /\/filters:/.test(warning))) {
    blockers.push(blocker(
      'filter-capture-incomplete',
      'At least one source filter endpoint could not be read, so absence of filters cannot be verified.',
    ));
  }
  if (captureWarnings.some(warning => /\/dataproviders:/.test(warning))) {
    blockers.push(blocker(
      'provider-capture-incomplete',
      'The source data-provider collection could not be read, so source binding cannot be verified.',
    ));
  }

  return {
    verdict: blockers.length ? 'BLOCKED' : (result?.warnings?.length ? 'PASS_WITH_WARNINGS' : 'PASS'),
    blockers,
    warnings: result?.warnings || [],
    stats: {
      ...(result?.stats || {}),
      sourceReports: Array.isArray(document.reports) ? document.reports.length : 0,
      dataProviders: providers.length,
      universes: universeIds.length,
      sourceFilters: filters.length,
    },
  };
}

export function assertPublishable(preflight, subject) {
  if (preflight.blockers.length) {
    const summary = preflight.blockers.map(item => `${item.code}: ${item.message}`).join('\n  - ');
    throw new Error(`${subject} failed preflight and was not posted:\n  - ${summary}`);
  }
}

export function applyWarningPolicy(preflight, failOnWarning) {
  if (!failOnWarning || !preflight.warnings.length) return preflight;
  const warningBlocker = blocker(
    'warnings-disallowed',
    `Conversion emitted ${preflight.warnings.length} warning(s) and --fail-on-warning was set.`,
  );
  return { ...preflight, verdict: 'BLOCKED', blockers: [...preflight.blockers, warningBlocker] };
}
