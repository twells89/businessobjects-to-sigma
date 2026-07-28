# Webi alerters → Sigma conditionalFormats — design

**Date:** 2026-07-28
**Status:** Approved (brainstorming) → pending implementation plan
**Component:** `businessobjects-to-sigma` skill repo — Webi → Sigma workbook layer (`converters/webi.mjs`)
**Builds on:** formula translator (#6), coverage matrix (#7), breaks/sort (#8), all merged to `main`.

## Problem

Webi **alerters** — named threshold rules that color/format cells when a condition holds (e.g. "background red when Margin < 0") — are not converted. A migrated report loses all conditional coloring. This is the next coverage-matrix gap after breaks/sort.

Sigma's target is the element-level **`conditionalFormats`** array (verified live on `table`/`pivot-table` in the sigma-workbooks spec), with a `single` threshold variant: `{ type:'single', columnIds:[colId], condition, value, style:{ backgroundColor, color } }`.

## Decisions (from brainstorming)

1. **Scope:** map single-condition alerters (operators `> < >= <= = <>`) → Sigma `single` conditionalFormats with **background + text color**, on **tables & pivots**. Unsupported → **warn, don't emit**: border/font-size/cell-content/image formats, multi-condition-AND sub-alerts, KPI-cell alerters.
2. **`Between`:** do NOT ship the over-coloring two-rule approximation. Use Sigma's native range/between condition **if it exists** (confirmed live); otherwise **warn + skip** the Between rule (honest gap).
3. **Approach:** a `buildConditionalFormats` helper called from `blockToElement`'s table + crosstab branches — mirrors the `buildGroupings` pattern from #8.
4. **Live-verify, don't guess:** the exact operator enum strings, the text-color style field name, and `Between` support are confirmed against the live API in the E2E task.

## Architecture

All in `converters/webi.mjs` + tests + `scripts/e2e-webi-formula.mjs`. Single surface.

### 1. IR extension
`WebiBlock` gains `alerters: Array<AlerterRule>` where
`AlerterRule = { name?: string, column: string, operator: string, value: string|number, value2?: string|number, style: { backgroundColor?: string, color?: string }, unsupported?: string[] }`.

- `normalizeBlock` (friendly) reads `b.alerters` (tolerant: an alerter with N sub-alerts / conditions flattens to N rules; each rule targets one `column` with one `operator`+`value`; `value2` only for a range/between). A multi-condition-AND sub-alert is captured as one rule flagged in `unsupported`.
- `walkRaylight` (raw Raylight) best-effort parses alerter nodes; warn when unrecognized.
- Absent → `[]` (back-compat: no `conditionalFormats` key emitted).

### 2. `buildConditionalFormats(block, el, colByName, warnings)` helper
Mutates `el` (adds `.conditionalFormats` when non-empty). Per rule:
- Resolve `column` → colId via `colByName`; **warn + skip** if missing.
- Map operator → Sigma `condition` (exact strings confirmed live in the E2E; expected `>`,`<`,`>=`,`<=`,`=`,`<>`).
- Emit `{ type:'single', columnIds:[colId], condition, value, style }` where `style` carries `backgroundColor` and/or text color (field name confirmed live).
- `Between` (`value`+`value2`): native range condition if confirmed live, else warn+skip.
- Rule flagged `unsupported` (multi-condition, border/size/content/image, KPI-cell) → warn, emit nothing for that rule.
- Multiple rules → multiple `conditionalFormats` entries (independent — this is correct for independent threshold rules).

### 3. Wiring
`blockToElement` table branch already builds `colByName` (#8). Add the same `colByName` tracking to the **crosstab** branch. Both call `buildConditionalFormats(block, el, colByName, warnings)` and attach `conditionalFormats` when non-empty. KPI/chart branches: if `block.alerters` is non-empty, warn "alerter on a <kind> — conditional formatting applies to tables/pivots; re-create in Sigma."

## Testing

**Offline unit** (`test/webi-integration.test.mjs`):
- IR capture in BOTH `normalizeBlock` and `walkRaylight` (a raw `.elements` doc).
- Operator mapping (`> < >= <= = <>`) → correct Sigma `condition`.
- `single` entry shape: `columnIds`=[the resolved colId], `value`, `style.backgroundColor`/text color.
- Unsupported format / multi-condition / KPI-cell alerter → warn, no entry.
- `Between` → per the live finding (native condition OR warn+skip); test asserts whichever shipped.
- Missing target column → warn + skip, no throw.
- Back-compat: no alerters → no `conditionalFormats` key.

**Live E2E gate** (`scripts/e2e-webi-formula.mjs`): a format feature has no numeric tie-out, so the gate is **round-trip persistence**: add a threshold alerter to the summary table fixture → POST the workbook → **GET `/spec` back and assert the `conditionalFormats` entry persists** (right columnId, condition, value, style), zero error-typed columns, cleanup. This is also where operator strings / style field / `Between` support are confirmed and the emitter finalized.

## Open questions — resolved live during implementation (do NOT guess)
1. **Operator enum strings** — spec shows `>`,`<`; confirm `>=`,`<=`,`=`,`<>` (and whether a native `between`/range exists) against the live API; adjust the operator map + a test to the confirmed strings.
2. **Text-color style field** — `backgroundColor` confirmed; confirm whether text color is `color` or `fontColor` (whichever round-trips on GET).
3. **`Between`** — native range condition if it round-trips; else warn+skip (no over-coloring approximation).

## Non-goals (v1)
- Gradient/scale alerters → `backgroundScale`/`fontScale`; data bars; KPI-value conditional color.
- Border / font-size / cell-content / image alerter effects (no Sigma CF equivalent — warned).
- Multi-condition-AND sub-alerts as a single rule (warned).
- Any MCP/browser mirror.

## Follow-on (not this spec)
- Gradient/scale alerters; filter-scope wiring; prompts → controls (remaining coverage-matrix gaps).
