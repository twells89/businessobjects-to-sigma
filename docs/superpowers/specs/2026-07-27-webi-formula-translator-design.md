# Webi report-formula / variable translator — design

**Date:** 2026-07-27
**Status:** Approved (brainstorming) → pending implementation plan
**Component:** `businessobjects-to-sigma` skill repo (Webi → Sigma workbook layer)

## Problem

The BusinessObjects → Sigma skill has two converters:

| BObj layer | Sigma target | Converter | Maturity |
|---|---|---|---|
| Universe (semantic layer) | Data model | `converters/bobj.mjs` | Strong — translates object SELECTs, joins, measures |
| Web Intelligence document | Workbook | `converters/webi.mjs` | **Structural skeleton only** |

The Webi converter maps report tabs → pages and blocks → table/pivot/chart/KPI elements, but it reads **only each block's dimension/measure names**. It does **not** ingest or translate Webi's report-variable formula language, calculation contexts (`In`/`ForEach`/`ForAll`), or the layout family (`Previous`, `RunningSum`, `Rank`, `Percentage`). A migrated report therefore has the right shapes but not the right numbers wherever a report variable is involved — the single biggest fidelity gap in a BObj migration.

This spec adds a **Webi report-formula / variable translator** so those variables convert to working Sigma formulas.

## Key facts established during discovery

- **Raylight REST exposes formula text.** `GET /biprws/raylight/v1/documents/{id}/variables` lists variables; `GET .../variables/{varId}` returns `name`, `qualification` (Dimension/Measure/Detail), `dataType`, and `definition` (the actual formula, e.g. `=[Sales revenue]/[Quantity sold]`). Confirmed against SAP's RESTful Web Service Developer Guide (4.3). **No SL-SDK / `.wid` export is required for report formulas** — the same RWS logon token the skill already uses is sufficient. (This is unlike the universe side, where the REST outline omits SELECTs and the SDK export is needed.)
- The current pipeline (`scripts/bo-rws.mjs::getWebiDocument`) fetches `/reports`, `/reports/{rid}/elements`, and `/dataproviders` — but **not** `/variables`, and it discards element `dataExpression` formula text (keeps only the object name).
- The Webi converter is **skill-repo-only** — `converters/webi.mjs` is not mirrored to the MCP (`sigma-data-model-mcp`) or the browser tool. So this feature is a **single surface**, with a single offline smoke test plus the live E2E gate. No 3-way lockstep burden.
- Sigma target functions confirmed present (Sigma function index / window-functions docs): `CumulativeSum/Count/Max/Min`, `Lag`, `Lead`, `Rank`/`RankDense`/`RankPercentile`, `PercentOfTotal`, `RowNumber`, `Ntile`; aggregates `Sum/Count/CountDistinct/Avg/Min/Max/Median/Percentile/StdDev/Variance`; logical `If`/`Switch`/`Coalesce`/`IsNull`.

## Decisions (from brainstorming)

1. **Split by kind (target layer).** Context-free variables (reusable measures/dimensions, e.g. `Margin = Revenue/Cost`) → **data-model** metrics/calc columns (governed, reusable, tie out once). Context/layout-dependent variables (`RunningSum`, `Previous`, `Rank`, per-break `%`) → **workbook element** calc columns, where the element's grouping supplies the context they need.
2. **v1 scope = core + layout family.** Cover the high-frequency function set + the layout family; context operators best-effort; warn + stub the long tail. Not the full ~180-function index.
3. **Engine = small tokenizer + shallow recursive-descent rewriter** (not regex, not runtime LLM). The agent finishes only the warn+stub tail.
4. **End-to-end live test is a hard commit gate** — nothing merges until a real DM-patch + workbook POST queries real data and the calculated values tie out.

## Architecture

All changes live in the skill repo. Pieces:

### 1. Extraction — `scripts/bo-rws.mjs`
- Add `getWebiVariables(id)`: `GET /raylight/v1/documents/{id}/variables`; if the list omits `definition`, fetch each `.../variables/{varId}`. Returns `{ name, qualification, dataType, formula }[]`.
- Extend the report-element walk to **retain the raw `dataExpression` formula text** (in-place cell/column formulas that are not saved as named variables), not just the object name.
- Defensive to 4.1/4.2/4.3 shape variation, consistent with the existing RWS client (which is coded-but-not-yet-live-run).

### 2. IR extension — `converters/webi.mjs`
- `WebiDocument` gains `variables: WebiVariable[]` where `WebiVariable = { name, qualification: 'dimension'|'measure'|'detail', dataType, formula }`.
- `WebiBlock` columns gain an optional raw `formula` (from element `dataExpression`).

### 3. Translation engine — new module `converters/webi-formula.mjs`
- Public: `translateWebiFormula(formula, opts) → { sigma, kind: 'measure'|'dimension', placement: 'dm'|'workbook', warnings: string[] }`.
- Dep-free (matches repo style). Structure:
  - **Tokenizer** → `[Object]` refs, function identifiers, numbers, string literals, operators, punctuation, and the context keywords `In`/`ForEach`/`ForAll`.
  - **Shallow parser** → light AST: function calls, binary ops, refs, literals, and a *context clause* attached to an aggregate.
  - **Emitter** → walks the AST, applies the function map, renders Sigma formula text.
- **Function map (Tier 1 — direct):** `Average→Avg`, `Count(…;Distinct)→CountDistinct`, `If/Where→If`, `Concatenation/&→&`, `Substr→Mid`, `Pos→Search`, `Length→Len`, `Upper/Lower/Trim→same`, `Replace→Replace`, `FormatDate→Text`, `ToDate→Date`, `CurrentDate→Today`, `Abs/Round/Truncate→Abs/Round/Trunc`, `Sum/Count/Min/Max→same`.
- **Layout family (Tier 2 — forces `placement:'workbook'`):** `Previous→Lag`, `RunningSum→CumulativeSum`, `RunningCount→CumulativeCount`, `RunningAverage→cumulative+ratio`, `Rank→Rank`/`RankDense`, `Percentage→PercentOfTotal`.
- **Context operators (Tier 3):** the trailing clause `agg([M]) In ([D1];[D2])` → the dimension list becomes the grouping/partition argument of the Sigma aggregate/window function. `ForEach`/`ForAll` applied best-effort relative to the element grouping; **warn** when the element grouping is unknown at convert time.
- **Warn + stub (Tier 4):** `NoFilter`, unknown functions, `@`-functions → emit a calc column that preserves the **raw Webi formula in its `description`** plus a specific how-to warning (e.g. `NoFilter → compute on a separate unfiltered element`). Never throws; never emits a silently query-erroring column.

### 4. Placement classifier — `converters/webi.mjs`
- Mechanical rule: **any Tier-2 function or any context operator ⇒ `placement:'workbook'`; everything else ⇒ `placement:'dm'`.**

### 5. Output contract — `convertWebiToWorkbook`
- Returns, in addition to today's `{ workbook, warnings, stats }`, a new **`dataModelAdditions: { metrics: [...], columns: [...] }`** — the DM-bound (`placement:'dm'`) translations, to be merged into the View element.
- `webi.mjs` stays **pure**: it returns data and mutates nothing.

### 6. Wiring — `scripts/migrate-webi.mjs`
1. Fetch variables + report elements (with formulas); pass to `convertWebiToWorkbook`.
2. **Name resolution:** match block dim/measure names against variable names so a block column referencing a variable points at the right target (DM metric ref for `dm`; inline element calc for `workbook`).
3. **Apply `dataModelAdditions` first:** `GET` the Phase-2 DM spec → merge new metrics/columns into the **View element** (dedupe by name; skip any already present from the universe, with a warning) → `POST` the updated DM spec.
4. **Then** `POST` the workbook, so DM-bound refs resolve on creation.
- **Idempotency:** additions keyed by name; existing same-named metric/column on the View element is left as-is (warned skip). Re-runs stay cheap.

## Data flow

```
Raylight REST ──getWebiVariables + element formulas──▶ WebiDocument IR (+ variables[])
                                                              │
                                       translateWebiFormula (per variable)
                                                              │
                              ┌──────────────── classifier ───┴───────────────┐
                    placement:'dm'                                   placement:'workbook'
                              │                                                │
                   dataModelAdditions{metrics,columns}              workbook element calc columns
                              │                                                │
       migrate-webi: GET DM spec → merge into View → POST DM         (already in workbook spec)
                              └───────────────────┬────────────────────────────┘
                                            POST workbook
```

## Testing

### Unit (offline, dep-free) — `test/webi-formula.test.mjs` + extend `test/smoke.mjs`
- Table-driven per tier: Webi input → expected Sigma output string. Must include nested calls, `Sum([Rev]) In ([Region])`, `RunningSum`, `Percentage`, `NoFilter` (asserts stub + warning, not a silent mistranslation), and `@`-function passthrough.
- Assert the **classifier** buckets each variable correctly (`dm` vs `workbook`) and that `dataModelAdditions` vs workbook columns split correctly.
- Parser round-trip guard: a malformed formula degrades to a warned stub, never throws.

### Live E2E — the commit gate (nothing merges until green)
- Fixture Webi doc exercising all four tiers → full pipeline → **apply `dataModelAdditions` to a real data model, POST a real workbook, `describe` + `query` via the Sigma API** on the CSA.TJ connection.
- Assert: **zero error-typed columns** AND calculated values **tie out to expected numbers** (a known margin %, a running total, a rank order) — not merely "it posted."
- Clean up the test DM/workbook afterward.

## Error handling
- Every untranslatable formula → a *specific* warning carrying the raw Webi text + a how-to; the converter never throws on a bad formula and never emits a column that query-errors silently (the failure mode already fixed on the universe side).

## Non-goals (v1)
- The full ~180-function Webi index (only the high-frequency core + layout family).
- Full input/output-context + reset-dimension semantics of `ForEach`/`ForAll` (best-effort + warn).
- `NoFilter` auto-translation (no direct Sigma equivalent; documented manual pattern).
- Mirroring the Webi converter to the MCP / browser tool.
- Auto-detecting document-level query merges (separate item).

## Follow-on (not this spec)
- Bake the Webi feature-coverage matrix (Full / Partial / Not) into `SKILL.md` as a manual-finish checklist.
- Breaks/sections → grouping + subtotals; sort carry-through; alerters → conditionalFormats; prompt/control auto-wiring.
