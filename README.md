# BusinessObjects → Sigma

Migrate **SAP BusinessObjects** to **Sigma Computing** — both layers, pulled straight from the BI RESTful Web Service (RWS) on an on-prem BO 4.x server:

| BusinessObjects | → | Sigma |
|---|---|---|
| **Universe** (semantic layer) | → | **Data model** |
| **Web Intelligence** document | → | **Workbook** |

No Java SDK, no Client Tools, no manual exports — one logon token unlocks the universes (Semantic Layer API), the Webi documents (Raylight API), and the full repository inventory (CMS query).

> **Status.** The converters are verified end‑to‑end against the live Sigma API (spec POST + a query that returns real warehouse data, zero error‑typed columns). The RWS **discovery scripts** are written to the documented RWS contract but have **not yet been run against a live BO server** — response shapes vary across BI 4.1/4.2/4.3 and the parsers will likely need a small adjustment on first contact (they're defensive and commented for it). PRs from a real run welcome.

## How it maps

**Universe → data model** (`converters/bobj.mjs`)
- physical tables → warehouse‑table elements
- dimensions / details → columns (the universe **business name** is preserved; the formula references the physical column)
- measures → metrics (Sum / Count / Count Distinct / Avg / Min / Max / StdDev / Variance)
- object expressions (functions, `CASE`, concatenation) → calculated columns
- joins → relationships, with FK/PK keys parsed from the join `Table.col = Table.col` SQL
- each fact gets a denormalized **View** element (own + related columns) — the single element a workbook binds to
- predefined filters and `@`‑functions (`@Prompt` / `@Select` / `@Variable` / `@Aggregate_Aware` / `@Where`) → warnings

**Webi document → workbook** (`converters/webi.mjs`)
- report tab → page · table → table · crosstab → pivot‑table · chart → bar/line/pie/area · measure cell → KPI · filter → control
- every element binds to the universe's View element; column refs are qualified by the source element name (`[Order Fact View/Net Revenue]`) so nothing self‑references

This converter mirrors the `convert_bobj_to_sigma` tool in [`sigma-data-model-mcp`](https://github.com/twells89/sigma-data-model-mcp); `converters/bobj.mjs` + `helpers.mjs` are a faithful standalone port so this repo runs without the MCP server.

## Prerequisites

- **Node 18+**.
- **Network access to the BO server.** RWS runs *on* the on‑prem box (default `https://<host>:6405/biprws`); run this where it's reachable (customer machine / VPN).
- **RWS enabled** (ships on by default in BI 4.x) and a logon user with view rights on the content.
- **Sigma**: an API token (or client id/secret), a target folder, and a warehouse connection pointing at the same database the universe's tables live on.

## Quick start

```bash
cp .bo_env.example .bo_env      # fill in BO + Sigma creds
set -a; . ./.bo_env; set +a

npm test                                         # offline: converters vs. bundled fixtures
node scripts/discover.mjs                        # inventory universes + Webi docs → inventory.json
node scripts/migrate-universe.mjs <universeId>   # universe → data model (records binding)
node scripts/migrate-webi.mjs <docId> --universe <universeId>   # Webi doc → workbook
```

Migrate a universe **before** the reports that use it — the workbook binds to the data model it produces.

## Layout

```
converters/   bobj.mjs (universe→DM)  ·  webi.mjs (Webi→workbook)
helpers.mjs   Sigma id/naming/format/CASE utilities (ported from the MCP)
scripts/      bo-rws.mjs (RWS client) · sigma.mjs (Sigma REST) · discover / migrate-universe / migrate-webi
fixtures/     efashion_universe.json · sample_webi.json  (used by npm test)
SKILL.md      agent-facing skill definition (Claude Code / Agent SDK)
```

## Limitations

- **Universe contexts, join cardinalities, derived‑table SQL** — light in RWS metadata; full fidelity needs a Semantic‑Layer‑SDK XML export (the converter IR is structured to accept that as a later ingest).
- **Crystal Reports** — not covered by RWS; out of scope.
- **`@`‑functions / predefined filters** — surfaced as warnings; re‑author as Sigma controls/filters.

## License

MIT
