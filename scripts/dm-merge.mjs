/** Merge dataModelAdditions into the named View element of a DM spec (in place).
 *  Dedupe by name against existing columns AND metrics; report skips. */
export function mergeAdditionsIntoView(spec, viewElementId, additions) {
  // Tolerate both a flat `spec.pages` and a nested `spec.spec.pages` shape —
  // the DM-spec GET response shape has been uncertain in this project (see
  // migrate-universe.mjs's own `spec.pages || spec.spec?.pages || []` hedge),
  // plus a bare `spec.elements` fallback for a flattened/no-pages response.
  const pages = spec.pages || spec.spec?.pages || [];
  const elements = pages.flatMap(p => p.elements || []);
  const all = elements.length ? elements : (spec.elements || []);
  const el = all.find(e => e.id === viewElementId);
  if (!el) throw new Error(`View element ${viewElementId} not found in DM spec`);
  el.metrics = el.metrics || []; el.columns = el.columns || []; el.order = el.order || [];
  const taken = new Set([...el.columns, ...el.metrics].map(x => x.name).filter(Boolean));
  const skipped = [];
  const add = (arr, item) => { if (taken.has(item.name)) { skipped.push(item.name); return false; } arr.push(item); taken.add(item.name); return true; };
  const addedMetrics = (additions.metrics || []).filter(m => add(el.metrics, m)).length;
  const addedColumns = (additions.columns || []).filter(c => { const ok = add(el.columns, c); if (ok) el.order.push(c.id); return ok; }).length;
  return { addedMetrics, addedColumns, skipped };
}
