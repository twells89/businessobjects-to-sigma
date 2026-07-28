# Webi Alerters → conditionalFormats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Webi threshold **alerters** into Sigma element-level `conditionalFormats` (`single` background/text-color rules) on tables & pivots; warn (don't emit) for unsupported effects/operators.

**Architecture:** Extend the `WebiBlock` IR with `alerters[]` (`normalizeBlock` + `walkRaylight`); add a `buildConditionalFormats` helper called from `blockToElement`'s table + crosstab branches (mirrors `buildGroupings` from #8). Confirm operator enums / text-color field / `Between` support live in the E2E round-trip gate.

**Tech Stack:** Node ≥18 ESM (`.mjs`), zero runtime deps, plain-`node` test scripts (`check(cond,msg)`), Sigma REST API.

## Global Constraints

- **Zero runtime dependencies.** Pure ESM `.mjs`, Node ≥18 built-ins. No new packages.
- **Single surface.** `converters/webi.mjs` + its tests + `scripts/e2e-webi-formula.mjs`. NOT the MCP/browser tool.
- **Preserve existing behavior.** A block with no alerters → byte-identical output (no `conditionalFormats` key). Existing suites (`smoke`, `webi-formula`, `webi-integration`, `dm-merge`) stay green.
- **Confirmed target shape** (sigma-workbooks `tables.md`, live-verified on `table`): element-level `conditionalFormats: [{ type:'single', columnIds:[colId], condition:'>'|'<'|…, value, style:{ backgroundColor:'#hex', <textColorField>:'#hex' } }]`.
- **Don't guess unconfirmed spec:** exact operator strings for `>= <= = <>`, the text-color style field name (`color` vs `fontColor`), and whether a native `between` exists are resolved LIVE in Task 3. Until confirmed, code the expected strings and let Task 3 adjust; `Between` warns+skips (never an over-coloring approximation).
- **Never throw** on a bad alerter (warn + skip).
- **No customer names** anywhere.
- **Branch + PR flow.** Work on `feat/webi-alerters-cf`; live E2E green before the completion commit.

## File Structure

- **Modify** `converters/webi.mjs` — IR capture in `normalizeBlock` + `walkRaylight`; new `buildConditionalFormats` helper + operator map; wire into table + crosstab branches; KPI/chart warn.
- **Modify** `test/webi-integration.test.mjs` — IR capture + conditionalFormats emission tests.
- **Modify** `scripts/e2e-webi-formula.mjs` — round-trip gate + resolve the three live unknowns.
- **Modify** `SKILL.md` — coverage row "Conditional formatting / alerters".

---

## Task 1: IR capture — `alerters` on the block

**Files:**
- Modify: `converters/webi.mjs` (`normalizeBlock`, `walkRaylight`, `WebiBlock` typedef)
- Test: `test/webi-integration.test.mjs`

**Interfaces:**
- Produces: each block gains `alerters: Array<{ name?, column, operator, value, value2?, style:{ backgroundColor?, color? }, unsupported?: string[] }>`. Absent → `[]`.

- [ ] **Step 1: Write the failing test** (append to `test/webi-integration.test.mjs`):

```js
// ── Alerter IR capture ───────────────────────────────────────────────────────
{
  const doc = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [
      { kind: 'VTable', title: 'T', dimensions: ['Customer Region'], measures: ['Net Revenue'],
        alerters: [
          { name: 'LowRev', column: 'Net Revenue', operator: '<', value: 100, style: { backgroundColor: '#ff0000', color: '#ffffff' } },
          { name: 'Ranged', column: 'Net Revenue', operator: 'between', value: 100, value2: 500, style: { backgroundColor: '#ffff00' } },
        ] },
    ] } ] } });
  const a = doc.reports[0].blocks[0].alerters;
  check(a.length === 2, `alerters captured (got ${a.length})`);
  check(a[0].column === 'Net Revenue' && a[0].operator === '<' && a[0].value === 100, 'rule 0 fields');
  check(a[0].style.backgroundColor === '#ff0000' && a[0].style.color === '#ffffff', 'rule 0 style');
  check(a[1].operator === 'between' && a[1].value2 === 500, 'range rule keeps value2');
  // raw Raylight path
  const raw = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', elements: [ { $type: 'VerticalTable', name: 'T',
      dataExpressions: [ { name: 'Net Revenue', qualification: 'measure' } ],
      alerters: [ { column: 'Net Revenue', operator: '>', value: 1000, style: { backgroundColor: '#00ff00' } } ] } ] } ] } });
  check(raw.reports[0].blocks[0].alerters.length === 1, 'walkRaylight captures alerters');
  // absent → []
  const none = normalizeWebiDocument({ document: { name: 'D', variables: [], filters: [], reports: [
    { name: 'R', blocks: [ { kind: 'VTable', dimensions: ['A'], measures: ['B'] } ] } ] } });
  check(Array.isArray(none.reports[0].blocks[0].alerters) && none.reports[0].blocks[0].alerters.length === 0, 'no alerters → []');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-integration.test.mjs`
Expected: FAIL — `alerters` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Update the `WebiBlock` typedef to add `alerters?:{name?:string,column:string,operator:string,value:any,value2?:any,style:{backgroundColor?:string,color?:string},unsupported?:string[]}[]`.

Add a normalizer helper near `nameList`/`sortList`:

```js
// Normalize a block's alerters (threshold rules). Each entry: a target column,
// one comparison operator + value(s), and a style. Sub-alerts/conditions that
// carry more than one condition are flagged in `unsupported` (Sigma `single`
// is one condition); border/size/content/image style props are flagged too.
function alerterList(arr) {
  return (arr || []).map(a => {
    if (!a || typeof a !== 'object') return null;
    const column = a.column || a.on || a.targetColumn || a.cell;
    const operator = (a.operator || a.op || a.condition || '').toString();
    if (!column || !operator) return null;
    const style = {};
    const bg = a.style?.backgroundColor || a.backgroundColor || a.background;
    const fg = a.style?.color || a.color || a.fontColor;
    if (bg) style.backgroundColor = bg;
    if (fg) style.color = fg;
    const unsupported = [];
    for (const k of ['border', 'fontSize', 'size', 'content', 'text', 'image']) {
      if (a[k] != null || a.style?.[k] != null) unsupported.push(k);
    }
    if (Array.isArray(a.conditions) && a.conditions.length > 1) unsupported.push('multi-condition');
    return { name: a.name, column, operator, value: a.value ?? a.operand ?? a.value1, value2: a.value2 ?? a.operand2, style, unsupported };
  }).filter(Boolean);
}
```

In `normalizeBlock`'s return, add: `alerters: alerterList(b.alerters || b.conditionalFormats || b.alerts),`
In `walkRaylight`'s pushed block, add: `alerters: alerterList(n.alerters || n.alerts),`

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-integration.test.mjs` then `npm test`
Expected: PASS — capture (both paths) + back-compat empties; full suite green.

- [ ] **Step 5: Commit**

```bash
git add converters/webi.mjs test/webi-integration.test.mjs
git commit -m "feat(webi): capture alerters in the block IR"
```

---

## Task 2: Emit `conditionalFormats` — helper + table/crosstab wiring

**Files:**
- Modify: `converters/webi.mjs` (new `buildConditionalFormats` + operator map; crosstab `colByName`; table + crosstab call; KPI/chart warn)
- Test: `test/webi-integration.test.mjs`

**Interfaces:**
- Consumes: block `alerters` (Task 1).
- Produces: table/pivot elements gain `conditionalFormats: [{ type:'single', columnIds:[colId], condition, value, style }]` per supported rule; unsupported/missing-column/unmappable-operator/`between` → warn + skip; no key when empty. KPI/chart with alerters → warn.

- [ ] **Step 1: Write the failing test** (append):

```js
// ── conditionalFormats emission ──────────────────────────────────────────────
{
  const mk = (blocks) => convertWebiToWorkbook({ document: { name: 'D', variables: [], filters: [], reports: [ { name: 'R', blocks } ] } },
    { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });

  // single threshold rule on a table → conditionalFormats entry
  const r = mk([{ kind: 'VTable', title: 'T', dimensions: ['Customer Region'], measures: ['Net Revenue'],
    alerters: [{ column: 'Net Revenue', operator: '<', value: 100, style: { backgroundColor: '#ff0000', color: '#ffffff' } }] }]);
  const tbl = r.workbook.pages[0].elements.find(e => e.kind === 'table');
  const netCol = tbl.columns.find(c => c.name === 'Net Revenue');
  check(Array.isArray(tbl.conditionalFormats) && tbl.conditionalFormats.length === 1, 'table gains one conditionalFormat');
  const cf = tbl.conditionalFormats[0];
  check(cf.type === 'single' && JSON.stringify(cf.columnIds) === JSON.stringify([netCol.id]), 'targets the resolved column id');
  check(cf.condition === '<' && cf.value === 100, 'operator + value mapped');
  check(cf.style.backgroundColor === '#ff0000' && cf.style.color === '#ffffff', 'style mapped');

  // operator map
  const ops = { '>':'>', '<':'<', '>=':'>=', '<=':'<=', '=':'=', '<>':'<>', 'greaterthan':'>', 'lessthan':'<', 'equalto':'=' };
  for (const [webi, sigma] of Object.entries(ops)) {
    const rr = mk([{ kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'],
      alerters: [{ column: 'Net Revenue', operator: webi, value: 5, style: { backgroundColor: '#0f0' } }] }]);
    const t = rr.workbook.pages[0].elements.find(e => e.kind === 'table');
    check(t.conditionalFormats?.[0]?.condition === sigma, `operator "${webi}" → "${sigma}" (got ${t.conditionalFormats?.[0]?.condition})`);
  }

  // crosstab/pivot also gets conditionalFormats
  const rp = mk([{ kind: 'CrossTab', title: 'P', rows: ['Customer Region'], cols: ['Order Channel'], measures: ['Net Revenue'],
    alerters: [{ column: 'Net Revenue', operator: '>', value: 1000, style: { backgroundColor: '#0f0' } }] }]);
  const piv = rp.workbook.pages[0].elements.find(e => e.kind === 'pivot-table');
  check(Array.isArray(piv.conditionalFormats) && piv.conditionalFormats.length === 1, 'pivot gains conditionalFormats');

  // between → warn + skip (no entry, no over-coloring)
  const rb = mk([{ kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'],
    alerters: [{ column: 'Net Revenue', operator: 'between', value: 100, value2: 500, style: { backgroundColor: '#ff0' } }] }]);
  const tb = rb.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('conditionalFormats' in tb), 'between → no conditionalFormats entry (v1)');
  check(rb.warnings.some(w => /between/i.test(w)), 'between → warned');

  // unsupported style + missing column → warn + skip
  const ru = mk([{ kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'],
    alerters: [{ column: 'Net Revenue', operator: '<', value: 1, border: '2px', style: { backgroundColor: '#f00' } },
               { column: 'Nope', operator: '<', value: 1, style: { backgroundColor: '#f00' } }] }]);
  const tu = ru.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(tu.conditionalFormats.length === 1, 'unsupported border rule still emits color part; missing-col skipped');
  check(ru.warnings.some(w => /border/i.test(w)) && ru.warnings.some(w => /Nope.*not a column|not a column.*Nope/i.test(w)), 'border + missing-column warned');

  // KPI with an alerter → warn, no crash
  const rk = mk([{ kind: 'Cell', title: 'K', measures: ['Net Revenue'], alerters: [{ column: 'Net Revenue', operator: '<', value: 1, style: { backgroundColor: '#f00' } }] }]);
  check(rk.warnings.some(w => /alerter/i.test(w) && /(kpi|cell|tables\/pivots)/i.test(w)), 'KPI alerter → warned');

  // no alerters → no key (back-compat)
  const rn = mk([{ kind: 'VTable', dimensions: ['Customer Region'], measures: ['Net Revenue'] }]);
  const tn = rn.workbook.pages[0].elements.find(e => e.kind === 'table');
  check(!('conditionalFormats' in tn), 'no alerters → no conditionalFormats key');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-integration.test.mjs`
Expected: FAIL — `tbl.conditionalFormats` undefined.

- [ ] **Step 3: Write minimal implementation**

Add the operator map + helper near `buildGroupings`:

```js
// Webi alerter operator → Sigma conditionalFormats `condition`. Symbols pass
// through; common word forms are mapped. (Exact Sigma strings for >=,<=,=,<>
// are confirmed live in the E2E — adjust here if the API differs.)
const CF_OP = {
  '>': '>', '<': '<', '>=': '>=', '<=': '<=', '=': '=', '==': '=', '<>': '<>', '!=': '<>',
  greaterthan: '>', lessthan: '<', greaterorequal: '>=', lessorequal: '<=',
  equalto: '=', notequalto: '<>', greaterthanorequal: '>=', lessthanorequal: '<=',
};
// Emit element-level `conditionalFormats` from a block's alerters. Mutates `el`.
// Only single-condition threshold rules with a mappable operator + a color
// produce an entry; `between`, unmappable operators, missing columns, and
// KPI/chart targets are warned and skipped. Border/size/content/image style
// props were flagged `unsupported` at ingest and are warned here.
function buildConditionalFormats(block, el, colByName, warnings) {
  const rules = block.alerters || [];
  if (!rules.length) return;
  const out = [];
  for (const r of rules) {
    for (const u of (r.unsupported || [])) warnings.push(`${el.name}: alerter "${r.name || r.column}" uses "${u}" — not representable in a Sigma conditional format; color part kept, "${u}" dropped.`);
    const op = r.operator?.toString().toLowerCase();
    if (r.value2 != null || op === 'between') { warnings.push(`${el.name}: alerter "${r.name || r.column}" uses a range/Between — not emitted (no single-condition Sigma equivalent); re-create in Sigma.`); continue; }
    const condition = CF_OP[r.operator] || CF_OP[op];
    if (!condition) { warnings.push(`${el.name}: alerter operator "${r.operator}" has no Sigma mapping — skipped.`); continue; }
    const cid = colByName.get(r.column) || colByName.get(displayName(r.column));
    if (!cid) { warnings.push(`${el.name}: alerter target "${r.column}" is not a column on the element — skipped.`); continue; }
    const style = {};
    if (r.style?.backgroundColor) style.backgroundColor = r.style.backgroundColor;
    if (r.style?.color) style.color = r.style.color;   // text-color field name confirmed live in E2E
    if (!Object.keys(style).length) { warnings.push(`${el.name}: alerter "${r.name || r.column}" has no color to apply — skipped.`); continue; }
    out.push({ type: 'single', columnIds: [cid], condition, value: r.value, style });
  }
  if (out.length) el.conditionalFormats = out;
}
```

Wire the **table** branch (after `buildGroupings(...)`):
```js
  buildConditionalFormats(block, el, colByName, warnings);
```

Refactor the **crosstab** branch to track `colByName`, build `el`, call the helper, then return:
```js
  if (block.kind === 'crosstab') {
    const cols = [], colByName = new Map();
    const rowIds = [], colIds_ = [], valIds = [];
    for (const d of (block.rows && block.rows.length ? block.rows.map(displayName) : dims)) { const id = uid('r'); cols.push({ id, name: d, formula: dimRef(d) }); rowIds.push(id); colByName.set(d, id); }
    for (const d of (block.cols || []).map(displayName)) { const id = uid('k'); cols.push({ id, name: d, formula: dimRef(d) }); colIds_.push(id); colByName.set(d, id); }
    for (const m of meas) { const id = uid('v'); const nm = displayName(m); cols.push({ id, name: nm, formula: measFormula(m) }); valIds.push(id); colByName.set(nm, id); }
    if (!rowIds.length && !colIds_.length) warnings.push(`Crosstab "${block.title || ''}" has no row/column axis — verify.`);
    const el = { id: uid('pivot'), kind: 'pivot-table', name: block.title || 'Crosstab', source: src,
      columns: cols, rowsBy: rowIds.map(id => ({ id })), columnsBy: colIds_.map(id => ({ id })), values: valIds };
    buildConditionalFormats(block, el, colByName, warnings);
    return el;
  }
```

In the **cell (KPI)** and **chart** branches, near their top, add:
```js
  if ((block.alerters || []).length) warnings.push(`Block "${block.title || block.kind}": alerter(s) on a ${block.kind} — Sigma conditional formatting applies to tables/pivots; re-create in Sigma.`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-integration.test.mjs` then `npm test`
Expected: PASS — single-rule emission, operator map, pivot support, between/unsupported/missing/KPI warns, back-compat; full suite green.

- [ ] **Step 5: Commit**

```bash
git add converters/webi.mjs test/webi-integration.test.mjs
git commit -m "feat(webi): emit conditionalFormats from alerters (tables + pivots)"
```

---

## Task 3: Live round-trip gate + resolve operators/style/Between + SKILL.md (COMMIT GATE)

**Files:**
- Modify: `scripts/e2e-webi-formula.mjs`, `converters/webi.mjs` (finalize per live findings), `SKILL.md`
- Uses: CSA.TJ conn `cb2f5180-641f-47bd-8efa-da9d590d855a`, folder `9ca9bf60-6a33-43dd-967d-1ba6352c54bb`, creds `set -a; . ~/.sigma-migration/env; set +a`.

**Interfaces:**
- Consumes: converter-emitted `conditionalFormats` (Task 2).

- [ ] **Step 1: Add a threshold alerter to the E2E fixture**

In `fixtures/e2e_webi_variables.json`, add an alerter to the summary table (e.g. `{ column: 'Net Revenue', operator: '>', value: 30000, style: { backgroundColor: '#c8e6c9', color: '#1b5e20' } }`). The converter emits `conditionalFormats` on that table.

- [ ] **Step 2: Round-trip assertion (the gate — no numeric tie-out for a format feature)**

After POSTing the workbook, `GET /v2/workbooks/{id}/spec` (YAML) and assert the `conditionalFormats` **persists**: the target column id, `condition`, `value`, and the `style` colors are present on the summary table element. Also keep the zero-error-column describe gate. Print ✅/❌; never fake green.

- [ ] **Step 3: Resolve the three live unknowns**

- **Operator strings:** POST a rule per operator (`> < >= <= = <>`) (or inspect the round-tripped spec) to confirm the exact accepted `condition` strings; adjust `CF_OP` values + the Task-2 operator test to the confirmed forms.
- **Text-color field:** POST a rule with a text color; GET back and confirm the field name (`color` vs `fontColor`); adjust `buildConditionalFormats` + a test.
- **`Between`:** probe whether a native range condition round-trips; if yes, wire it into `buildConditionalFormats` (+ replace the Task-2 between-warn test with an emission test); if no, keep warn+skip (record the finding).

- [ ] **Step 4: Run live to green + clean up**

Run: `set -a; . ~/.sigma-migration/env; set +a; node scripts/e2e-webi-formula.mjs`
Expected: conditionalFormats round-trip ✅ + all prior tie-outs still ✅ on real data; harness deletes all created objects on every exit path; folder verified clean.

- [ ] **Step 5: Offline suite + commit (only if live-green)**

Run: `npm test` (green).

```bash
git add scripts/e2e-webi-formula.mjs converters/webi.mjs test/webi-integration.test.mjs fixtures/e2e_webi_variables.json
git commit -m "test(webi): live conditionalFormats round-trip; finalize operators/style/Between"
```

- [ ] **Step 6: SKILL.md coverage row**

Update the `## Webi feature coverage` "Conditional formatting / alerters" row from 🟡 to 🟢/🟡 reflecting what shipped (single threshold color rules on tables/pivots auto; gradients/borders/size/content/KPI-cell warned; Between per the live finding). Commit.

---

## Self-Review

**Spec coverage:**
- IR capture of `alerters` (both paths) → Task 1. ✅
- `buildConditionalFormats` (single rules, operator map, color style, warn+skip for unsupported/missing/unmappable/between/KPI) → Task 2. ✅
- Table + crosstab wiring; crosstab `colByName` added → Task 2. ✅
- Back-compat (no alerters → no key; existing suites green) → Task 2 tests + `npm test`. ✅
- Live round-trip gate + resolve operators/style/Between → Task 3. ✅
- SKILL.md coverage row → Task 3 Step 6. ✅

**Placeholder scan:** none — Task 3's operator/style/Between are explicitly resolve-live with defined fallbacks (code the expected strings; Between warns until proven).

**Type consistency:** `alerterList` output shape (`{name,column,operator,value,value2,style,unsupported}`) is consumed identically by `buildConditionalFormats`. `buildConditionalFormats(block, el, colByName, warnings)` signature matches both call sites. Emitted entry shape (`{type:'single',columnIds,condition,value,style}`) matches the sigma-workbooks-verified target.

**Note for implementer:** the table branch already has `colByName` from #8 — reuse it; only the crosstab branch needs the map added. Do NOT add conditionalFormats to the chart branch (Sigma CF is table/pivot only) — chart/KPI alerters warn.
