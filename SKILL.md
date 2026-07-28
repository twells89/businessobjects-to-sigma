---
name: businessobjects-to-sigma
description: Migrate SAP BusinessObjects to Sigma Computing. Converts a universe (the semantic layer) into a Sigma data model and Web Intelligence (Webi) documents into Sigma workbooks, pulling both straight from the BI RESTful Web Service (RWS) on an on-prem BO 4.x server. Use when a user wants to move BusinessObjects content to Sigma, inventory a BO repository for a migration, or convert a universe / Webi document.
---

# BusinessObjects → Sigma

Two layers, one connection:

| BusinessObjects | Sigma | Converter |
|---|---|---|
| Universe (semantic layer) | Data model | `converters/bobj.mjs` (≡ MCP `convert_bobj_to_sigma`) |
| Web Intelligence document | Workbook | `converters/webi.mjs` |

The universe is pulled over HTTP from the **BI RESTful Web Service (RWS)**, or — when you need the actual warehouse columns and calculations — from a **Semantic Layer SDK / IDT export** (see the extraction-paths note below).

## Two extraction paths (the warehouse-columns gap)

> **The RWS REST endpoint returns only the business _outline_** — object names, datatypes, folders. It does **NOT** return each object's SELECT/WHERE (the calculation) or the data foundation (physical tables, columns, joins). That is an SAP design limit of the REST API — even 4.3 stops at the outline. If a customer shows you universe JSON with no real columns or SQL, that's expected, not a converter bug.

**Whether your input carries joins depends entirely on the file you feed it** — not JSON-vs-XML alone. The converter classifies the input and says so in its first warning (`Input format: …`); the join graph (and therefore the dimension columns a workbook can reach) only exists when the input carries a data foundation:

| The file you provide | Where it comes from | Carries joins? | → Result |
|---|---|---|---|
| **RWS outline JSON** | `GET /sl/v1/universes/{id}` (or `scripts/discover.mjs`) | ❌ **no** — outline only | Tables with **0 relationships**; a workbook sees only ONE table's columns (~the fact table). **Not enough for a real migration.** |
| **SL-SDK / IDT XML export** | `scripts/extract-universe-sdk.groovy` on a box with the SL SDK / IDT | ✅ **yes** — data foundation + joins | Full model: relationships + all columns. **Use this for an actual migration.** |
| **Extractor `--json`** | `extract-universe-sdk.groovy --json` | ✅ **yes** — same IR, JSON-encoded | Same as XML. |

If a multi-table universe converts to **0 relationships**, the converter now emits a loud guard warning naming the likely cause (outline-only input vs. unparseable/unmatched joins) — heed it before handing the model off, or the workbook will silently ship with only ~one table's columns.

## Relationship direction (why columns come back as "multiple values")

**How Sigma relationships work:** a relationship in a Sigma data model is a **many→one lookup**. The element that *owns* the relationship is the **"many" side** (the fact / most granular table); it looks up a **single** matching row on the **"one" side** (a dimension). The converter builds the denormalized **View** on that many-side source element, so a workbook binds to one row per fact row and pulls each dimension's attributes alongside.

**The failure mode:** if the relationship is built the wrong way round — source on the **"one"** side reaching into the **"many"** side — then every column looked up across the join matches *many* rows, and Sigma renders them as **"multiple values."** (Tell-tale sign: the base table's own columns show real values while everything reached across the join shows "multiple values.") This is *not* a data problem; it's a join-direction problem in the model.

**How the converter picks the direction** (from the data-foundation join's cardinality):

1. **Explicit cardinality** — recognized in the forms BO/IDT emit: `one-to-many`/`many-to-one`, `OneToMany`, `1-n`/`n-1`, `1:N`/`N:1`, `1..N`/`N..1`, `1..*`/`*..1`, and per-side `leftCardinality`/`rightCardinality` (or `*Multiplicity`) attributes/tags. The many side becomes the source.
2. **No cardinality in the export** — inferred from the star-schema shape: the **measure-bearing (fact) table is the many side**. If exactly one joined table carries measures, that side is made the source.
3. **Still ambiguous** (no cardinality *and* measures don't disambiguate) — the converter keeps the left table as source **and emits a warning** telling you to flip the relationship if columns come back as "multiple values." Never assume; verify.

**If you still see "multiple values"** on a delivered model, the relationship is pointing the wrong way: in the Sigma data model, flip it so the **source element is the many/fact table** (or re-export with cardinality so the converter gets it right). Make sure your SL-SDK / IDT export includes join cardinality — it's what removes the guesswork.

The converter **auto-detects** the input (a leading `<` ⇒ XML) and normalizes all three to the same IR, so `convert_bobj_to_sigma` / `converters/bobj.mjs` / the browser tool all accept any of them. To produce the SDK export, run the bundled extractor on a machine with the BO Client Tools / **Semantic Layer SDK** installed (it walks each object's `RelationalBinding` — `getSelect()/getWhere()/getTables()` — plus the data foundation), or export the data foundation + business layer from the Information Design Tool:

```
groovy -cp "$SL_SDK_LIB/*" scripts/extract-universe-sdk.groovy --unx /path/eFashion.unx --out universe.xml
node scripts/migrate-universe.mjs --file universe.xml      # convert + POST (no RWS login)
```

> The extractor is coded to the documented SL SDK API but has not been run against a live BO server from here — expect a getter name or two to need adjusting on first contact (4.1/4.2/4.3 vary). The XML→Sigma conversion path itself is verified end-to-end (`fixtures/efashion_universe.xml`).

## Prerequisites

1. **Network reachability.** RWS runs *on* the on-prem BO server (`https://<host>:6405/biprws`). Run this skill somewhere that can reach it — the customer's machine / VPN. A cloud runner behind no tunnel cannot.
2. **`.bo_env`** — copy `.bo_env.example`, fill BO credentials (`BO_USER`/`BO_PASSWORD`/`BO_AUTH`) and Sigma auth + target folder/connection. Then `set -a; . ./.bo_env; set +a`.
3. **A warehouse connection in Sigma** (`SIGMA_CONNECTION_ID`) pointing at the same database the universe's tables live on. The universe maps object SQL to physical tables; the data model binds them to this connection.

## Workflow

**Phase 1 — Connect & inventory**
```
node scripts/discover.mjs
```
Logs on, enumerates every universe and Webi document (typed RWS lists, with a CMS-query fallback), writes `inventory.json`. Use it to pick what to migrate first (start with the universes that the highest-value reports depend on).

**Phase 2 — Universe → data model** (do this before its reports)
```
node scripts/migrate-universe.mjs <universeId>
```
Fetches the universe, converts it (tables→elements, dimensions/details→columns with business names, measures→metrics, joins→relationships with FK keys parsed from the join SQL, predefined filters + `@`-functions→warnings), POSTs the data model, and records the binding (data-model id + denormalized **View** element + measure formulas) in `.bo-state.json`.

**Phase 2a — Target-layer remapping** (ALWAYS ask first; skip only if the answer is "no")

The universe references the *old* physical table/column names. If the customer is **not** doing a like-for-like migration — they've restructured the warehouse (renamed tables, or consolidated several dimensions into one, e.g. a "platinum"/gold layer) — those names won't resolve against the new layer, and the converted model binds to tables that no longer exist. So before running Phase 2, **ask the user**:

> "Has the warehouse been restructured relative to this universe — tables renamed, or dimensions consolidated (e.g. a platinum/gold layer)? Or does it still match the universe's original tables?"

- **No / it matches** → run Phase 2 as-is.
- **Yes, it was restructured** → build a remap and pass it with `--remap`:
  1. **List the universe's old physical names.** Run `node scripts/migrate-universe.mjs <id>` once (or convert offline) and read the element/column names — those are the old `TABLE` / `COL` tokens the remap is keyed on. The converter also warns on anything that doesn't resolve.
  2. **Get the new names.** Either (a) the user hands you the mapping / a list of the new platinum tables and columns, or (b) introspect the target Sigma connection — list its tables (`GET /v2/connections/{id}/inodes` / schema browse) and a table's columns (`GET /v2/connections/tables/{inodeId}/columns`) — then propose a best-guess mapping (match by normalized name) and **ask the user to confirm or correct it**. Don't silently guess; surface the proposed pairs and let them edit.
  3. **Write `remap.json`** and run:
     ```
     node scripts/migrate-universe.mjs <universeId> --remap remap.json
     ```
     ```json
     {
       "tableMap": {
         "CUSTOMER_DIM_DE": { "table": "DIM_CUSTOMER", "schema": "PLATINUM" },
         "CUSTOMER_DIM_AT": "DIM_CUSTOMER",
         "CUSTOMER_DIM_CH": "DIM_CUSTOMER"
       },
       "columnMap": {
         "CUSTOMER_DIM_DE.CUST_NAME": "CUSTOMER_NAME",
         "*.REGION": "SALES_REGION"
       }
     }
     ```
     `tableMap` values are a new table name or `{ table, database?, schema? }` to also relocate it; **many old tables may map to one** (consolidation — they collapse into a single element). `columnMap` keys are `"OLD_TABLE.OLD_COL"` (or `"*.OLD_COL"` for any table); business names are preserved, only the physical column underneath is repointed.
  4. **Re-run is cheap** — review the converter warnings: a summary line reports how many tables/columns were repointed and consolidated, and any `Remap: … matched no universe table/column` warning means a key typo (the old name didn't exist). Iterate until those are gone, then verify in Phase 4.

> The remap repoints **names**; it does not do the platinum-layer **remodeling** itself (consolidating grain, collapsing star schemas, blending brands). The output is a faithful first draft on the new physical names — `translate → enrich/combine → validate`. Set that expectation: the tool does the translate, the customer applies the platinum remodel on top.

(Agents with the MCP can pass the same maps as the `table_map` / `column_map` arguments to `convert_bobj_to_sigma` instead of the script flag.)

**Phase 3 — Webi document → workbook**
```
node scripts/migrate-webi.mjs <docId> --universe <universeId>
```
Fetches the Webi document, maps report tabs→pages, tables→tables, crosstabs→pivot-tables, charts→bar/line/pie, measure cells→KPIs, filters→controls. Binds every element to the universe's View element and references columns **qualified by the source element name** (`[Order Fact View/Net Revenue]`) so nothing self-references. POSTs the workbook.

Report **variables** (`/variables`) are translated by `converters/webi-formula.mjs` and **split by kind**: a context-free measure/dimension becomes a reusable **data-model addition** (`dataModelAdditions`) that `migrate-webi.mjs` patches into the bound View element (GET spec → merge → PUT) *before* creating the workbook; a layout/window-dependent one (`RunningSum`/`Previous`/`Rank`/`Percentage`, or an `In`/`ForEach`/`ForAll` context operator) stays a workbook calc column. A DM-placed **measure** variable is referenced in the workbook by its **inline re-aggregated formula** (`Sum([Order Fact View/Net Revenue]) / Sum([Order Fact View/Gross Revenue])`), *not* by the metric name — a data-model metric is not addressable as `[Element/MetricName]` from a workbook (that 400s "Dependency not found"); the metric still lands in the DM for reuse. Review the warnings for `NoFilter` (compute on a separate unfiltered element), `@Prompt`/`@Variable`/`@Select` (model as a control/parameter), and context operators (set the Sigma grouping/partition and verify) — these are surfaced, not silently applied.

**Phase 4 — Verify**
Query the saved objects (Sigma MCP `describe` + `query`, or the UI). The bar: real warehouse data, zero error-typed columns. Review every converter warning — predefined filters, `@Prompt`/`@Variable`/`@Select`/`@Aggregate_Aware`, and multi-table object SELECTs are surfaced for manual follow-up, not silently dropped. **If any looked-up column shows "multiple values,"** the relationship direction is wrong — see [Relationship direction](#relationship-direction-why-columns-come-back-as-multiple-values); flip the relationship so its source is the many/fact side.

## Webi feature coverage (what auto-converts vs. finish by hand)

Set expectations with this before promising a Webi migration, and use it as the manual-finish checklist after Phase 3. Legend: **🟢 auto** = the converters produce it working; **🟡 finish** = Sigma fully supports it but the agent rebuilds/wires it (the converter warns or emits a stub); **🔴 rebuild** = no direct path — re-model it. "Convert" here is agent-led: 🟡 items are expected finishing steps, not blockers.

**Formulas & aggregation**

| Webi | Status | What happens / what you do |
|---|---|---|
| Universe object SQL (SELECT, CASE, functions) | 🟢 | `bobj.mjs` maps functions, `CASE→If`; `@`-functions flagged |
| Report variables — arithmetic / string / date / `If` | 🟢 | `webi-formula.mjs` translates |
| `RunningSum` / `RunningCount` / `Previous` | 🟢 | → `CumulativeSum` / `CumulativeCount` / `Lag` (workbook calc column) |
| `Rank`, `Percentage` (% of total) | 🟢 | → `Rank`/`RankDense`, `PercentOfTotal` |
| Subtotals / grand totals | 🟡 | Sigma tables/pivots have native totals — enable on the element (not auto-set) |
| Calculation context `In` / `ForEach` / `ForAll` | 🟡 | Parsed + **warned**: set the element grouping / window partition to the named dims and verify |
| `NoFilter` | 🔴 | No direct equivalent — compute on a **separate unfiltered element** and reference it (warned) |
| Nested vars / % of a report grand total | 🟢 | Not viewport-limited: Sigma computes aggregates/window fns over the **whole** warehouse result, so "only x rows rendered" is a non-issue |

**Formatting & layout**

| Webi | Status | What happens / what you do |
|---|---|---|
| Table / crosstab / bar,line,pie,area,scatter,combo | 🟢 | mapped to table / pivot-table / matching chart; exotic viz → nearest Sigma equivalent |
| Sections & breaks | 🟢 / 🟡 | **breaks → table `groupings` + per-group subtotals, auto** (running totals rewritten to `CumulativeSum(Sum(...))`). **Sections** fold in as the **outermost** group key (+ warning — the master-detail band layout isn't reproduced 1:1). A report-level **grand total is not auto-emitted** (warned) — enable the table's Totals in Sigma. |
| Sorting | 🟢 | **carried automatically** — inside the grouping entry on a grouped/broken table (`groupings[].sort`), and as the element-level `sort` on an ungrouped table |
| Conditional formatting / alerters | 🟡 | Sigma `conditionalFormats` (rules, scales, data bars) — re-author |
| Colors / fonts / borders | 🟡 | themes + element formatting; not 1:1 (expect design-system normalization) |
| Embedded images / logos | 🟡 | Sigma image element — re-add |
| Hidden content + show/hide | 🟡 | hidden columns/elements; dynamic → conditional visibility on a control |
| Fold/unfold, Drill | 🟡 | native grouping expand/collapse + drill-down/drill-anywhere — wire, not auto-mapped |
| Report headers/footers, page numbers | 🟡 / 🔴 | top-of-page text/image elements + **export** header/footer & page numbers; no page numbers on the interactive canvas |
| Relative (top/left) positioning | 🟡 | Sigma is a responsive **grid + containers** — rebuilt to grid, not pixel-mapped |

**Filtering**

| Webi | Status | What happens / what you do |
|---|---|---|
| Report / table / section filters | 🟡 | document filters → **unbound list controls** (best-effort); wire target + default; scope re-created as page control vs element filter |
| Filter on a formula/variable, or on a measure | 🟡 | supported (calc-column filters; top-N / number-range / having) — set on the element |
| Input controls | 🟡 | → Sigma controls (list / dropdown / date / top-N) |
| Element links (ad-hoc cross-filter) | 🟡 | → cross-element filters / actions (control in spec, click-target wired in UI) |

**Query panel & query merge**

| Webi | Status | What happens / what you do |
|---|---|---|
| Custom SQL (override universe SQL) | 🟢 | → Sigma Custom SQL data element |
| Merged objects; union / inner / left outer | 🟡 | model in the **data model** (relationships = many→one lookup; union element). Right outer → reframe as left |
| Combined queries: Union / Intersect / Minus | 🟡 | Union native; Intersect/Minus via Custom SQL or semi/anti-join |
| Subqueries; database rankings | 🟡 | joins / CTEs / Custom SQL; `Rank` + top-N pushed to the warehouse |
| Prompts (`@Prompt`) | 🟡 | → Sigma controls/parameters (warned; can bind to filters or DM SQL) |
| Condition "In list from **another query**" | 🔴 | Sigma has **no `IsIn`-against-another-element** (it silently errors) — remodel as a join / semi-join |
| Non-universe Excel data provider | 🟡 | Sigma CSV/Excel upload as a source — wire manually |
| Query properties (refreshable, dup rows, trim) | 🟡 / n/a | data is live/refreshable; "distinct" toggle; `Trim`; some are Webi-only and safely dropped |

**Finish-by-hand checklist (per migrated report):** heed every converter warning (`NoFilter`, `@Prompt`/`@Variable`/`@Select`, context operators), then in Sigma: enable totals/subtotals, re-apply sort, re-author conditional formats/alerters, wire filter/control scope + element links, re-add images/headers, and confirm any `In`/`ForEach`/`ForAll` grouping. Crystal Reports, Xcelsius/Design Studio/Lumira are out of scope.

## Agent path (no scripts)

If you're an agent with the Sigma data-model MCP available, you can skip `converters/bobj.mjs` and call the `convert_bobj_to_sigma` tool directly on the universe JSON from `getUniverse()`, then POST via the Sigma REST skill. The script path is the self-contained equivalent.

## Scope & limits

- **RWS JSON carries no SELECTs / tables** — the REST outline has no relational bindings or data foundation, so columns and calculations can't come from it. The SL-SDK / IDT XML path (`extract-universe-sdk.groovy` → `ingestBobjSdkXml`, auto-detected) supplies them. Same converter core.
- **Universe contexts** (alternate join paths) — not yet modeled; relationships come from the join graph. Verify multi-fact routing.
- **Crystal Reports** — not covered by RWS (separate, proprietary). Out of scope.
- **`@`-functions & predefined filters** — emitted as warnings; re-author as Sigma controls/filters.
- **Status:** the converters are verified end-to-end against Sigma (POST + real-data query). The RWS *discovery* scripts are coded to the documented contract but have **not** been run against a live BO server yet — expect to adjust response-shape parsing on first contact (see comments in `scripts/bo-rws.mjs`).

Run `npm test` for an offline smoke test of both converters on the bundled fixtures.
