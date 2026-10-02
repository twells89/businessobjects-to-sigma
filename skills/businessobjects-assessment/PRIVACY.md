# BusinessObjects assessment — privacy disclosure

Share this with the customer's privacy or security reviewer before a live run.

## What this skill does

Live mode sends **read-only** requests to the BI RESTful Web Service and CMS
query endpoint: logon, list universes and Web Intelligence documents, CMS
queries for Crystal definitions and folder metadata, and optional GETs of
universe outlines and Webi documents. Optional Crystal extraction opens a
report definition through the customer's BI Platform SDK. The skill does not
POST or PUT content objects, does not schedule or run reports, and does not
call Sigma.

Offline mode reads files you already have. It does not contact BusinessObjects.

## What crosses the LLM API

Like every agent skill, the content it reads is sent to the model:

| Crosses the API | Stays on the BO server or local disk |
|---|---|
| Object names, ids, owners, folder paths, timestamps | Warehouse rows — never queried |
| Universe object names and, when an SDK export is supplied, SELECT/WHERE text | Database passwords |
| Webi formulas, filters, and report structure | Report result sets |
| Crystal formula text and section metadata inside an IR file | `.rpt` blobs, unless you already extracted them locally |

Logon tokens and passwords are redacted before artifacts are written. Snapshots
can still contain customer SQL and business logic. `snapshots/` under the
output directory is sensitive; do not commit it.

## Where outputs go

The skill writes only to the directory you pass as `--out`: `inventory.json`,
`coverage.json`, `migration-plan.json`, `readout.md`, `readout.html`, plus
optional `specs/` and `snapshots/`. Nothing is uploaded. Sharing a readout is
a deliberate act.

## How to run it more privately

- Use `--offline` against an export the customer already produced.
- Pass `--folder` so Web Intelligence and Crystal discovery stays under one public folder. Universes outside that folder are still listed, because they live in the semantic-layer repository, and the readout says so.
- Skip `--capture-webi` and `--extract-crystal` for a metadata-only first pass.
