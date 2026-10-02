/**
 * Scoring constants and warning classifiers shared by the assessment.
 * Buckets match the other migration assessments: auto / hint / manual / unhandled.
 * Cost is 10·unhandled + 3·manual + 1·hint. Auto features add value, not cost.
 */
export const COST = { auto: 0, hint: 1, manual: 3, unhandled: 10 };
export const EASY_WIN_SCORE = 10;

export const CRYSTAL_DISPOSITION = {
  'translated-with-warning': 'hint',
  'redesigned-in-table': 'hint',
  'warehouse-default': 'hint',
  'responsive-single-page': 'hint',
  'non-repeating-page-content': 'manual',
  'manual-or-static-fallback': 'manual',
  'omitted-image': 'manual',
  'omitted-unbound-control': 'manual',
  'not-emitted-grain-redesign': 'manual',
  'not-emitted-detail-preserved': 'manual',
  'not-emitted-unresolved': 'manual',
  'not-emitted-filter': 'manual',
  'not-emitted': 'unhandled',
  'explicit-wide-source': 'info',
  'explicit-data-model-binding': 'info',
};

export const UNIVERSE_RULES = [
  rule(/RWS outline JSON/, 'outline-only-universe', 'unhandled', 'RWS outline JSON has no tables, joins, or SELECT expressions.', 'Re-extract with scripts/extract-universe-sdk.groovy or an IDT data-foundation export before converting.'),
  ignore(/Input format:/),
  ignore(/Target-layer remap applied/),
  rule(/Predefined filter/, 'predefined-filter', 'manual', 'Universe predefined filters are report-time conditions.', 'Re-author the filter as a Sigma control or data-model filter.'),
  rule(/@Prompt\(\)/, 'at-prompt', 'manual', '@Prompt is a runtime prompt.', 'Model it as a Sigma control or parameter.'),
  rule(/@Variable\(\)/, 'at-variable', 'manual', '@Variable reads a session value.', 'Substitute a Sigma control or literal.'),
  rule(/@Select\(\)/, 'at-select', 'manual', '@Select references another universe object.', 'Inline the target object SELECT.'),
  rule(/@Aggregate_Aware\(\)/, 'at-aggregate-aware', 'hint', '@Aggregate_Aware kept only the first branch.', 'Verify aggregate routing against the warehouse grain.'),
  rule(/@Where\(\)/, 'at-where', 'manual', '@Where embeds a condition.', 'Re-express it as If() or a filter.'),
  rule(/uses @/, 'at-function', 'unhandled', 'This @-function has no Sigma equivalent.', 'Rewrite the expression by hand.'),
  rule(/not a simple equi-join/, 'non-equi-join', 'manual', 'Sigma relationships are equi-joins.', 'Recreate the join in the data model or push it into Custom SQL.'),
  rule(/multiple values|assumed .* many side/, 'ambiguous-cardinality', 'hint', 'Join direction was inferred.', 'Confirm the relationship source is the many/fact table.'),
  rule(/relationship skipped|table is missing/, 'skipped-relationship', 'manual', 'A join table was missing from the export.', 'Re-export the data foundation so every joined table is present.'),
  rule(/SELECT spans tables/, 'cross-table-select', 'hint', 'An object SELECT references more than one table.', 'Verify the calculated column after the relationship is in place.'),
  rule(/not in universe tables/, 'unresolved-table', 'manual', 'An object points at a table the export did not declare.', 'Fix the export or remap the physical name.'),
  rule(/no table reference found/, 'unresolved-select', 'manual', 'A business object SELECT did not reference a table.', 'Review the object SQL before publishing.'),
  rule(/No joins in the universe|0 relationships|0 produced a relationship/, 'missing-relationships', 'unhandled', 'A multi-table universe produced no relationships.', 'Export the data foundation, or repair joins the converter dropped.'),
  rule(/Remap:/, 'remap-miss', 'manual', 'A remap key did not match a universe table or column.', 'Correct remap.json and rerun the dry run.'),
];

export const WEBI_RULES = [
  rule(/NoFilter/, 'nofilter', 'unhandled', 'NoFilter has no direct Sigma equivalent.', 'Compute the value on a separate unfiltered element.'),
  rule(/context operator/, 'calculation-context', 'manual', 'In/ForEach/ForAll context is not applied automatically.', 'Set the Sigma grouping or window partition and verify.'),
  rule(/unbound list control/, 'unbound-filters', 'manual', 'Source filters become unbound controls.', 'Bind each control to a column and restore its scope.'),
  rule(/Between|range\/Between/, 'alerter-between', 'manual', 'Sigma workbook conditional formats have no two-bound operator.', 'Recreate the range rule in Sigma.'),
  rule(/no Sigma mapping|no known Sigma mapping|left raw|could not parse/, 'untranslated-formula', 'unhandled', 'A formula was not translated.', 'Rewrite it in Sigma and keep the source text from the warning.'),
  rule(/not representable/, 'alerter-style', 'manual', 'Part of an alerter has no conditional-format equivalent.', 'Keep the converted color and re-author the dropped effect.'),
  rule(/alerter\(s\) on a/, 'alerter-non-table', 'manual', 'Conditional formats apply to tables and pivots.', 'Recreate the KPI or chart rule in Sigma.'),
  rule(/grand total is not auto-emitted/, 'grand-total', 'hint', 'Per-group subtotals are emitted; the grand total is a Sigma toggle.', 'Enable the table total in Sigma.'),
  rule(/approximated as an outer grouping/, 'section-grouping', 'hint', 'A Webi section becomes the outer grouping.', 'Review the master-detail layout after conversion.'),
  rule(/not auto-adjusted/, 'grouped-running-calc', 'manual', 'A grouped running calculation was not rewritten to group grain.', 'Verify the window function in Sigma.'),
  rule(/produced no element|no recognizable blocks/, 'unmapped-block', 'unhandled', 'A report block did not become a Sigma element.', 'Rebuild the block from the source outline.'),
  rule(/@Prompt|@Variable|@Select/, 'webi-at-function', 'manual', 'A Webi @-function needs a control or inlined object.', 'Replace it with a Sigma control or parameter.'),
  rule(/RunningAverage/, 'running-average', 'hint', 'RunningAverage is emitted as a ratio.', 'Verify the ratio against Webi.'),
  rule(/sort column .* not found/, 'missing-sort', 'hint', 'A sort referenced a column the element does not contain.', 'Reapply the sort in Sigma.'),
  rule(/break\/section .* not found|not a column on the table/, 'missing-break', 'hint', 'A break or section did not match a column.', 'Set the grouping on the converted table.'),
  rule(/no row\/column axis/, 'empty-crosstab', 'manual', 'A crosstab has no axis.', 'Rebuild the pivot rows and columns.'),
];

const BLOCKERS = {
  'outline-only-universe': gap('outline-only-universe', 'unhandled', 'Publication is blocked until a full universe export is supplied.', 'Use an SL-SDK or IDT export.'),
  'no-physical-elements': gap('no-physical-elements', 'unhandled', 'The conversion produced no warehouse tables.', 'Export the data foundation.'),
  'no-bindable-view': gap('no-bindable-view', 'unhandled', 'The conversion produced no denormalized View.', 'Repair the universe export before reports bind to it.'),
  'ambiguous-bindable-view': gap('multi-fact-views', 'manual', 'More than one fact View was produced.', 'Choose the fact grain before binding workbooks. Universe contexts are not modeled.'),
  'missing-relationships': gap('missing-relationships', 'unhandled', 'A multi-table universe produced no relationships.', 'Export joins or recreate them before publishing.'),
  'unbound-filters': gap('unbound-filters', 'manual', 'Source filters are present and their scope is not preserved.', 'Bind the emitted controls before accepting the workbook.'),
  'multiple-data-providers': gap('multiple-data-providers', 'unhandled', 'The document has more than one data provider.', 'Provider-aware binding is not implemented yet.'),
  'multiple-universes': gap('multiple-universes', 'unhandled', 'The document depends on more than one universe.', 'Split or remodel it before a single data-model binding.'),
  'no-source-reports': gap('no-source-reports', 'unhandled', 'The Webi document has no reports.', 'Confirm the capture before converting.'),
  'no-workbook-elements': gap('no-workbook-elements', 'unhandled', 'The conversion produced no workbook elements.', 'Review the source blocks.'),
  'unresolved-provider-source': gap('unresolved-provider-source', 'manual', 'The data provider did not expose a universe id.', 'Recapture the data-provider endpoint.'),
  'universe-binding-mismatch': gap('universe-binding-mismatch', 'manual', 'The provider universe does not match the saved binding.', 'Convert the provider universe first and pass its id.'),
  'filter-capture-incomplete': gap('filter-capture-incomplete', 'unhandled', 'A filter endpoint could not be read.', 'Recapture the document before scoring absence of filters.'),
  'provider-capture-incomplete': gap('provider-capture-incomplete', 'unhandled', 'The data-provider collection could not be read.', 'Recapture the document before converting.'),
};

function rule(test, signal, bucket, reason, remediation) {
  return { test, signal, bucket, reason, remediation };
}

function ignore(test) {
  return { test, ignore: true };
}

export function gap(signal, bucket, reason, remediation, count = 1) {
  return { signal, bucket, count, reason, remediation };
}

function classifyText(rules, text) {
  for (const candidate of rules) {
    if (candidate.test.test(text)) return candidate.ignore ? { ignore: true } : gap(candidate.signal, candidate.bucket, candidate.reason, candidate.remediation);
  }
  return gap('converter-warning', 'manual', text, 'Review the converter warning before publishing.');
}

export function addGap(gaps, next) {
  if (!next || next.ignore) return;
  const found = gaps.find(item => item.signal === next.signal && item.bucket === next.bucket);
  if (found) found.count += next.count || 1;
  else gaps.push({ ...next, count: next.count || 1 });
}

export function addCounted(gaps, signal, bucket, count, reason, remediation) {
  if (count > 0) addGap(gaps, gap(signal, bucket, reason, remediation, count));
}

export function classifyWarnings(rules, warnings, gaps) {
  for (const warning of warnings || []) {
    const classified = classifyText(rules, String(warning));
    addGap(gaps, classified);
  }
}

export function classifyBlockers(blockers, gaps) {
  for (const blocker of blockers || []) {
    const known = BLOCKERS[blocker.code];
    addGap(gaps, known || gap(blocker.code || 'preflight-blocker', 'unhandled', blocker.message, 'Resolve the preflight blocker before publishing.'));
  }
}

export function sourceHasContexts(raw) {
  if (typeof raw === 'string') return /<contexts?\b/i.test(raw);
  const root = raw?.universe ?? raw ?? {};
  return (Array.isArray(root.contexts) && root.contexts.length > 0)
    || (Array.isArray(raw?.contexts) && raw.contexts.length > 0);
}

export function classifyCrystalDegradation(item) {
  const text = `${item?.message || ''} ${item?.source || ''}`;
  if (/WhilePrintingRecords|shared variable|global variable|\bUFLs?\b|user function library/i.test(text)) {
    return gap('multi-pass-or-ufl', 'unhandled', 'Crystal multi-pass evaluation or a user function library is not reproduced.', 'Keep the source formula and rebuild the result in Sigma.');
  }
  const bucket = CRYSTAL_DISPOSITION[item?.disposition] || 'manual';
  if (bucket === 'info') return null;
  const signal = item?.disposition || item?.sourceType || 'crystal-degradation';
  return gap(signal, bucket, item?.message || signal, 'See the Crystal degradation ledger and finish the item by hand.');
}

export function countsOf(gaps) {
  const counts = { auto: 0, hint: 0, manual: 0, unhandled: 0 };
  for (const item of gaps) {
    if (counts[item.bucket] == null) continue;
    counts[item.bucket] += item.count;
  }
  const cost = COST.unhandled * counts.unhandled + COST.manual * counts.manual + COST.hint * counts.hint;
  const n_features = counts.auto + counts.hint + counts.manual + counts.unhandled;
  return { ...counts, cost, n_features };
}

export function complexityOf(counts, acquisition) {
  if (acquisition === 'needs-export' || counts.unhandled > 0) return 'high';
  if (acquisition || counts.manual > 0) return 'medium';
  return 'low';
}

export function tagOf({ counts, score, runs, usageMatched, acquisition }) {
  if (usageMatched && Number(runs) === 0) return 'retire';
  if (acquisition) return acquisition;
  if (counts.unhandled > 0) return 'needs-review';
  if (counts.manual === 0) return 'migrate-first';
  if (score >= EASY_WIN_SCORE) return 'easy-win';
  return 'moderate';
}

export function parseUsageCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return [];
  const headers = splitCsv(lines[0]).map(header => header.toLowerCase());
  return lines.slice(1).map(line => {
    const cells = splitCsv(line);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    const kind = String(row.kind || row.type || '').toLowerCase();
    return {
      id: row.id || row.si_id || null,
      cuid: row.cuid || row.si_cuid || null,
      name: row.name || null,
      kind: kind === 'webi-document' ? 'webi' : kind,
      runs: Number(row.runs ?? row.views ?? row.executions ?? row.refreshes ?? 0),
    };
  }).filter(row => row.id || row.name);
}

function splitCsv(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

export function matchUsage(rows, artifact) {
  if (!rows) return null;
  return rows.find(row => row.id != null && artifact.id != null && String(row.id) === String(artifact.id) && (!row.kind || row.kind === artifact.kind))
    || rows.find(row => row.cuid && artifact.cuid && row.cuid === artifact.cuid)
    || rows.find(row => row.name && artifact.name && row.name === artifact.name && (!row.kind || row.kind === artifact.kind))
    || null;
}
