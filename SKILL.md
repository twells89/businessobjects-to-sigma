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

Everything is pulled over HTTP from the **BI RESTful Web Service (RWS)** on the customer's BO server — no Java SDK, no Client Tools, no manual exports.

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

**Phase 4 — Verify**
Query the saved objects (Sigma MCP `describe` + `query`, or the UI). The bar: real warehouse data, zero error-typed columns. Review every converter warning — predefined filters, `@Prompt`/`@Variable`/`@Select`/`@Aggregate_Aware`, and multi-table object SELECTs are surfaced for manual follow-up, not silently dropped.

## Agent path (no scripts)

If you're an agent with the Sigma data-model MCP available, you can skip `converters/bobj.mjs` and call the `convert_bobj_to_sigma` tool directly on the universe JSON from `getUniverse()`, then POST via the Sigma REST skill. The script path is the self-contained equivalent.

## Scope & limits

- **Universe contexts, join cardinalities, derived-table SQL** — RWS metadata is light here. Full fidelity needs a Semantic-Layer-SDK XML export; the converter's IR core is structured to accept that as a Phase-2 ingest without a rewrite.
- **Crystal Reports** — not covered by RWS (separate, proprietary). Out of scope.
- **`@`-functions & predefined filters** — emitted as warnings; re-author as Sigma controls/filters.
- **Status:** the converters are verified end-to-end against Sigma (POST + real-data query). The RWS *discovery* scripts are coded to the documented contract but have **not** been run against a live BO server yet — expect to adjust response-shape parsing on first contact (see comments in `scripts/bo-rws.mjs`).

Run `npm test` for an offline smoke test of both converters on the bundled fixtures.
