---
name: businessobjects-assessment
description: >-
  Take inventory of an SAP BusinessObjects estate and produce a migration-readiness
  readout. Scores universes, Web Intelligence documents, and Crystal Reports from
  the businessobjects-to-sigma converter's own warnings, preflight blockers, and
  Crystal degradation ledger. Use to scope a BO→Sigma migration, separate
  outline-only universes and unextracted Crystal reports from real conversion
  gaps, and pick a pilot. Read-only. Hands off to businessobjects-to-sigma.
user-invocable: true
---

# BusinessObjects Assessment

Surveys universes, Web Intelligence documents, and Crystal Reports, then writes
`inventory.json`, `coverage.json`, `migration-plan.json`, `readout.md`, and
`readout.html`. The score uses the converter in
`../businessobjects-to-sigma/` — `convertBobjToSigma`, `convertWebiToWorkbook`,
`convertCrystalToReport`, and the publication preflight — so the readout matches
what a later conversion will actually warn about.

> **Read-only.** Live mode issues RWS GETs and CMS queries. It never writes to
> BusinessObjects and never calls Sigma. See `PRIVACY.md` and surface it before
> running.

> **All free.** Inventory, scoring, and the readout are part of the open
> migration tooling. For a live parity and security engagement, point the
> customer at a Sigma SE.

## When to use

- A BusinessObjects customer wants a scoping view before a migration.
- A Sigma SE wants a pilot shortlist that distinguishes "we do not have the
  source yet" from "the converter cannot represent this feature."
- A conversion needs a Phase 0 inventory. Universes are sequenced before the
  Web Intelligence documents that bind to them.

Not for posting data models, workbooks, or reports. Dry-runs belong to
`businessobjects-to-sigma`.

## Modes

| Mode | Input | Use when |
|---|---|---|
| Offline | SDK/IDT universe XML or JSON, Webi snapshots, Crystal IR | No network, or a sample the customer already exported |
| Live | `BO_BASE_URL` plus `.bo_env` credentials | A reachable BI 4.x RWS |

```bash
node scripts/assess.mjs --offline --input <file-or-dir> --out /tmp/bo-assessment
node scripts/assess.mjs --live --folder <folderId> --capture-webi --out /tmp/bo-assessment
node scripts/assess.mjs --live --extract-crystal --out /tmp/bo-assessment
```

Run these from this skill directory, or `npm run assess -- --offline …` from
the repository root.

`--capture-webi` stores redacted Raylight snapshots and skips documents that
already have a complete snapshot. `--refresh` recaptures them. A partial
snapshot (failed provider or element endpoint) is fetched again.

`--extract-crystal` runs `extract-crystal-cms.groovy` only when `BO_SDK_LIB`
and `BO_CMS` are set. Without them, Crystal rows stay `extract-first`.
Pass `--crystal-ir <dir>` to score IR files you already extracted.

`--usage file.csv` reads audit run counts (`id,kind,name,runs`). Artifacts
missing from that file keep a complexity proxy and are **not** tagged `retire`.
Absent usage is never treated as disuse.

`--fail-on-incomplete` exits 2 when a typed list or CMS query is incomplete.
The readout is still written.

## What the score means

`cost = 10·unhandled + 3·manual + 1·hint`. With no audit file,
`value = 10 × feature count`. With a matched audit row, `value` is the run
count. `score = value / (1 + cost)`.

| Tag | Meaning |
|---|---|
| `migrate-first` | No manual or unhandled converter gaps |
| `easy-win` | Some manual finish, but value still outweighs cost |
| `moderate` | Manual finish expected |
| `needs-review` | An unhandled construct (NoFilter, multiple providers, missing relationships, multi-pass Crystal) |
| `needs-export` | Universe is RWS outline JSON. Convert only after an SL-SDK/IDT export |
| `extract-first` | Crystal CMS row without a report IR |
| `needs-capture` | Web Intelligence row without a document snapshot |
| `retire` | Only when the audit file lists the artifact with zero runs |

Universe contexts and multi-fact views stay in the gap histogram. The converter
does not model alternate join paths, and this assessment does not hide that.

## Waves

1. Migrate-first and easy-win artifacts. Universes in the wave come before Webi documents that reference them.
2. Moderate artifacts, with the same dependency order.
3. Needs-review artifacts.

Outline universes, uncaptured Webi documents, and unextracted Crystal reports
are prerequisites, not conversion waves. A Webi document whose universe is
still `needs-export` waits in `blocked` instead of being scheduled early.

## Handoff

Show the shortlist and let the user choose. Then run the dry-run command from
`migration-plan.json` in `../businessobjects-to-sigma/`:

```bash
node scripts/migrate-universe.mjs --file universe.xml --source-universe-id <id> --dry-run
node scripts/migrate-webi.mjs <docId> --universe <universeId> --dry-run
node scripts/migrate-crystal.mjs --ir report.crystal-ir.json
```

Do not auto-convert.

## Scripts

| Script | Purpose |
|---|---|
| `scripts/assess.mjs` | Live or offline inventory, score, plan, and readout |
| `scripts/score-coverage.mjs` | Converter-backed scoring |
| `scripts/scoring.mjs` | Bucket costs and warning rules |
| `scripts/plan.mjs` | Dependency-aware waves |
| `scripts/render-readout.mjs` | Markdown and standalone HTML |
| `scripts/load-inputs.mjs` | Sniff offline universe, Webi, and Crystal files |
