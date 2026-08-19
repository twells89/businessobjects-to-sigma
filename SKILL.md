---
name: businessobjects-to-sigma
description: Migrate SAP BusinessObjects to Sigma Computing. Converts universes into Sigma data models, Web Intelligence documents into workbooks, and Crystal Reports into pixel-perfect Sigma reports. Uses RWS for universes/Webi, SAP SDK or CMS/RAS for Crystal, and preserves unsupported constructs in explicit warnings/degradation ledgers. Use when inventorying or migrating a BO repository, universe, Webi document, or Crystal .rpt.
---

# BusinessObjects → Sigma

Three target resources:

| BusinessObjects | Sigma | Converter |
|---|---|---|
| Universe (semantic layer) | Data model | `converters/bobj.mjs` (≡ MCP `convert_bobj_to_sigma`) |
| Web Intelligence document | Workbook | `converters/webi.mjs` |
| Crystal Report | Pixel-perfect report | `converters/crystal.mjs` |

Universe/Webi use the **BI RESTful Web Service (RWS)** (or an SL-SDK/IDT
universe export). Crystal definitions are separate: use the official Crystal
.NET SDK for loose `.rpt` files or BI Platform Java SDK/RAS for CMS content.
The `rpt-rs` path is an experimental Linux smoke path, not the production
extraction contract.

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
4. **Crystal extractor runtime (Crystal only).** Loose `.rpt`: Windows x64 +
   matching Crystal Reports for Visual Studio SDK assemblies. CMS: BI Platform
   Java SDK/RAS jars and CMS reachability. Do not redistribute SAP binaries.
5. **Sigma report permission (Crystal only).** The API principal must be able to
   create/edit/export reports in `SIGMA_FOLDER_ID`. Report creation currently
   has no API cleanup—verify first and create only in an approved folder.
6. **Snowflake seed (public proof only).** Install
   `requirements-crystal.txt`; provide the five `SNOWFLAKE_*` key-pair
   variables from `.bo_env.example`.

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

> **Workbook code-rep wire shape (required since 2026-08).** `POST /v2/workbooks/spec` (and verify / PUT) no longer accepts a flat `{ name, folderId, schemaVersion, pages:[{elements}] }` body — that hard-400s. The live contract is:
> ```
> { name, folderId, document: {
>     schemaVersion, kind: "workbook",
>     pages: [/* metadata only — no nested elements */],
>     elements: [/* flat array of every element */],
>     layout: "<!-- XML: <Page id>…<Element elementId>… -->"
> } }
> ```
> `document.kind: "workbook"` is required. Every element must be placed in `document.layout` (`<Element>` / `<Container>` tags; not the legacy `<LayoutElement>` / `<GridContainer>` aliases). The data-model surface (`/v2/dataModels/.../spec`) is **unchanged** and stays flat — do not wrap DM payloads.
>
> The Webi converter still returns the convenient nested `pages[].elements` shape for local use. **`scripts/sigma.mjs` `postWorkbook` always runs `prepareWorkbookForPost`** (`scripts/code_rep.mjs`) before the HTTP call: it flattens elements, sets `kind`, synthesizes a stacked full-width `layout` when missing, and wraps under `document`. If you POST a workbook by hand (agent path / curl), call `prepareWorkbookForPost` first — or build the wrapped shape yourself. Never POST the raw converter object.

Report **variables** (`/variables`) are translated by `converters/webi-formula.mjs` and **split by kind**: a context-free measure/dimension becomes a reusable **data-model addition** (`dataModelAdditions`) that `migrate-webi.mjs` patches into the bound View element (GET spec → merge → PUT) *before* creating the workbook; a layout/window-dependent one (`RunningSum`/`Previous`/`Rank`/`Percentage`, or an `In`/`ForEach`/`ForAll` context operator) stays a workbook calc column. A DM-placed **measure** variable is referenced in the workbook by its **inline re-aggregated formula** (`Sum([Order Fact View/Net Revenue]) / Sum([Order Fact View/Gross Revenue])`), *not* by the metric name — a data-model metric is not addressable as `[Element/MetricName]` from a workbook (that 400s "Dependency not found"); the metric still lands in the DM for reuse. Review the warnings for `NoFilter` (compute on a separate unfiltered element), `@Prompt`/`@Variable`/`@Select` (model as a control/parameter), and context operators (set the Sigma grouping/partition and verify) — these are surfaced, not silently applied.

**Phase 3b — Crystal Report → Sigma pixel-perfect report**

Choose one extraction path:

```powershell
# Supported loose-file path (Windows + customer-licensed SAP SDK)
dotnet build tools\crystal-extractor\CrystalExtractor.csproj -c Release
crystal-extractor.exe report.rpt --out report.crystal-ir.json --pdf report.crystal.pdf
```

```bash
# CMS/RAS path (BI Platform Java SDK jars)
groovy -cp "$BO_SDK_LIB/*" scripts/extract-crystal-cms.groovy \
  --cms "$BO_CMS" --user "$BO_USER" --password "$BO_PASSWORD" \
  --auth "$BO_AUTH" --id <SI_ID> --out-dir artifacts/crystal/cms

# Linux smoke path only (experimental reverse-engineered rpt-rs)
RPT_RS_BIN=/path/to/rpt node scripts/extract-crystal-rpt-rs.mjs report.rpt \
  --out report.crystal-ir.json
```

All three emit the versioned
`schemas/crystal-report-ir.schema.json` contract. Never extract credentials into
the IR. For the pinned Meridian proof:

```bash
pip install -r requirements-crystal.txt
python3 scripts/seed-crystal-snowflake.py
node scripts/migrate-crystal.mjs --ir report.crystal-ir.json
# The previous command writes artifacts + calls /verify only.
node scripts/migrate-crystal.mjs --ir report.crystal-ir.json --create --pdf report.pdf
```

Persistent report creation has no API cleanup. Confirm `SIGMA_FOLDER_ID`, then
pass `--create` only with explicit approval.

> **Report code-rep wire shape.** Reports use the same outer wrapper as current
> workbooks but a different document and layout language:
> ```
> { name, folderId, document: {
>     schemaVersion, kind: "report",
>     config: { pageWidth, pageHeight, margin },
>     pages: [/* metadata only */],
>     panels: [/* header/footer metadata */],
>     elements: [/* flat */],
>     layout: "<Page id=\"…\"><Element x=\"…\" y=\"…\" width=\"…\" height=\"…\"/></Page>…"
> } }
> ```
> Do not route reports through `scripts/code_rep.mjs`: workbook grid attributes,
> containers/tabs/overlays, and page-break elements are invalid. Use
> `scripts/report-code-rep.mjs` + `scripts/sigma-report.mjs`.

The first tested profile targets the Meridian customer statement. The seeder
creates `CRYSTAL_MIGRATION_DEMO.PUBLIC.CUSTOMER_STATEMENT_ROWS`; the report
binds directly through a live-proven `warehouse-table` source. This avoids
pretending the existing one-hop relationship View is a lossless replacement
for Crystal's eight-table join graph.

**Phase 4 — Verify**
For DMs/workbooks, query the saved objects (Sigma MCP `describe` + `query`, or
the UI): real warehouse data and zero error-typed columns. For reports require
all four gates: offline validation, `/v2/reports/spec/verify`, GET readback +
element query/inventory comparison, and PDF export/visual inspection against
the Crystal SDK PDF oracle. Review every warning/degradation. **If a looked-up
column shows "multiple values,"** fix relationship direction as described
above.

## Webi feature coverage (what auto-converts vs. finish by hand)

Set expectations with this before promising a Webi migration, and use it as the manual-finish checklist after Phase 3. Legend: **🟢 auto** = the converters produce it working; **🟡 finish** = Sigma fully supports it but the agent rebuilds/wires it (the converter warns or emits a stub); **🔴 rebuild** = no direct path — re-model it. "Convert" here is agent-led: 🟡 items are expected finishing steps, not blockers.

**Formulas & aggregation**

| Webi | Status | What happens / what you do |
|---|---|---|
| Universe object SQL (SELECT, CASE, functions) | 🟢 | `bobj.mjs` maps functions, `CASE→If`; `@`-functions flagged |
| Report variables — arithmetic / string / date / `If` | 🟢 | `webi-formula.mjs` translates |
| `RunningSum` / `RunningCount` / `Previous` | 🟢 | → `CumulativeSum` / `CumulativeCount` / `Lag` (workbook calc column) |
| `Rank`, `Percentage` (% of total) | 🟢 | → `Rank`/`RankDense`, `PercentOfTotal` |
| Subtotals (per break) / grand totals | 🟢 / 🟡 | Per-group **subtotals** auto-emitted from Webi breaks (see Formatting → Sections & breaks); a table **grand total** is not auto-emitted (Sigma UI footer) — add in Sigma |
| Calculation context `In` / `ForEach` / `ForAll` | 🟡 | Parsed + **warned**: set the element grouping / window partition to the named dims and verify |
| `NoFilter` | 🔴 | No direct equivalent — compute on a **separate unfiltered element** and reference it (warned) |
| Nested vars / % of a report grand total | 🟢 | Not viewport-limited: Sigma computes aggregates/window fns over the **whole** warehouse result, so "only x rows rendered" is a non-issue |

**Formatting & layout**

| Webi | Status | What happens / what you do |
|---|---|---|
| Table / crosstab / bar,line,pie,area,scatter,combo | 🟢 | mapped to table / pivot-table / matching chart; exotic viz → nearest Sigma equivalent |
| Sections & breaks | 🟢 / 🟡 | **breaks → table `groupings` + per-group subtotals, auto** (running totals rewritten to `CumulativeSum(Sum(...))`). **Sections** fold in as the **outermost** group key (+ warning — the master-detail band layout isn't reproduced 1:1). A report-level **grand total is not auto-emitted** (warned) — enable the table's Totals in Sigma. |
| Sorting | 🟢 | **carried automatically** — inside the grouping entry on a grouped/broken table (`groupings[].sort`), and as the element-level `sort` on an ungrouped table |
| Conditional formatting / alerters | 🟢 / 🟡 | **Single-threshold color alerters → element-level `conditionalFormats` on tables & pivots, auto** (operators `>` `<` `>=` `<=` `=` `!=`; background + text `color`; round-trip-confirmed live on **both `table` and `pivot-table` elements** — CSA.TJ E2E). **Warned + skipped (re-author in Sigma):** `Between`/ranges (Sigma has **no native two-bound** conditional format on the spec path — confirmed live), gradient/`backgroundScale`/`fontScale`/data-bar scales, border / font-size / content / image effects, multi-condition alerters, and KPI-cell / chart alerters (Sigma CF is table/pivot only). |
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
| Condition "In list from **another query**" | 🟡 | Semi-join / `IN (subquery)` — what BObj compiles to — runs verbatim in a **Custom SQL** element (or a join). Only *no-code* gap: no "is-in another element" filter / formula-level `IsIn` against another element (that errors). Same connection; cross-connection → blend |
| Non-universe Excel data provider | 🟡 | Sigma CSV/Excel upload as a source — wire manually |
| Query properties (refreshable, dup rows, trim) | 🟡 / n/a | data is live/refreshable; "distinct" toggle; `Trim`; some are Webi-only and safely dropped |

**Finish-by-hand checklist (per migrated Webi report):** heed every converter warning (`NoFilter`, `@Prompt`/`@Variable`/`@Select`, context operators), then in Sigma: enable totals/subtotals, re-apply sort, re-author only the WARNED conditional formats/alerters (ranges/`Between`, gradients/scales, borders, KPI-cell — single-threshold color rules convert automatically), wire filter/control scope + element links, re-add images/headers, and confirm any `In`/`ForEach`/`ForAll` grouping. Xcelsius/Design Studio/Lumira remain out of scope.

## Crystal feature coverage

| Crystal construct | Status | Output / finish |
|---|---|---|
| `.rpt` definition + page/printer settings | 🟢 | SAP SDK IR; rpt-rs smoke oracle |
| CMS definitions / scheduled instances | 🟢 | CMS query + RAS; `SI_INSTANCE=0` only |
| A4/Letter dimensions, margins, absolute geometry | 🟢 | twips ÷ 15 → Sigma report pixels; PDF-check rounding |
| Page header/footer | 🟢 | report header/footer panels |
| Detail band fields | 🟢 | report table over live warehouse source |
| Groups/sorts/summaries | 🟢 / 🟡 | table grouping/calculation + KPI; inspect pagination/totals |
| Formula refs, arithmetic, `IIf`/`If`, null/string/date/common aggregates | 🟢 / 🟡 | translated subset; every warning preserves source |
| Record/group selection + parameters | 🟡 | preserved; wire non-synced controls/filter scope after targeted verify |
| Conditional suppress/color/format | 🟡 | inventory preserved; map only verified Sigma report shapes |
| Lines/boxes | 🟡 | normalize into table/page styling |
| Embedded/dynamic images | 🟡 | emit only with portable URL/upload handle; otherwise ledger |
| Subreports | 🟡 | recursively extracted; first profile uses manual/static fallback |
| Crosstabs/charts | 🟡 | use report support matrix + targeted verify/readback/PDF |
| `WhilePrintingRecords`, shared/global variables, UFLs | 🔴 | multi-pass/runtime semantics preserved, not silently approximated |
| Maps/OLE/opaque objects | 🔴 / 🟡 | static fallback or manual rebuild |

**Crystal finish-by-hand checklist:** inspect
`*.degradations.json`; wire parameters/selection scope; restore logos through
approved URL/upload handles; decide whether each subreport/advanced visual is
interactive or static; compare page count, clipping, repeated panels, table row
continuation, fonts, totals and representative data against the Crystal SDK
PDF.

## Agent path (no scripts)

If you're an agent with the Sigma data-model MCP available, you can skip `converters/bobj.mjs` and call the `convert_bobj_to_sigma` tool directly on the universe JSON from `getUniverse()`, then POST via the Sigma REST skill. The script path is the self-contained equivalent.

For workbooks: convert with `converters/webi.mjs`, then **wrap before POST** — `prepareWorkbookForPost(result.workbook)` from `scripts/code_rep.mjs` (or use `postWorkbook`, which does it for you). Do not POST a flat `{schemaVersion, pages:[{elements}]}` body; see Phase 3.

For Crystal/Sigma reports: normalize to Crystal IR, call
`convertCrystalToReport`, validate with `validateReportSpec`, call report
`/verify`, then create only with approved persistence. Use
`scripts/report-code-rep.mjs`; never reuse workbook grid layout. Defer
authoring support decisions to the installed `sigma-reports` skill/OpenAPI
support matrix.

## Scope & limits

- **RWS JSON carries no SELECTs / tables** — the REST outline has no relational bindings or data foundation, so columns and calculations can't come from it. The SL-SDK / IDT XML path (`extract-universe-sdk.groovy` → `ingestBobjSdkXml`, auto-detected) supplies them. Same converter core.
- **Universe contexts** (alternate join paths) — not yet modeled; relationships come from the join graph. Verify multi-fact routing.
- **Crystal Reports** — Raylight does not expose them. Loose `.rpt` production
  extraction requires the official Windows SDK; CMS extraction requires
  Java/RAS. Advanced/opaque features remain explicit degradations.
- **`@`-functions & predefined filters** — emitted as warnings; re-author as Sigma controls/filters.
- **Status:** universe/Webi are live-verified. Crystal offline extraction and
  conversion gates pass; the full Snowflake→Sigma persistent E2E is implemented
  in `scripts/e2e-crystal-report.mjs` and requires a run with working injected
  Snowflake/Sigma resources. RWS/RAS service-pack shapes still require a
  representative customer smoke test.
- **Workbook POST shape:** since 2026-08 the workbook code-rep requires the `document` wrapper (`kind: "workbook"`, flat `elements`, metadata-only `pages`, `layout`). `postWorkbook` adapts converter output automatically; see Phase 3. Data-model POSTs stay flat.

Run `npm test` for all offline universe, Webi, Crystal, workbook code-rep, and
report code-rep gates.
