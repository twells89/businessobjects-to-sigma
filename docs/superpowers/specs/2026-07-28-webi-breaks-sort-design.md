# Webi breaks / sections → grouping+subtotals, and sort carry-through — design

**Date:** 2026-07-28
**Status:** Approved (brainstorming) → pending implementation plan
**Component:** `businessobjects-to-sigma` skill repo — Webi → Sigma workbook layer (`converters/webi.mjs`)
**Builds on:** the Webi formula translator (PR #6) and coverage matrix (PR #7), both merged to `main`.

## Problem

The Webi → Sigma workbook converter emits table elements with a flat column list and **no `groupings`**, and carries **no sort order**. So a Webi table that uses **breaks** (group rows by a dimension with per-break subtotals) or **sections** (master-detail bands) migrates as an ungrouped detail dump, and any block **sort** is lost. This is the next-highest report-layer fidelity gap after formulas.

The Task-8 E2E harness already prototyped the target shape live (`groupBySum`), including two hard-won rules — this design **productionizes that logic into the converter**, driven by the Webi report's breaks/sort, and deletes the harness's manual version.

## Decisions (from brainstorming)

1. **Scope:** breaks → `groupings` + subtotals, and sort carry-through, are in v1. **Sections are approximated as an outer grouping** on the section dimension (same `groupings` mechanism) **+ a warning** that the band/master-detail visual isn't reproduced 1:1. Full section-band rebuild is deferred.
2. **Approach:** emit `groupings` inside `blockToElement` from new IR fields, with the grouping construction factored into a small helper (productionizing the harness `groupBySum`). Not a separate post-process pass.
3. **Two spec unknowns are resolved LIVE, not guessed** (see Open questions): the table **grand-total** property, and the correct location for sort on an **ungrouped** table.

## Verified facts carried from Task 8 (live-proved)

- Sigma table grouping shape: `groupings: [{ id, groupBy: [columnId…], calculations: [columnId…], sort: [{ columnId, direction }] }]`.
- **Sort lives INSIDE the `groupings[]` entry** — a top-level `table.sort` 400s ("Sort column not found") even for a valid column id.
- A **group-level running total** must be `CumulativeSum(Sum([col]))`, not the bare-column `CumulativeSum([col])` the formula translator emits for a flat column.
- `calculations` on a grouping entry are the per-group subtotals.

## Architecture

All changes in `converters/webi.mjs` + its tests + the E2E harness. Single surface (not mirrored to MCP/browser).

### 1. IR extension
`WebiBlock` gains:
- `breaks: string[]` — dimension display-names to group by, **outer→inner** order.
- `sort: Array<{ name: string, direction: 'ascending'|'descending' }>` — per-column sort.
- `sections: string[]` — section dimension names; folded in as the **outermost** break keys.

`normalizeBlock` (friendly shape) reads `b.breaks` / `b.sort` / `b.sections` (tolerant of aliases: `breakBy`/`sortBy`/`sectionBy`, string-or-object entries). `walkRaylight` (raw Raylight tree) best-effort parses break / sort / section nodes and pushes a warning naming the block when it finds a table it can't classify (RWS discovery is not live-tested — same posture as the formula work). Default when absent: empty arrays (today's behavior, unchanged).

### 2. Emit — `buildGroupings(tableEl, block, warnings)` helper
For a `table` element when `block.breaks`/`block.sections` is non-empty:
- Resolve each break/section name → the element's column id (by name; warn + skip if missing).
- Build the effective group key order = `sections` (outermost) then `breaks`.
- Emit `groupings` entries (one grouping carrying the full `groupBy` key list, mirroring the harness — a single entry with an ordered `groupBy`, `calculations` = all measure column ids, and `sort`). *(If live testing shows Sigma needs one entry per level, the helper produces the nested form instead — decided during implementation against the live API, not guessed here.)*
- **Running-total rewrite:** for each measure column whose formula matches bare-column `CumulativeSum([X])`, rewrite to `CumulativeSum(Sum([X]))` before adding it to `calculations`.
- `sort`: map `block.sort` → `[{ columnId, direction }]` inside the grouping entry (dimension/measure by name). If no explicit sort, default to ascending on the outermost group key (matches the harness).
- If a section was folded in, push a warning: `Section "<dim>" approximated as an outer grouping — the master-detail band layout is not reproduced 1:1.`

`blockToElement`'s table branch calls `buildGroupings` and attaches `groupings` when non-empty; crosstab/pivot already expresses grouping via `rowsBy` (breaks there are a no-op — note it). KPI/chart unaffected.

### 3. Grand totals & ungrouped sort — see Open questions (resolved live).

## Testing

**Offline unit** (`test/webi-integration.test.mjs` + `test/webi-formula.test.mjs` as fits):
- A block with `breaks:['Customer Region']` + measures → table gains a `groupings` entry with `groupBy=[regionColId]`, `calculations=[measureColIds]`.
- Running-total rewrite: a `CumulativeSum([Net Revenue])` calc inside a grouping becomes `CumulativeSum(Sum([Net Revenue]))`.
- Sort: `block.sort` → `sort` inside the grouping entry (right column id + direction); non-tautological (fails if placed top-level).
- Section: `sections:['Customer Region']` → outermost `groupBy` key **and** a warning is emitted.
- Missing break column → warn + skip, no throw.

**Live E2E** (`scripts/e2e-webi-formula.mjs`, the commit gate): drive a real broken + sorted table through the pipeline; assert real per-group **subtotal** values tie out to an independent raw grouped query, and the **sort order** is as requested. Then **delete the harness's manual `groupBySum`** and rely on the converter's groupings. Resolve both Open questions here.

## Open questions — resolved live during implementation (do NOT guess the spec)
1. **Grand total:** the harness only produced group subtotals; the Sigma table property for a **grand total** row is unconfirmed. v1 ships subtotals (verified). Grand-total: confirm the property live in the E2E and add it; if the shape isn't clean, defer with a warning ("grand total not emitted — add in Sigma").
2. **Sort on an ungrouped table:** a top-level `table.sort` 400s (Task-8 fact). For a table with sort but **no** break, the correct location (`columns[].sort`? an element-level sort?) must be confirmed live before claiming it works; until then, a sort-without-break emits a warning rather than a broken/guessed field.

## Non-goals (v1)
- Full section-band rebuild (repeated per-value layout, section headers).
- Sort on ungrouped tables *if* the live check doesn't surface a clean spec location (warn instead).
- Any MCP/browser mirror.

## Follow-on (not this spec)
- Alerters → conditional formats; filter-scope wiring; prompts → controls (remaining coverage-matrix gaps).
