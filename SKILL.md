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
