# Webi Breaks/Sort → Grouping+Subtotals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Webi table **breaks** (and **sections**, approximated) into Sigma table `groupings` with per-group subtotals, and carry **sort** order through — productionizing the Task-8 E2E harness's `groupBySum` into the converter.

**Architecture:** Extend the `WebiBlock` IR (`normalizeBlock` + `walkRaylight`) with `breaks`/`sort`/`sections`; add a `buildGroupings` helper that `blockToElement`'s table branch calls to emit `groupings: [{ id, groupBy, calculations, sort }]` (subtotals = `calculations`, sort inside the entry, group-level running-total rewrite `CumulativeSum([X])→CumulativeSum(Sum([X]))`); sections fold in as the outermost group key + a warning. Verify live and delete the harness's manual grouping.

**Tech Stack:** Node ≥18 ESM (`.mjs`), zero runtime deps, plain-`node` test scripts using a `check(cond,msg)` helper, Sigma REST API.

## Global Constraints

- **Zero runtime dependencies.** Pure ESM `.mjs`, Node ≥18 built-ins only. No new packages. (Org rule: never a package version <3 days old — N/A here, no deps added.)
- **Single surface.** `converters/webi.mjs` + its tests + `scripts/e2e-webi-formula.mjs` only. Do NOT mirror to `sigma-data-model-mcp` or the browser tool.
- **Preserve existing behavior.** A block with no breaks/sort/sections must produce byte-identical output to today (no `groupings` key). The existing `smoke`, `webi-formula`, `webi-integration`, `dm-merge` suites stay green.
- **Verified shapes (from Task 8, do not re-derive):** `groupings: [{ id, groupBy:[colId], calculations:[colId], sort:[{columnId,direction}] }]`; sort lives INSIDE the grouping entry (top-level `table.sort` 400s); a group-level running total is `CumulativeSum(Sum([col]))`.
- **Don't guess unconfirmed spec shapes.** The table **grand-total** property and the location of sort on an **ungrouped** table are resolved live in Task 3; until confirmed, warn rather than emit a guessed field.
- **No customer names** anywhere (generic retail terms only).
- **Branch + PR flow.** Work on `feat/webi-breaks-sort`; do not push to `main`. Live E2E green before the commit that claims completion.

## File Structure

- **Modify** `converters/webi.mjs` — IR capture in `normalizeBlock` + `walkRaylight`; new `buildGroupings` helper; wire into `blockToElement` table branch.
- **Modify** `test/webi-integration.test.mjs` — IR-capture assertions (via `normalizeWebiDocument`) + groupings/sort/section/running-total assertions (via `convertWebiToWorkbook`).
- **Modify** `scripts/e2e-webi-formula.mjs` — replace the manual `groupBySum` with converter-emitted groupings; add a broken+sorted live tie-out (subtotals + sort order); resolve the two open questions.
- **Modify** `package.json` — only if a new test file is added (none planned; tests extend existing files).

---

## Task 1: IR capture — breaks / sort / sections on the block

**Files:**
- Modify: `converters/webi.mjs` (`normalizeBlock`, `walkRaylight`, the `WebiBlock` typedef)
- Test: `test/webi-integration.test.mjs`

**Interfaces:**
- Produces: each block from `normalizeWebiDocument(...).reports[].blocks[]` gains `breaks: string[]`, `sort: Array<{name:string, direction:'ascending'|'descending'}>`, `sections: string[]`. Absent inputs → empty arrays.

- [ ] **Step 1: Write the failing test** (append to `test/webi-integration.test.mjs`, before the summary):

```js
// ── Breaks / sort / sections IR capture ──────────────────────────────────────
import { normalizeWebiDocument } from '../converters/webi.mjs';
{
  const doc = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'T', dimensions: ['Customer Region', 'Order Channel'], measures: ['Net Revenue'],
        breaks: ['Customer Region'],
        sort: [{ name: 'Net Revenue', direction: 'descending' }],
        sections: ['Order Channel'] },
    ] } ] } });
  const b = doc.reports[0].blocks[0];
  check(JSON.stringify(b.breaks) === JSON.stringify(['Customer Region']), `breaks captured (got ${JSON.stringify(b.breaks)})`);
  check(b.sort.length === 1 && b.sort[0].name === 'Net Revenue' && b.sort[0].direction === 'descending', `sort captured (got ${JSON.stringify(b.sort)})`);
  check(JSON.stringify(b.sections) === JSON.stringify(['Order Channel']), `sections captured (got ${JSON.stringify(b.sections)})`);
  // absent → empty arrays (back-compat)
  const doc2 = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['A'], measures: ['B'] } ] } ] } });
  const b2 = doc2.reports[0].blocks[0];
  check(Array.isArray(b2.breaks) && b2.breaks.length === 0, 'no breaks → []');
  check(Array.isArray(b2.sort) && b2.sort.length === 0, 'no sort → []');
  check(Array.isArray(b2.sections) && b2.sections.length === 0, 'no sections → []');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-integration.test.mjs`
Expected: FAIL — `b.breaks` is `undefined` (normalizeBlock doesn't capture it).

- [ ] **Step 3: Write minimal implementation**

In `converters/webi.mjs`:

Update the typedef (line ~28-31) to add the fields:
```js
/** @typedef {{kind:'table'|'crosstab'|'chart'|'cell', title?:string,
 *   dimensions:string[], measures:string[], chartType?:string,
 *   rows?:string[], cols?:string[],
 *   breaks?:string[], sort?:{name:string,direction:string}[], sections?:string[],
 *   formulaByName?:Record<string,string>}} WebiBlock */
```

Add a shared helper near `displayName`:
```js
// Normalize a breaks/sections list (strings or {name}) → string[] of names.
function nameList(arr) {
  return (arr || []).map(x => (typeof x === 'string' ? x : (x && (x.name || x.label || x.dimension)))).filter(Boolean);
}
// Normalize a sort list (strings or {name,direction}) → [{name,direction}].
function sortList(arr) {
  return (arr || []).map(x => {
    const name = typeof x === 'string' ? x : (x && (x.name || x.label || x.column));
    const dir = (typeof x === 'object' && x && /desc/i.test(x.direction || x.order || '')) ? 'descending' : 'ascending';
    return name ? { name, direction: dir } : null;
  }).filter(Boolean);
}
```

In `normalizeBlock`'s returned object (after `formulaByName,`), add:
```js
    breaks: nameList(b.breaks || b.breakBy || b.breakOn),
    sort: sortList(b.sort || b.sortBy || b.orderBy),
    sections: nameList(b.sections || b.sectionBy || b.sectionOn),
```

In `walkRaylight`'s pushed block object (after `formulaByName,`), add (best-effort from the raw node; empty when absent):
```js
    breaks: nameList(n.breaks || n.breakBy),
    sort: sortList(n.sort || n.sortBy),
    sections: nameList(n.sections || n.sectionBy),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-integration.test.mjs`
Expected: PASS — capture + back-compat empties.

- [ ] **Step 5: Commit**

```bash
git add converters/webi.mjs test/webi-integration.test.mjs
git commit -m "feat(webi): capture breaks/sort/sections in the block IR"
```

---

## Task 2: Emit `groupings` — buildGroupings helper + table wiring

**Files:**
- Modify: `converters/webi.mjs` (new `buildGroupings`; call it in `blockToElement`'s table branch)
- Test: `test/webi-integration.test.mjs`

**Interfaces:**
- Consumes: block `breaks`/`sort`/`sections` from Task 1.
- Produces: a `table` element gains `groupings: [{ id, groupBy:[colId], calculations:[colId], sort:[{columnId,direction}] }]` when breaks/sections present; measure columns that are bare-column `CumulativeSum([X])` are rewritten in place to `CumulativeSum(Sum([X]))`; a table with sort but no break/section is left ungrouped with a warning (no guessed sort field). No `groupings` key when there are no breaks/sections.

- [ ] **Step 1: Write the failing test** (append to `test/webi-integration.test.mjs`):

```js
// ── Groupings emission (breaks → subtotals, sort, section, running-total) ─────
{
  const r = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'Summary', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        breaks: ['Customer Region'], sort: [{ name: 'Net Revenue', direction: 'descending' }] },
    ] } ] } }, { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl = r.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(Array.isArray(tbl.groupings) && tbl.groupings.length === 1, 'table gains one grouping');
  const g = tbl.groupings[0];
  const regionCol = tbl.columns.find(c => c.name === 'Customer Region');
  const netCol = tbl.columns.find(c => c.name === 'Net Revenue');
  check(g.groupBy.length === 1 && g.groupBy[0] === regionCol.id, 'groupBy = Customer Region column id');
  check(g.calculations.includes(netCol.id), 'calculations include the measure (subtotal)');
  check(g.sort.length === 1 && g.sort[0].columnId === netCol.id && g.sort[0].direction === 'descending', 'sort is inside the grouping, right col + direction');

  // running-total rewrite: a workbook RunningSum var → CumulativeSum([..]) → wrapped in Sum() inside a grouping
  const r2 = convertWebiToWorkbook({ document: { name: 'D', filters: [],
    variables: [{ name: 'Running Rev', qualification: 'measure', formula: '=RunningSum([Net Revenue])' }],
    reports: [ { name: 'R', blocks: [
      { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue', 'Running Rev'], breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl2 = r2.workbook.pages[0].elements.find(e => e.kind === 'table');
  const runCol = tbl2.columns.find(c => c.name === 'Running Rev');
  check(/^CumulativeSum\(Sum\(\[Order Fact View\/Net Revenue\]\)\)$/.test(runCol.formula), `group-level running total wrapped in Sum() (got ${runCol.formula})`);

  // section → outermost group key + warning
  const r3 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'S', dimensions: ['Customer Region', 'Order Channel'], measures: ['Net Revenue'],
        sections: ['Order Channel'], breaks: ['Customer Region'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl3 = r3.workbook.pages[0].elements.find(e => e.kind === 'table');
  const chanCol = tbl3.columns.find(c => c.name === 'Order Channel');
  const regionCol3 = tbl3.columns.find(c => c.name === 'Customer Region');
  check(JSON.stringify(tbl3.groupings[0].groupBy) === JSON.stringify([chanCol.id, regionCol3.id]), 'section is the OUTERMOST group key, then break');
  check(r3.warnings.some(w => /Section .*Order Channel.* outer grouping/i.test(w)), 'section emits the approximation warning');

  // no breaks/sections → no groupings key (back-compat)
  const r4 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl4 = r4.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('groupings' in tbl4), 'no breaks/sections → no groupings key');

  // sort without a break → ungrouped + warning (no guessed top-level sort)
  const r5 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', title: 'S', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        sort: [{ name: 'Net Revenue', direction: 'descending' }] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl5 = r5.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('groupings' in tbl5) && !('sort' in tbl5), 'sort without break → no grouping and no guessed sort field');
  check(r5.warnings.some(w => /sort .* no break|ungrouped .* sort/i.test(w)), 'sort-without-break warns');

  // missing break column → warn + skip, no throw
  const r6 = convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'], breaks: ['Nonexistent Dim'] } ] } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
  const tbl6 = r6.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('groupings' in tbl6), 'unresolvable break → no grouping');
  check(r6.warnings.some(w => /Nonexistent Dim.*not a column|break.*skipped/i.test(w)), 'unresolvable break warns');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-integration.test.mjs`
Expected: FAIL — `tbl.groupings` is undefined.

- [ ] **Step 3: Write minimal implementation**

In `converters/webi.mjs`, add the helper (after `blockToElement` or near it):

```js
// Build Sigma table `groupings` from a block's breaks/sections + sort.
// Productionizes the Task-8 E2E harness's groupBySum:
//   - group key order = sections (outermost) then breaks
//   - calculations = every measure column id (per-group subtotals)
//   - a bare-column CumulativeSum([X]) measure is rewritten to
//     CumulativeSum(Sum([X])) so a running total is correct at the group level
//   - sort lives INSIDE the grouping entry (a top-level table.sort 400s)
// Mutates `tableEl` (adds `.groupings`, may rewrite a measure column formula).
function buildGroupings(block, tableEl, colByName, measColIds, warnings) {
  const groupNames = [...nameList(block.sections).map(displayName), ...nameList(block.breaks).map(displayName)];
  const hasSort = (block.sort || []).length > 0;
  if (!groupNames.length) {
    if (hasSort) warnings.push(`Table "${tableEl.name}": sort present but no break/section — Sigma sort on an ungrouped table is not emitted (confirm the target and apply in Sigma).`);
    return;
  }
  const groupBy = [];
  for (const nm of groupNames) {
    const id = colByName.get(nm) || colByName.get(displayName(nm));
    if (!id) { warnings.push(`Table "${tableEl.name}": break/section "${nm}" is not a column on the table — skipped.`); continue; }
    groupBy.push(id);
  }
  if (!groupBy.length) return;
  // group-level running-total rewrite (bare-column CumulativeSum → wrap arg in Sum())
  for (const c of tableEl.columns) {
    const m = c.formula && c.formula.match(/^CumulativeSum\(\s*(\[[^\]]+\])\s*\)$/);
    if (m) c.formula = `CumulativeSum(Sum(${m[1]}))`;
  }
  // sort → inside the grouping entry; default ascending on the outermost key
  const sort = [];
  for (const s of (block.sort || [])) {
    const cid = colByName.get(s.name) || colByName.get(displayName(s.name));
    if (cid) sort.push({ columnId: cid, direction: s.direction === 'descending' ? 'descending' : 'ascending' });
    else warnings.push(`Table "${tableEl.name}": sort column "${s.name}" not found — skipped.`);
  }
  if (!sort.length) sort.push({ columnId: groupBy[0], direction: 'ascending' });
  tableEl.groupings = [{ id: `grp-${tableEl.id}`, groupBy, calculations: measColIds.slice(), sort }];
  const secs = nameList(block.sections);
  if (secs.length) warnings.push(`Section "${secs.join(', ')}" approximated as an outer grouping — the master-detail band layout is not reproduced 1:1.`);
}
```

Rewrite the table branch of `blockToElement` (lines ~410-415) to track a name→id map + measure column ids, then call the helper:

```js
  // default: table
  const cols = [], order = [], colByName = new Map(), measColIds = [];
  for (const d of dims) { const id = uid('c'); cols.push({ id, name: d, formula: dimRef(d) }); order.push(id); colByName.set(d, id); }
  for (const m of meas) { const id = uid('c'); const nm = displayName(m); cols.push({ id, name: nm, formula: measFormula(m) }); order.push(id); colByName.set(nm, id); measColIds.push(id); }
  if (!cols.length) return null;
  const el = { id: uid('tbl'), kind: 'table', name: block.title || 'Table', source: src, columns: cols, order };
  buildGroupings(block, el, colByName, measColIds, warnings);
  return el;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-integration.test.mjs` then `npm test`
Expected: PASS — groupings, running-total rewrite, section-outermost + warn, back-compat (no key), sort-without-break warn, missing-break warn; full suite green.

- [ ] **Step 5: Commit**

```bash
git add converters/webi.mjs test/webi-integration.test.mjs
git commit -m "feat(webi): emit table groupings+subtotals from breaks/sections + sort carry-through"
```

---

## Task 3: Live E2E tie-out + delete harness groupBySum + resolve open questions (COMMIT GATE)

**Files:**
- Modify: `scripts/e2e-webi-formula.mjs`
- Uses: CSA.TJ connection `cb2f5180-641f-47bd-8efa-da9d590d855a`, test folder `9ca9bf60-6a33-43dd-967d-1ba6352c54bb`, creds via `set -a; . ~/.sigma-migration/env; set +a`.

**Interfaces:**
- Consumes: converter-emitted `groupings` (Task 2). Removes the harness's manual `groupBySum`.

- [ ] **Step 1: Drive breaks/sort through the converter (not the harness)**

In the E2E fixture, put `breaks` + `sort` on the summary table block (e.g. `breaks: ['Customer Region']`, `sort: [{ name: 'Net Revenue', direction: 'descending' }]`, and the running-total measure `Running Revenue`). **Delete** the harness's `groupBySum` function and its two call sites — the converter now emits `groupings` directly. The workbook POST uses the converter output unchanged.

- [ ] **Step 2: Assert real tie-out (the gate)**

Keep/adapt the existing assertions and add:
- **Subtotals:** each region's group subtotal for `Net Revenue` equals an independent raw grouped query for that region (float tolerance).
- **Sort order:** the grouped rows come back sorted by the requested key/direction (assert the region order matches a sorted independent query).
- **Running total** stays monotonic (already asserted) — now driven by the converter's `CumulativeSum(Sum(...))`.
- Zero error-typed columns (existing describe gate).
Print each ✅/❌; never fake green.

- [ ] **Step 3: Resolve the two open questions live**

- **Grand total:** attempt to emit a table grand-total row; inspect the compiled result. If Sigma accepts a clean property, wire it into `buildGroupings` (a follow-up commit in this task) and assert the grand total ties out; if the shape isn't clean, leave subtotals-only and add a converter warning "grand total not emitted — add in Sigma" (documented in the report). Do NOT guess.
- **Ungrouped sort:** try the plausible spec location for sort on a table with no break (e.g. `columns[].sort` or an element sort); if one resolves live, replace the Task-2 warn with the real field (in `buildGroupings`) + a test; if none resolves cleanly, keep the warn. Record the finding.

- [ ] **Step 4: Run it live to green + clean up**

Run: `set -a; . ~/.sigma-migration/env; set +a; node scripts/e2e-webi-formula.mjs`
Expected: all tie-out assertions ✅ on real data; the harness deletes every object it created on every exit path; confirm no leftover `E2E Webi Formula Tie-Out` / `Retail Universe (CSA.TJ)` in the test folder.

- [ ] **Step 5: Offline suite + commit (only if live-green)**

Run: `npm test` (must stay green).

```bash
git add scripts/e2e-webi-formula.mjs converters/webi.mjs test/webi-integration.test.mjs
git commit -m "test(webi): live tie-out for breaks/subtotals+sort; drop harness groupBySum"
```

- [ ] **Step 6: SKILL.md coverage matrix bump**

Update the two rows in `SKILL.md`'s coverage matrix: **Sections & breaks** and **Sorting** move from 🟡 to 🟢/🟡 as warranted by what shipped (breaks→groupings+subtotals now auto; sort inside a grouping auto; ungrouped sort + grand total per the live findings). Keep it accurate to the delivered behavior. Commit.

---

## Self-Review

**Spec coverage:**
- IR capture of breaks/sort/sections → Task 1. ✅
- `buildGroupings` (subtotals, sort-in-grouping, running-total rewrite, section→outer key+warn, missing-col warn, sort-without-break warn) → Task 2. ✅
- Back-compat (no breaks → no groupings key, existing suites green) → Task 2 tests + `npm test`. ✅
- Live tie-out (subtotals + sort order) + delete harness groupBySum → Task 3. ✅
- Open questions (grand total, ungrouped sort) resolved live, not guessed → Task 3 Step 3. ✅
- Coverage-matrix bump → Task 3 Step 6. ✅

**Placeholder scan:** none — Task 3's grand-total/ungrouped-sort are explicitly conditional-on-live-finding, not TBDs; each has a defined fallback (warn).

**Type consistency:** `nameList`/`sortList` shapes used identically in Task 1 (IR) and Task 2 (`buildGroupings`). `buildGroupings(block, tableEl, colByName, measColIds, warnings)` signature matches its call site. `groupings` entry shape (`{id, groupBy, calculations, sort:[{columnId,direction}]}`) matches the Task-8-verified shape used in the tests.

**Note for implementer:** crosstab/pivot already expresses grouping via `rowsBy`; breaks/sections there are a deliberate no-op (only the `table` branch calls `buildGroupings`). Don't add grouping to the crosstab branch.
