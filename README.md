# BusinessObjects → Sigma

Migrate **SAP BusinessObjects** to **Sigma Computing** — semantic models,
interactive Webi documents, and fixed-layout Crystal Reports:

| BusinessObjects | → | Sigma |
|---|---|---|
| **Universe** (semantic layer) | → | **Data model** |
| **Web Intelligence** document | → | **Workbook** |
| **Crystal Report** (`.rpt` / CMS definition) | → | **Pixel-perfect report** |

Universe/Webi migration uses one RWS logon (Semantic Layer + Raylight + CMS
query). Crystal report definitions are a separate SAP surface: use the
official Crystal .NET SDK for loose `.rpt` files or BI Platform Java SDK/RAS
for CMS-managed reports. A pinned `rpt-rs` path exists for Linux smoke tests
and the public Meridian proof, but is not the production extraction contract.

> **Status.** Universe/Webi converters are verified end-to-end against Sigma.
> Crystal extraction, normalization, source/formula translation, Snowflake
> seeding, report code representation, and the full live E2E gate are
> implemented and offline-tested. The first persistent Snowflake→Sigma report
> run still requires a Cloud run with working Snowflake variables plus
> `SIGMA_FOLDER_ID`/`SIGMA_CONNECTION_ID`. RWS and CMS/RAS response/getter shapes
> vary by BO service pack; validate a representative report before batch use.

## How it maps

**Universe → data model** (`converters/bobj.mjs`)
- physical tables → warehouse‑table elements
- dimensions / details → columns (the universe **business name** is preserved; the formula references the physical column)
- measures → metrics (Sum / Count / Count Distinct / Avg / Min / Max / StdDev / Variance)
- object expressions (functions, `CASE`, concatenation) → calculated columns
- joins → relationships, with FK/PK keys parsed from the join `Table.col = Table.col` SQL
- each fact gets a denormalized **View** element (own + related columns) — the single element a workbook binds to
- predefined filters and `@`‑functions (`@Prompt` / `@Select` / `@Variable` / `@Aggregate_Aware` / `@Where`) → warnings
- **target‑layer remap** (optional): if the warehouse was restructured vs. the universe (renamed / consolidated tables — e.g. a platinum layer), pass `--remap remap.json` (`tableMap` / `columnMap`) to repoint the output at the new physical names *before* conversion. Many old tables may map to one; business names are preserved; unmatched keys are surfaced as warnings. See SKILL.md → **Phase 2a**.

**Webi document → workbook** (`converters/webi.mjs`)
- report tab → page · table → table · crosstab → pivot‑table · chart → bar/line/pie/area · measure cell → KPI · filter → control
- **report variables / formulas** → Sigma formulas: arithmetic, `If`/logic, string, date, aggregations, and the layout family (`Previous→Lag`, `RunningSum→CumulativeSum`, `RunningCount→CumulativeCount`, `Rank`, `Percentage→PercentOfTotal`). Context operators (`In`/`ForEach`/`ForAll`) → grouping / window partitions (best‑effort + warned). Split by kind — context‑free measures/dims become **data‑model additions**, layout/context‑dependent ones stay workbook calc columns.
- **breaks / sections** → table `groupings` + per‑group **subtotals**; **sort** carried through (in‑grouping or element‑level)
- **alerters** → `conditionalFormats` — threshold background/text‑color rules on tables & pivots
- every element binds to the universe's View element; column refs are qualified by the source element name (`[Order Fact View/Net Revenue]`) so nothing self‑references
- untranslatable pieces (`NoFilter`, `@`‑functions, gradient/border/image alerters, `Between`) are **surfaced as warnings**, never silently dropped

**Crystal Report → Sigma report** (`converters/crystal.mjs`)
- loose `.rpt` → neutral Crystal IR through `tools/crystal-extractor` (SAP
  Crystal Reports for Visual Studio x64 SDK)
- CMS definition → the same IR through `scripts/extract-crystal-cms.groovy`
  (BI Platform Java SDK/RAS; scheduled instances excluded)
- Linux smoke path → the same IR through pinned `rpt-rs` JSON
- page size/margins + twip geometry → report `document.config` and absolute
  pixel `<Page>`/`<Panel>` layout
- page headers/footers → repeating Sigma report panels
- detail band → ungrouped report table by default; optional customer-summary
  mode adds grouping (Sigma grouping aggregates rows); report total → KPI
- direct tables/links → existing universe/data-model converter when useful;
  the Meridian proof uses a Snowflake wide view and live-proven report
  `warehouse-table` source
- Crystal formulas → Sigma formulas where verified; parameters, multi-pass
  evaluation, images/subreports and unsupported objects remain explicit in a
  machine-readable degradation ledger

### Webi input: live documents, not `.wid` files

The Webi converter ingests the **Raylight document JSON** pulled live from the BO server — `GET /biprws/raylight/v1/documents/{id}` (and `…/reports/{rid}/elements`) — addressed by **document id**, *not* a `.wid` file on disk.

A `.wid` is SAP's **proprietary binary** Web Intelligence Document format; it has no published spec and no clean offline parser — reading its structure requires the BO platform (Raylight REST, or the legacy Java Report‑Engine/Rebean SDK). **So this repo cannot read a loose `.wid` directly.**

If all you have is `.wid` files, get them onto a reachable CMS first, then migrate by id:

1. **Import the `.wid`(s)** into a BO 4.x repository — via *Open → From File* in the Webi client, the CMC/promotion management, or a `.biar`/LCM import (a sandbox/temp BO instance works).
2. `node scripts/discover.mjs` → inventory to get each document's **id**.
3. `node scripts/migrate-webi.mjs <docId> --universe <universeId>`.

That's the only path that yields the structured model the converter needs. (The converter IR is tolerant enough that an exported structured representation could be wired as an alternate ingest later — but the `.wid` binary itself doesn't give you one.)

This converter mirrors the `convert_bobj_to_sigma` tool in [`sigma-data-model-mcp`](https://github.com/twells89/sigma-data-model-mcp); `converters/bobj.mjs` + `helpers.mjs` are a faithful standalone port so this repo runs without the MCP server.

### Crystal input: official SDK first, rpt-rs for the public proof

SAP does not publish a stable `.rpt` binary specification. Production
extraction therefore opens the report with the customer's licensed SDK/runtime:

```powershell
$env:CRYSTAL_SDK_DIR = 'C:\path\to\matching\x64\CrystalDecisions assemblies'
dotnet build tools\crystal-extractor\CrystalExtractor.csproj -c Release
tools\crystal-extractor\bin\Release\net48\crystal-extractor.exe report.rpt `
  --out report.crystal-ir.json --pdf report.crystal.pdf
```

For CMS content:

```bash
groovy -cp "$BO_SDK_LIB/*" scripts/extract-crystal-cms.groovy \
  --cms cms.example.com:6400 --user "$BO_USER" --password "$BO_PASSWORD" \
  --auth secEnterprise --id 12345 --out-dir artifacts/crystal/cms
```

The cross-platform smoke path accepts `rpt-rs` v0.4.0:

```bash
RPT_RS_BIN=/path/to/rpt node scripts/extract-crystal-rpt-rs.mjs report.rpt \
  --out report.crystal-ir.json
```

`rpt-rs` is MPL-2.0, independent of SAP, reverse-engineered, and experimental.
It lets CI test extraction of the pinned Meridian sample; it is not a claim
that direct binary parsing is SAP-supported.

Every path emits [`schemas/crystal-report-ir.schema.json`](schemas/crystal-report-ir.schema.json).
The IR preserves raw formulas, sections, page/printer settings, source topology,
parameters, subreports, object geometry, warnings, and extractor provenance.

## Conversion coverage

This is an **agent‑led** migration: the converter produces a faithful first draft and the agent finishes the report in Sigma. Read the verdicts that way:

- 🟢 **Fully** — produced working, little/no manual finish.
- 🟡 **Partially** — Sigma fully supports it; a guided rebuild/wiring step (an expected finishing step, not a blocker).
- 🔴 **Gap** — no clean path today; a documented workaround or remodel.

> **Sigma is not a paginated render engine.** It compiles aggregates and window functions to SQL and runs them in the warehouse over the **entire** result set — the viewport is display only. So "percent of a grand total," running totals, and nested variables compute across all rows regardless of what's scrolled into view (a common Webi worry that simply doesn't apply here). Agent‑facing detail + the per‑report finish‑by‑hand checklist live in [SKILL.md](SKILL.md#webi-feature-coverage).

**Formulas & aggregation**

| Webi | | Notes |
|---|---|---|
| Report variables / formulas (arithmetic, `If`, string, date, aggregations) | 🟢 | `converters/webi-formula.mjs` translates; uncommon/BO‑specific functions flagged for review (not a literal 1:1 of all ~180 functions). |
| Running totals / `Previous` / `Rank` / `Percentage` | 🟢 | → `CumulativeSum` / `CumulativeCount` / `Lag` / `Rank` / `PercentOfTotal` (correct group‑level form on a broken table). |
| Subtotals · percent of total · ranking | 🟢 | Subtotals auto from breaks; `PercentOfTotal`; `Rank`/`RankDense`/`RankPercentile`. |
| Grand totals | 🟡 | Native Sigma table footer — one toggle; not auto‑emitted (warned). |
| Calculation context (`In` / `ForEach` / `ForAll`) | 🟡 | → grouping keys / window partitions; parsed, warns to confirm the grouping. |
| `NoFilter` | 🔴 | No direct equivalent — compute on a separate unfiltered element (warned). |

**Formatting & layout**

| Webi | | Notes |
|---|---|---|
| Sections & breaks | 🟢/🟡 | Breaks → `groupings` + subtotals (auto); sections → outer grouping (auto) + the master‑detail band visual isn't reproduced 1:1. |
| Sorting | 🟢 | Carried automatically (in‑grouping or element‑level). |
| Conditional formatting / alerters | 🟢/🟡 | Threshold alerters (`> < >= <= = !=`) → `conditionalFormats` background/text color on tables & pivots (live round‑trip verified). Gradient/data‑bar/border/size/content/image + `Between` + KPI‑cell → warned. |
| Table types & charts | 🟡 | table / crosstab / bar / line / pie / area / scatter / combo map; exotic viz → nearest equivalent. |
| Images/logos · colors/fonts/borders · headers/footers · hidden + show/hide · fold/unfold · drill | 🟡 | Supported in Sigma and rebuilt/wired: image elements, theme + conditional formatting, top‑of‑page + export header/footer, conditional visibility, native expand/collapse & drill‑down. |
| Relative (top/left) positioning · page numbers | 🟡/🔴 | Sigma is a responsive **grid + containers** (not absolute pixels); page numbers exist only in PDF/scheduled **export**, not the interactive canvas. |

**Filtering**

| Webi | | Notes |
|---|---|---|
| Filters at all levels (report / table / section); on a formula/variable; on measures | 🟡 | Document filters → controls; scope re‑created as page controls vs element filters; measure filters via top‑N / number‑range. |
| Input controls · element links | 🟡 | → Sigma controls (list/dropdown/date/top‑N) and cross‑element filters / actions (UI‑wired). |

**Query panel & merge**

| Webi | | Notes |
|---|---|---|
| Custom SQL | 🟢/🟡 | Sigma Custom SQL data element — strongly supported. |
| Merged objects (inner / union / left outer); subqueries; database rankings; combined queries | 🟡 | Modeled in the **data model**: relationships (many→one), union / Custom SQL, `Rank` + top‑N pushed to the warehouse. Right outer reframed as left; Intersect/Minus via Custom SQL or anti/semi‑join. |
| Prompts | 🟡 | → Sigma controls / parameters (bind to filters or data‑model SQL). |
| Non‑universe Excel data providers | 🟡 | Sigma CSV/Excel upload as a source; wired manually. |
| "In list from another query" | 🟡 | Compiles to a semi‑join (`WHERE col IN (SELECT …)`) — exactly what BObj emits — and runs verbatim in a Sigma **Custom SQL** element (or as a join). The only gap is *no‑code*: no "is‑in another element" filter / formula‑level `IsIn` against another element. Same connection; cross‑connection → blend. |
| Query properties (refreshable / duplicate rows / trim) | 🟡 / n/a | Live/refreshable by nature; distinct toggle; `Trim`; some Webi‑only execution settings safely drop. |

### Crystal compatibility profile

The first profile is the pinned MPL-2.0 Meridian customer statement:

| Crystal construct | Status | Sigma result |
|---|---|---|
| A4 page, margins, portrait/landscape | 🟢 | `document.config` + 96-DPI twip conversion |
| Page header/footer | 🟢 | repeating report header/footer panels |
| Detail fields | 🟢 | warehouse-backed report table |
| Customer group + total | 🟡 | default preserves invoice detail; optional `--group-customers` emits an aggregated customer summary |
| Report grand total | 🟢 | KPI over live Snowflake view |
| Common arithmetic, `IIf`, nested `If`, null/date/string functions | 🟢/🟡 | translated with per-formula warnings |
| Parameters / record selection | 🟡 | preserved; first proof uses warehouse defaults rather than unverified synced controls |
| Lines/boxes | 🟡 | normalized into Sigma page/table styling |
| Embedded/dynamic pictures | 🟡 | ledger entry until a portable URL/upload handle is available |
| Linked subreport | 🟡 | recursively extracted; first profile records manual/static fallback |
| `WhilePrintingRecords`, shared/global variables, UFLs | 🔴 | preserved source + explicit degradation |
| Advanced crosstabs/charts, maps, OLE | 🔴/🟡 | targeted Sigma support check or static fallback |

Do not call a report pixel-perfect solely because `/verify` returned 200.
Require GET readback, representative element queries, Sigma PDF export, and a
visual comparison with the Crystal SDK PDF oracle.

**Still out of scope:** Xcelsius / Design Studio / Lumira. Raw `.wid` files
aren't parseable directly — see above.

## Prerequisites

- **Node 18+**.
- **Network access to the BO server.** RWS runs *on* the on‑prem box (default `https://<host>:6405/biprws`); run this where it's reachable (customer machine / VPN).
- **RWS enabled** (ships on by default in BI 4.x) and a logon user with view rights on the content.
- **Crystal extraction**: Windows x64 + matching Crystal Reports for Visual
  Studio SDK for loose reports, or BI Platform Java SDK/RAS for CMS reports.
  `rpt-rs` is optional for Linux smoke tests.
- **Sigma**: an API token (or client id/secret), a target folder, a Snowflake
  connection, and report create/edit/export permission.
- **Snowflake demo seed**: Python 3 plus
  `pip install -r requirements-crystal.txt`; key-pair variables listed in
  `.bo_env.example`. Use an isolated database/schema and set
  `CRYSTAL_SIGMA_ROLE` when the Sigma connection needs an explicit read grant.

## Quick start

```bash
cp .bo_env.example .bo_env      # fill in BO + Sigma creds
set -a; . ./.bo_env; set +a

npm test                                         # offline: converters vs. bundled fixtures
node scripts/discover.mjs                        # inventory universes + Webi docs → inventory.json
node scripts/migrate-universe.mjs <universeId>   # universe → data model (records binding)
node scripts/migrate-universe.mjs <universeId> --remap remap.json   # …repointed at a restructured / platinum layer
node scripts/migrate-webi.mjs <docId> --universe <universeId>   # Webi doc → workbook

# Public Crystal proof
python3 scripts/seed-crystal-snowflake.py             # isolated synthetic data + wide view
RPT_RS_BIN=/path/to/rpt node scripts/extract-crystal-rpt-rs.mjs report.rpt --out report.ir.json
node scripts/migrate-crystal.mjs --ir report.ir.json # offline + Sigma /verify, no create
node scripts/migrate-crystal.mjs --ir report.ir.json --create --pdf statement.pdf

# Crystal source/PDF visual oracle (MIT-licensed PettyCash sample)
npm run e2e:crystal:pettycash                    # seed + verify, no create
PETTYCASH_E2E_CREATE=true npm run e2e:crystal:pettycash

# Crystal source/PDF/XML oracle with three subreports (MIT XML Résumé)
npm run e2e:crystal:xmlresume
XMLRESUME_E2E_CREATE=true npm run e2e:crystal:xmlresume
```

The PettyCash gate downloads a pinned `.rpt` and the PDF exported from that
exact template by Crystal Reports, validates both blob hashes, reconstructs
the PDF's nine public rows in Snowflake, and writes the Crystal and Sigma PDFs
side by side under `artifacts/crystal/pettycash-e2e/`. Sigma report code-rep
supports horizontal dividers but does not currently expose vertical divider
orientation or table cell-spacing styles; those differences are recorded in
the degradation ledger rather than silently claimed as pixel-identical.

The XML Résumé gate adds deterministic XML seeding and three recursively
extracted subreports flattened into independently queried Sigma data elements.
See [the Crystal skill update report](docs/crystal-skill-update-report.md) for
the resulting evidence matrix, live limitations, and proposed `SKILL.md`
changes.

Migrate a universe **before** the reports that use it — the workbook binds to the data model it produces.

## Layout

```
converters/   bobj.mjs (universe→DM) · webi.mjs (Webi→workbook) · crystal*.mjs (Crystal→report)
helpers.mjs   Sigma id/naming/format/CASE utilities (ported from the MCP)
scripts/      BO/RAS extraction · Snowflake seed · Sigma workbook/report lifecycles · migration CLIs
fixtures/     eFashion/Webi fixtures · owned Crystal IR · pinned Meridian source manifest
schemas/      Crystal migration IR
tools/        Windows SAP Crystal SDK extractor
SKILL.md      agent-facing skill definition (Claude Code / Agent SDK)
```

## Limitations

For report‑layer (Webi → workbook) fidelity — what auto‑converts vs. what's finished by hand vs. the true gaps (`NoFilter`, `Between` in conditional formats, "in‑list from another query") — see [**Conversion coverage**](#conversion-coverage) above. Ingest/universe‑side limits:

- **Universe contexts, join cardinalities, derived‑table SQL** — light in RWS metadata; full fidelity needs a Semantic‑Layer‑SDK XML export (the converter IR is structured to accept that as a later ingest).
- **Raw `.wid` files** — not parseable directly (proprietary binary). Import them into a BO repository and migrate by document id — see *Webi input: live documents, not `.wid` files* above.
- **Crystal Reports** — report definitions are not exposed by Raylight. Use the
  SDK/RAS extraction paths. The first profile intentionally records images,
  subreports, parameters and multi-pass formulas as degradations rather than
  pretending they are complete.
- **`@`‑functions / predefined filters** — surfaced as warnings; re‑author as Sigma controls/filters.

## License

MIT
