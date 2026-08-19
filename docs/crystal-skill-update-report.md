# Crystal Reports skill update report

Date: 2026-08-19

## Executive outcome

The Crystal migration path now has three materially different proof profiles:

| Profile | Public oracle | Data oracle | Shape | Live result |
|---|---|---|---|---|
| Meridian customer statement | Pinned `.rpt`; no Crystal PDF | Pinned synthetic SQL | 8 tables, 7 links, 3 parameters, 1 group, 37 formulas, image + subreport inventory | Snowflake seed, Sigma verify/create/readback/query/PDF pass |
| PettyCash monthly report | MIT `.rpt` + Crystal-produced PDF | Nine PDF rows reconstructed in Snowflake | One-page table, embedded logo, boxes, mixed text runs | Snowflake seed, Sigma verify/create/readback/query/PDF pass |
| XML Résumé | MIT `.rpt` + Crystal-produced PDF | Pinned XML + XSD-compatible hierarchy | 3 subreports, 5 main tables, nested project/accomplishment data, links | XML seed, Sigma verify/create/readback, 3 element queries, PDF pass |

This evidence supports updating the skill from “first Meridian profile, live run
still required” to “three live-tested profiles with explicit visual-oracle
gates.” It does **not** support claiming generic pixel-perfect fidelity for
arbitrary Crystal reports.

## Evidence captured

### Meridian

- Extraction: 10 sections, 56 objects, 8 tables, 7 links, 37 formulas,
  3 parameters, 1 group, 1 subreport.
- Seed: 1,291 statement rows and 302 customers.
- Live Sigma report: `6a8b85c5-eb77-4cf8-bb00-f31943925849`.
- Proven fixes:
  - integer report geometry;
  - Snowflake role grants and Sigma metadata sync;
  - YAML create-response parsing;
  - canonical GET readback normalization;
  - update/resume without duplicate report creation.
- Limitation: no original Crystal-rendered PDF exists for this upstream
  fixture, so it is a structural/data proof rather than a visual golden.

### PettyCash

- Source pair: `MonthlyReport.rpt` and `Monthly_Report.pdf`.
- Provenance: MIT repository; application code loads the exact RPT and exports
  the exact PDF path; PDF metadata is `Crystal Reports / Powered By Crystal`.
- Extraction: 5 sections, 29 objects, 1 table, 17 fields, 1 embedded picture.
- Data: exact nine public PDF rows, withdrawal total `2286.00`, closing balance
  `2627.67`.
- Live Sigma report: `f2f93268-7f5d-405e-bf3b-7a923ad72876`.
- Proven:
  - pinned source/PDF blob checks;
  - Letter page geometry and footer panel;
  - live detail-table query and PDF export;
  - horizontal divider rendering.
- Code-rep gaps discovered:
  - divider elements are horizontal-only; tall/narrow placements do not become
    vertical rules;
  - table cell spacing/row height, title suppression, and exact column widths
    are not represented by the report code-rep;
  - unknown style properties are discarded on PUT readback;
  - embedded image upload/URL handles require a separate asset workflow.

### XML Résumé

- Source trio: `basic resume template.rpt`, Crystal-produced PDF, and
  deterministic `resume.xml`.
- Provenance: MIT; PDF metadata is `Crystal Reports / Powered By Crystal`;
  PDF text matches XML values.
- Extraction: 12 main sections, 19 objects, 5 tables, 4 links, 20 fields,
  3 formulas, 1 group, and 3 recursively extracted subreports with no warnings.
- Seed census: 1 profile, 2 degrees, 4 certifications, 3 projects,
  6 accomplishments, 15 flattened project lines.
- Live Sigma report: `943292de-fa30-4e60-b008-69a937fb5185`.
- Proven:
  - three Crystal subreports can be flattened into three queryable Snowflake
    sources;
  - all three Sigma report elements query without dependency/error-typed
    failures;
  - pinned XML is a stronger data oracle than reconstructing a PDF.
- Code-rep gaps discovered:
  - Crystal growable subreport bands map to compact Sigma tables, not repeated
    free-form sections;
  - mixed font runs, exact point sizes, per-run links, and wrapping normalize
    to markdown/table defaults;
  - long project/accomplishment text truncates without a code-rep table-width
    or wrapping control;
  - table summary bars cannot currently be suppressed through the tested
    representation.

## Current `SKILL.md` statements that are stale

1. The top converter table lists only `converters/crystal.mjs`; it must list
   the dedicated Meridian, PettyCash, and XML Résumé profiles.
2. Phase 3b says “For the pinned Meridian proof” and “The first tested profile.”
   It must describe all three proof gates and distinguish structural versus
   visual oracles.
3. Crystal coverage says subreports use a first-profile manual/static fallback.
   XML Résumé proves recursive extraction and deterministic warehouse
   flattening, while direct subreport emission remains unsupported.
4. Scope/status says the full persistent E2E still requires a run. All three
   profiles now pass live Snowflake→Sigma create/update/query/PDF gates.
5. The skill does not warn that `/verify` can pass a visually poor report.
   PDF comparison must be a required acceptance gate, not an optional polish
   step.
6. The skill does not document report code-rep limits found live: vertical
   dividers, row spacing, title suppression, exact widths/wrapping, and image
   asset handles.

## Proposed skill changes

### 1. Converter and proof-profile table

Replace the single Crystal converter row with:

| Crystal profile | Converter | Oracle |
|---|---|---|
| Meridian statement | `converters/crystal.mjs` | RPT + SQL; structural/data proof |
| PettyCash monthly | `converters/crystal-pettycash.mjs` | RPT + Crystal PDF; reconstructed public rows |
| XML Résumé | `converters/crystal-xmlresume.mjs` | RPT + Crystal PDF + deterministic XML |

State that these are tested compatibility profiles, not a generic guarantee.

### 2. Phase 3b workflow

Add the reproducible oracle gates:

```bash
# Simple one-page table + Crystal PDF
npm run e2e:crystal:pettycash
PETTYCASH_E2E_CREATE=true npm run e2e:crystal:pettycash

# Three subreports + Crystal PDF + deterministic XML
npm run e2e:crystal:xmlresume
XMLRESUME_E2E_CREATE=true npm run e2e:crystal:xmlresume
```

Require `*_E2E_REPORT_ID` for subsequent in-place refinement so test runs do
not create duplicate reports.

### 3. Oracle policy

Before calling a migration visually validated, require:

1. immutable `.rpt` hash;
2. Crystal-produced PDF hash and producer metadata;
3. deterministic data oracle (SQL/XML/JSON), or an explicit
   `reconstructed-public-oracle` degradation;
4. extraction census;
5. offline validation;
6. Sigma `/verify`;
7. persistent GET readback;
8. every data element queried;
9. Sigma PDF exported beside the Crystal PDF;
10. visual review of page count, bounds, clipping, wrapping, repeated panels,
    totals, and representative values.

`/verify` proves schema validity only. It does not prove visual quality.

### 4. Crystal coverage table

Recommended statuses:

| Construct | Status | Evidence/finish |
|---|---|---|
| Page dimensions, margins, absolute placement | 🟢 | Live across A4 and Letter; integer pixels required |
| Static text, horizontal rules, footer panels | 🟢 | Live PDF/readback proven |
| Detail tables over warehouse sources | 🟢 | Meridian + PettyCash |
| Recursive subreport extraction | 🟢 | XML Résumé extracts 3/3 |
| Subreport data flattening | 🟡 | XML Résumé uses separate Snowflake tables; visual bands normalize to tables |
| Mixed text runs and links | 🟡 | Markdown preserves content/links, not exact fonts/runs |
| Lines/boxes | 🟡 | Horizontal dividers proven; vertical rules require table chrome or manual finish |
| Images/logos | 🟡 | Inventory preserved; portable asset upload/URL workflow still needed |
| Table widths, row spacing, wrapping, title/summary visibility | 🟡 / 🔴 | Not exposed in tested report code-rep; manual UI finish or alternate layout |
| Parameters and selection formulas | 🟡 | Preserved in IR; controls/filter wiring still profile-specific |
| Crosstabs/charts | 🟡 | Extracted/inventoried but no licensed visual golden yet |
| Multi-pass/shared variables, UFLs | 🔴 | Preserve and rebuild |

### 5. Finish-by-hand checklist

Add explicit checks:

- compare against the Crystal PDF at fit-to-page, not a cropped browser view;
- inspect every row/column for clipping and hidden overflow;
- verify table titles/summary bars did not appear unexpectedly;
- verify multiline/growable sections and subreport continuation;
- restore approved images;
- apply UI-only table spacing/wrapping/width adjustments when code-rep drops
  those settings;
- rerun GET/query/PDF after manual finishing.

## Additional examples

### Accepted next

No additional license-clean, deterministic, Crystal-PDF pair was found beyond
PettyCash and XML Résumé.

### Deferred

- `itsbijay/jewelry-inventory`: MIT, two-page invoice with repeated headers and
  images, but PDF producer metadata is blank and exact transaction data is not
  available. Use only as a secondary visual lead, not a golden.
- Crystal Migration vendor samples: authoritative Crystal PDFs with forms,
  groups, and crosstabs, but no published reuse license. Request written
  permission before committing.
- CrystalCmd: MIT RPT + deterministic JSON/subreport fixtures, but no committed
  original PDFs. A Windows Crystal Runtime job could generate and pin new
  approved goldens.

## Recommended rollout

1. Update `SKILL.md` with the three-profile matrix, oracle policy, revised
   coverage, and current live status.
2. Keep production extraction guidance unchanged: official SAP SDK/RAS is
   required; `rpt-rs` remains a Linux smoke/fixture path.
3. Add a Windows Crystal Runtime golden-generation job for licensed fixtures.
4. Seek permission for one crosstab/chart and one multi-page invoice fixture.
5. Do not mark crosstabs/charts, image assets, or multi-page repeated detail as
   green until source+PDF+data goldens pass the same ten-gate policy.

## Merge recommendation

The skill can accurately claim:

- live report create/update/readback/query/PDF;
- A4 and Letter geometry;
- warehouse-backed detail tables;
- deterministic PDF-oracle testing;
- recursive extraction and data flattening of three subreports.

It must continue to qualify “pixel-perfect” as a target with explicit
degradations and PDF review, not an automatic result.
