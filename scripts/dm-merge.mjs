/** Return all data-model elements from either supported GET-spec envelope. */
export function dataModelElements(spec) {
  const pages = spec?.pages || spec?.spec?.pages || [];
  return pages.flatMap(page => page?.elements || []);
}

/**
 * Resolve a data-model element by its stable source name, never by a possibly
 * stale server-assigned id.
 */
export function resolveDataModelViewBySourceName(spec, sourceName) {
  if (!sourceName || !String(sourceName).trim()) {
    throw new Error('A stable View sourceName is required for data-model readback resolution');
  }
  const matches = dataModelElements(spec)
    .filter(element => element?.name === String(sourceName).trim());
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one data-model element named ${JSON.stringify(sourceName)}; found ${matches.length}`,
    );
  }
  return matches[0];
}

/**
 * Confirm every requested addition survived PUT/GET with the same collection,
 * name, and formula. Name-only dedupe is not accepted as proof because an
 * older calculation with the same name may have a different formula.
 */
export function assessDataModelAdditions(view, additions = {}) {
  const errors = [];
  const collections = [
    ['columns', additions.columns || []],
    ['metrics', additions.metrics || []],
  ];
  for (const [kind, expected] of collections) {
    const actual = Array.isArray(view?.[kind]) ? view[kind] : [];
    for (const addition of expected) {
      const matches = actual.filter(item => item?.name === addition?.name);
      if (matches.length !== 1) {
        errors.push(
          `${kind.slice(0, -1)} ${JSON.stringify(addition?.name)} expected once, found ${matches.length}`,
        );
        continue;
      }
      if (matches[0].formula !== addition.formula) {
        errors.push(
          `${kind.slice(0, -1)} ${JSON.stringify(addition.name)} formula changed`,
        );
      }
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    viewElementId: view?.id || null,
    sourceName: view?.name || null,
    expectedColumns: additions.columns?.length || 0,
    expectedMetrics: additions.metrics?.length || 0,
  };
}

export function resolveDataModelBindingAfterWrite(spec, binding, additions) {
  const view = resolveDataModelViewBySourceName(spec, binding?.sourceName);
  const additionsVerdict = assessDataModelAdditions(view, additions);
  return {
    binding: {
      ...binding,
      viewElementId: view.id,
      sourceName: view.name,
    },
    view,
    additionsVerdict,
    idChanged: binding?.viewElementId !== view.id,
  };
}

/** Merge dataModelAdditions into the named View element of a DM spec (in place).
 *  Dedupe by name against existing columns AND metrics; report skips. */
export function mergeAdditionsIntoView(spec, viewElementId, additions) {
  // Tolerate both a flat `spec.pages` and a nested `spec.spec.pages` shape —
  // the DM-spec GET response shape has been uncertain in this project (see
  // migrate-universe.mjs's own `spec.pages || spec.spec?.pages || []` hedge).
  //
  // Deliberately NO bare `spec.elements[]` fallback here: scripts/sigma.mjs's
  // postDataModelSpec (the PUT that writes this mutation back) only ever sends
  // `spec.pages || spec.spec?.pages` — it has no matching bare-elements
  // fallback. A live DM spec always carries `.pages`, so that fallback was
  // dead weight; worse, if it ever DID fire, the mutation would land on
  // `spec.elements` and be silently LOST on the PUT (postDataModelSpec would
  // never see it). Keeping the two functions in lock-step on the shape they
  // read/write is the point — see postDataModelSpec's docstring.
  const el = dataModelElements(spec).find(e => e.id === viewElementId);
  if (!el) throw new Error(`View element ${viewElementId} not found in DM spec`);
  el.metrics = el.metrics || []; el.columns = el.columns || []; el.order = el.order || [];
  const taken = new Set([...el.columns, ...el.metrics].map(x => x.name).filter(Boolean));
  const skipped = [];
  const add = (arr, item) => { if (taken.has(item.name)) { skipped.push(item.name); return false; } arr.push(item); taken.add(item.name); return true; };
  const addedMetrics = (additions.metrics || []).filter(m => add(el.metrics, m)).length;
  const addedColumns = (additions.columns || []).filter(c => { const ok = add(el.columns, c); if (ok) el.order.push(c.id); return ok; }).length;
  return { addedMetrics, addedColumns, skipped };
}
