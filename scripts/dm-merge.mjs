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
  const pages = spec.pages || spec.spec?.pages || [];
  const elements = pages.flatMap(p => p.elements || []);
  const el = elements.find(e => e.id === viewElementId);
  if (!el) throw new Error(`View element ${viewElementId} not found in DM spec`);
  el.metrics = el.metrics || []; el.columns = el.columns || []; el.order = el.order || [];
  const taken = new Set([...el.columns, ...el.metrics].map(x => x.name).filter(Boolean));
  const skipped = [];
  const add = (arr, item) => { if (taken.has(item.name)) { skipped.push(item.name); return false; } arr.push(item); taken.add(item.name); return true; };
  const addedMetrics = (additions.metrics || []).filter(m => add(el.metrics, m)).length;
  const addedColumns = (additions.columns || []).filter(c => { const ok = add(el.columns, c); if (ok) el.order.push(c.id); return ok; }).length;
  return { addedMetrics, addedColumns, skipped };
}
