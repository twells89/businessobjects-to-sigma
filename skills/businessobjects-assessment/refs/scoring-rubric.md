# Scoring rubric

The classifier lives in `scripts/scoring.mjs`. Costs:

- `unhandled` = 10
- `manual` = 3
- `hint` = 1
- `auto` = 0

`score = value / (1 + cost)`. Without an audit CSV, `value = 10 × feature count`.
With a matched audit row, `value` is `runs`. Rows missing from the CSV keep the
proxy and are not tagged `retire`.

Signals are produced by running the converter, not by a second formula grammar:

- Universe warnings and `universePreflight` blockers, plus an explicit
  `universe-contexts` gap when the source contains contexts. The converter does
  not model contexts; the assessment records that instead of hiding it.
- Webi warnings and `webiPreflight` blockers. `unbound-filters`, `input-controls`,
  `multiple-data-providers`, and `multiple-universes` stay visible. The converter
  does not bind input controls, so the assessment counts them from the source.
- Crystal `degradationLedger` dispositions. `WhilePrintingRecords`, shared or
  global variables, and UFLs are `unhandled`. A CMS row with no IR is
  `extract-first` and is not passed through the converter.

Acquisition tags (`needs-export`, `extract-first`, `needs-capture`) describe
missing source, not a Sigma feature gap. They are prerequisites in the
migration plan.
