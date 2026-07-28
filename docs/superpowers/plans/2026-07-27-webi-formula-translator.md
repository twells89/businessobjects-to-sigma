# Webi Formula Translator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate SAP Web Intelligence report variables/formulas (from the Raylight REST API) into working Sigma formulas, split by kind: context-free ones become data-model additions, layout/context-dependent ones become workbook element calc columns.

**Architecture:** A dep-free tokenizer + shallow recursive-descent rewriter (`converters/webi-formula.mjs`) turns each Webi formula into a Sigma formula string, tagging it `dm` or `workbook`. `converters/webi.mjs` ingests variables into its IR, calls the engine, resolves block references, and returns a new `dataModelAdditions` bucket alongside the workbook. `scripts/bo-rws.mjs` fetches the `/variables` resource; `scripts/migrate-webi.mjs` patches the Phase-2 data model with the additions, then POSTs the workbook. A live end-to-end tie-out on the CSA.TJ connection is the commit gate.

**Tech Stack:** Node ≥18 ESM (`.mjs`), zero runtime dependencies, plain-`node` test scripts using a `check(cond, msg)` helper (no test framework), Sigma REST API.

## Global Constraints

- **Zero runtime dependencies.** Pure ESM `.mjs`, Node ≥18 built-ins only (matches the repo). No new packages. (If any dev tool were ever needed, org rule: never use a package version released within the last 3 days.)
- **Single surface.** The Webi converter is skill-repo-only — do NOT mirror to `sigma-data-model-mcp` or the browser tool.
- **Never throw on a bad formula.** Every untranslatable formula degrades to a warned stub that preserves the raw Webi text; the converter must never emit a column that query-errors silently.
- **No customer names** in code, comments, fixtures, commits, or PRs. Use generic names ("a customer", `RETAIL_DEMO`, etc.).
- **Branch + PR flow.** Work on `feat/webi-formula-translator`; do not push to `main` directly. E2E must be green before the commit that claims completion.
- **Test harness:** tests are standalone scripts using `const check = (cond, msg) => { console.log(...); if (!cond) failures++; }` and `process.exit(failures?1:0)`, mirroring `test/smoke.mjs`. Wire new files into `npm test`.

---

## File Structure

- **Create** `converters/webi-formula.mjs` — the translation engine. Public: `translateWebiFormula(formula, opts) → { sigma, kind, placement, warnings }`. One responsibility: Webi formula text → Sigma formula text + metadata.
- **Create** `test/webi-formula.test.mjs` — offline unit tests for the engine (all four tiers + classifier + malformed input).
- **Create** `test/webi-integration.test.mjs` — offline tests for `webi.mjs` variable ingest → `dataModelAdditions` + workbook columns.
- **Create** `fixtures/sample_webi_variables.json` — a Webi doc fixture with a `variables[]` array exercising all four tiers.
- **Modify** `converters/webi.mjs` — IR gains `variables[]` and block-column `formula`; `convertWebiToWorkbook` calls the engine and returns `dataModelAdditions`.
- **Modify** `scripts/bo-rws.mjs` — add `getWebiVariables(id)`; retain element `dataExpression` formula text.
- **Modify** `scripts/sigma.mjs` — add `getDataModelSpec(id)` + `postDataModelSpec(spec)` (or reuse existing helpers) for the DM patch.
- **Modify** `scripts/migrate-webi.mjs` — apply `dataModelAdditions` to the DM, then POST the workbook.
- **Modify** `package.json` — `test` script runs smoke + both new test files.
- **Create** `scripts/e2e-webi-formula.mjs` — live end-to-end tie-out (commit gate).

---

## Task 1: Translation engine — tokenizer, parser, emitter, Tier-1 function map

**Files:**
- Create: `converters/webi-formula.mjs`
- Test: `test/webi-formula.test.mjs`

**Interfaces:**
- Produces: `translateWebiFormula(formula: string, opts?: { qualification?: 'dimension'|'measure'|'detail' }) → { sigma: string, kind: 'measure'|'dimension', placement: 'dm'|'workbook', warnings: string[] }`. In this task `placement` is always `'dm'` and only Tier-1 functions map; later tasks extend it.
- Produces (internal, used by later tasks): `tokenize(src) → Token[]`, `parse(tokens) → Node`, `emit(node, state) → string`, and the mutable maps `FN_MAP`, `WINDOW_FN`.

- [ ] **Step 1: Write the failing test**

Create `test/webi-formula.test.mjs`:

```js
#!/usr/bin/env node
/** Offline unit tests for the Webi → Sigma formula engine. */
import { translateWebiFormula } from '../converters/webi-formula.mjs';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };
const eq = (formula, expected, msg, opts) => {
  const r = translateWebiFormula(formula, opts);
  check(r.sigma === expected, `${msg}  (got: ${r.sigma})`);
  return r;
};

// ── Tier 1: direct function map + operators ──────────────────────────────────
eq('=[Revenue] - [Cost]', '[Revenue] - [Cost]', 'strips leading = and keeps subtraction');
eq('=[Revenue] / [Quantity]', '[Revenue] / [Quantity]', 'division passes through');
eq('=Average([Revenue])', 'Avg([Revenue])', 'Average → Avg');
eq('=Substr([Name]; 1; 3)', 'Mid([Name], 1, 3)', 'Substr → Mid, ; → ,');
eq('=Upper([Region]) + " " + Lower([City])', 'Upper([Region]) & " " & Lower([City])', 'text + → &, Upper/Lower kept');
eq('=If([Revenue] > 0 ; "Pos" ; "Neg")', 'If([Revenue] > 0, "Pos", "Neg")', 'If with ; separators → , ');
eq('=Sum([Revenue]) / Count([Order Id])', 'Sum([Revenue]) / Count([Order Id])', 'nested aggregates preserved');

// kind inference
check(translateWebiFormula('=Sum([Revenue])').kind === 'measure', 'outer aggregate → kind measure');
check(translateWebiFormula('=[Region]', { qualification: 'dimension' }).kind === 'dimension', 'qualification dimension respected');
check(translateWebiFormula('=[Revenue] - [Cost]').placement === 'dm', 'context-free → placement dm');

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-formula.test.mjs`
Expected: FAIL — `Cannot find module '../converters/webi-formula.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `converters/webi-formula.mjs`:

```js
/**
 * SAP Web Intelligence formula language → Sigma formula.
 *
 * A small, dependency-free tokenizer + shallow recursive-descent rewriter.
 * Handles function calls (Webi uses ';' arg separators), binary operators,
 * bracketed object refs `[Name]`, and string/number literals. Emits a Sigma
 * formula string plus metadata (kind, placement, warnings).
 *
 * Refs are emitted BARE (`[Name]`); the caller (webi.mjs) qualifies them by
 * the bound source-element name, exactly as it already does for measure formulas.
 */

// Tier 1 — direct name map (lowercased Webi fn → Sigma fn). Absent ⇒ keep as-is.
export const FN_MAP = {
  average: 'Avg', avg: 'Avg',
  substr: 'Mid', length: 'Len', pos: 'Search',
  formatdate: 'Text', todate: 'Date', currentdate: 'Today', truncate: 'Trunc',
  // sum/count/min/max/if/left/right/upper/lower/trim/replace/abs/round keep their name
};
// Tier 2 window/layout family (filled in Task 2). Presence forces placement 'workbook'.
export const WINDOW_FN = {};

const AGG_FN = new Set(['sum', 'count', 'avg', 'average', 'min', 'max', 'median']);

// ── Tokenizer ────────────────────────────────────────────────────────────────
export function tokenize(src) {
  const s = String(src || '').replace(/^\s*=/, '').trim();
  const toks = [];
  const two = { '<>': 1, '<=': 1, '>=': 1 };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[') { const e = s.indexOf(']', i); const ref = s.slice(i + 1, e < 0 ? s.length : e); toks.push({ t: 'ref', v: ref }); i = e < 0 ? s.length : e + 1; continue; }
    if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); toks.push({ t: 'str', v: s.slice(i + 1, e < 0 ? s.length : e) }); i = e < 0 ? s.length : e + 1; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) { let j = i + 1; while (j < s.length && /[0-9.]/.test(s[j])) j++; toks.push({ t: 'num', v: s.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; toks.push({ t: 'ident', v: s.slice(i, j) }); i = j; continue; }
    const pair = s.slice(i, i + 2);
    if (two[pair]) { toks.push({ t: 'op', v: pair }); i += 2; continue; }
    if ('+-*/&=<>'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if ('();,;'.includes(c)) { toks.push({ t: c === ';' ? 'sep' : (c === ',' ? 'sep' : 'punc'), v: c }); i++; continue; }
    // Unknown char — keep as raw punctuation so we never lose input.
    toks.push({ t: 'punc', v: c }); i++;
  }
  return toks;
}

// ── Parser (shallow recursive descent with precedence) ───────────────────────
export function parse(toks) {
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = v => { const t = next(); if (!t || t.v !== v) throw new Error(`expected '${v}'`); };

  function parseExpr() { return parseCompare(); }
  function parseCompare() {
    let left = parseAdd();
    while (peek() && peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) { const op = next().v; left = { t: 'bin', op, left, right: parseAdd() }; }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().t === 'op' && ['+', '-', '&'].includes(peek().v)) { const op = next().v; left = { t: 'bin', op, left, right: parseMul() }; }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && ['*', '/'].includes(peek().v)) { const op = next().v; left = { t: 'bin', op, left, right: parseUnary() }; }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && peek().v === '-') { next(); return { t: 'neg', arg: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('unexpected end');
    if (t.t === 'num') { next(); return { t: 'num', v: t.v }; }
    if (t.t === 'str') { next(); return { t: 'str', v: t.v }; }
    if (t.t === 'ref') { next(); return { t: 'ref', v: t.v }; }
    if (t.t === 'punc' && t.v === '(') { next(); const e = parseExpr(); expect(')'); return e; }
    if (t.t === 'ident') {
      const name = next().v;
      if (peek() && peek().t === 'punc' && peek().v === '(') {
        next();
        const args = [];
        if (!(peek() && peek().v === ')')) { args.push(parseExpr()); while (peek() && peek().t === 'sep') { next(); args.push(parseExpr()); } }
        expect(')');
        return { t: 'call', name, args };   // Task 3 attaches a context clause here
      }
      return { t: 'ident', v: name };        // bare identifier (e.g. a keyword literal)
    }
    throw new Error(`unexpected token ${t.t}:${t.v}`);
  }
  const node = parseExpr();
  return node;
}

// ── Emitter ──────────────────────────────────────────────────────────────────
export function emit(node, state) {
  switch (node.t) {
    case 'num': return node.v;
    case 'str': return `"${node.v}"`;
    case 'ref': return `[${node.v}]`;
    case 'ident': return node.v;
    case 'neg': return `-${emit(node.arg, state)}`;
    case 'bin': return `${emit(node.left, state)} ${node.op} ${emit(node.right, state)}`;
    case 'call': {
      const lc = node.name.toLowerCase();
      const mapped = FN_MAP[lc] || (node.name[0].toUpperCase() + node.name.slice(1));
      const args = node.args.map(a => emit(a, state)).join(', ');
      return `${mapped}(${args})`;
    }
    default: throw new Error(`cannot emit ${node.t}`);
  }
}

// ── Public entry ─────────────────────────────────────────────────────────────
export function translateWebiFormula(formula, opts = {}) {
  const warnings = [];
  const state = { warnings, placement: 'dm' };
  let sigma;
  try {
    const ast = parse(tokenize(formula));
    sigma = emit(ast, state);
    state.ast = ast;
  } catch (e) {
    // Never throw — Task 4 replaces this with a proper stub.
    warnings.push(`could not parse Webi formula (${e.message}) — left raw: ${formula}`);
    sigma = String(formula || '').replace(/^\s*=/, '').trim();
  }
  const kind = opts.qualification === 'measure' ? 'measure'
    : opts.qualification === 'dimension' || opts.qualification === 'detail' ? 'dimension'
    : (state.ast && state.ast.t === 'call' && AGG_FN.has(state.ast.name.toLowerCase())) ? 'measure' : 'dimension';
  return { sigma, kind, placement: state.placement, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-formula.test.mjs`
Expected: PASS — all Tier-1, kind, and placement checks green.

- [ ] **Step 5: Commit**

```bash
git add converters/webi-formula.mjs test/webi-formula.test.mjs
git commit -m "feat(webi): formula engine — tokenizer/parser/emitter + Tier-1 map"
```

---

## Task 2: Layout family (Tier 2) → window functions + placement flip

**Files:**
- Modify: `converters/webi-formula.mjs` (fill `WINDOW_FN`, special-case emit)
- Test: `test/webi-formula.test.mjs` (add cases)

**Interfaces:**
- Consumes: `FN_MAP`, `WINDOW_FN`, `emit`, `state` from Task 1.
- Produces: any `WINDOW_FN` call sets `state.placement = 'workbook'`; the returned object's `placement` reflects it.

- [ ] **Step 1: Write the failing test** (append to `test/webi-formula.test.mjs`, before the summary):

```js
// ── Tier 2: layout / window family → placement workbook ──────────────────────
const prev = eq('=Previous([Revenue])', 'Lag([Revenue])', 'Previous → Lag');
check(prev.placement === 'workbook', 'Previous forces placement workbook');
eq('=RunningSum([Revenue])', 'CumulativeSum([Revenue])', 'RunningSum → CumulativeSum');
eq('=RunningCount([Order Id])', 'CumulativeCount([Order Id])', 'RunningCount → CumulativeCount');
eq('=Rank([Revenue])', 'Rank([Revenue])', 'Rank → Rank');
eq('=Percentage([Revenue])', 'PercentOfTotal([Revenue])', 'Percentage → PercentOfTotal');
check(translateWebiFormula('=Rank([Revenue])').placement === 'workbook', 'Rank forces placement workbook');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-formula.test.mjs`
Expected: FAIL — `Previous` emits `Previous(...)` not `Lag(...)`, placement `dm`.

- [ ] **Step 3: Write minimal implementation**

In `converters/webi-formula.mjs`, fill `WINDOW_FN`:

```js
export const WINDOW_FN = {
  previous: 'Lag', runningsum: 'CumulativeSum', runningcount: 'CumulativeCount',
  runningaverage: 'CumulativeAvgTODO', rank: 'Rank', percentage: 'PercentOfTotal',
};
```

Then in `emit`, replace the `case 'call'` body with:

```js
    case 'call': {
      const lc = node.name.toLowerCase();
      const args = node.args.map(a => emit(a, state)).join(', ');
      if (WINDOW_FN[lc]) {
        state.placement = 'workbook';
        if (lc === 'runningaverage') { state.warnings.push('RunningAverage has no single Sigma window fn — emitted as CumulativeSum/CumulativeCount ratio; verify.'); return `(CumulativeSum(${args}) / CumulativeCount(${args}))`; }
        return `${WINDOW_FN[lc]}(${args})`;
      }
      const mapped = FN_MAP[lc] || (node.name[0].toUpperCase() + node.name.slice(1));
      return `${mapped}(${args})`;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-formula.test.mjs`
Expected: PASS — window mappings correct, placement flips to `workbook`.

- [ ] **Step 5: Commit**

```bash
git add converters/webi-formula.mjs test/webi-formula.test.mjs
git commit -m "feat(webi): Tier-2 layout family → window functions + placement flip"
```

---

## Task 3: Context operators (Tier 3) — In / ForEach / ForAll

**Files:**
- Modify: `converters/webi-formula.mjs` (parse trailing context clause, emit best-effort + warn)
- Test: `test/webi-formula.test.mjs`

**Interfaces:**
- Consumes: `parse`, `emit`, `WINDOW_FN` from Tasks 1–2.
- Produces: a `call` node may carry `ctx = { op: 'In'|'ForEach'|'ForAll', dims: string[] }`; any context clause sets `state.placement = 'workbook'`.

- [ ] **Step 1: Write the failing test** (append):

```js
// ── Tier 3: context operators ────────────────────────────────────────────────
const inCtx = translateWebiFormula('=Sum([Revenue]) In ([Region])');
check(inCtx.placement === 'workbook', 'In context forces placement workbook');
check(/Sum\(\[Revenue\]\)/.test(inCtx.sigma), 'In: base aggregate preserved');
check(inCtx.warnings.some(w => /context .*In.*Region/i.test(w)), 'In: emits a grouping warning naming the dims');
const feCtx = translateWebiFormula('=RunningSum([Revenue]) ForEach ([Month])');
check(feCtx.warnings.some(w => /ForEach/i.test(w)), 'ForEach warns for manual grouping/reset review');
check(feCtx.placement === 'workbook', 'ForEach forces placement workbook');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-formula.test.mjs`
Expected: FAIL — parser throws on `In (...)` (falls to raw-passthrough), no context warning.

- [ ] **Step 3: Write minimal implementation**

In `parse`, after building a `call` node in `parsePrimary`, check for a trailing context clause before returning it. Replace the `return { t: 'call', name, args };` line with:

```js
        const call = { t: 'call', name, args };
        const kw = peek();
        if (kw && kw.t === 'ident' && /^(in|foreach|forall)$/i.test(kw.v)) {
          next();
          expect('(');
          const dims = [];
          if (peek() && peek().t === 'ref') { dims.push(next().v); while (peek() && peek().t === 'sep') { next(); if (peek() && peek().t === 'ref') dims.push(next().v); } }
          expect(')');
          call.ctx = { op: kw.v.replace(/^\w/, c => c.toUpperCase()), dims };
        }
        return call;
```

In `emit`, at the top of `case 'call'`, after computing `args`, handle the context clause:

```js
      if (node.ctx) {
        state.placement = 'workbook';
        const dimList = node.ctx.dims.join('; ');
        state.warnings.push(`context operator ${node.ctx.op}(${dimList}) on ${node.name}() — set the Sigma grouping/partition to [${node.ctx.dims.join('], [')}] and verify (auto-grouping not applied in v1).`);
      }
```

(The base call still emits normally; only a warning + placement flip is applied in v1 — exact Sigma window partition arg-forms are validated live in Task 8.)

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-formula.test.mjs`
Expected: PASS — context clause parsed, placement `workbook`, dims named in the warning.

- [ ] **Step 5: Commit**

```bash
git add converters/webi-formula.mjs test/webi-formula.test.mjs
git commit -m "feat(webi): Tier-3 context operators (In/ForEach/ForAll) best-effort + warn"
```

---

## Task 4: Warn+stub tail (Tier 4) + never-throw guarantee

**Files:**
- Modify: `converters/webi-formula.mjs` (stub for NoFilter / `@`-functions / unknown; harden never-throw)
- Test: `test/webi-formula.test.mjs`

**Interfaces:**
- Consumes: `translateWebiFormula` from Tasks 1–3.
- Produces: for a stubbed formula, `sigma` is a safe passthrough and `warnings[0]` carries the raw Webi text + a specific how-to; `placement` stays `dm` unless a window/context node already flipped it.

- [ ] **Step 1: Write the failing test** (append):

```js
// ── Tier 4: warn + stub, never throw ─────────────────────────────────────────
const nf = translateWebiFormula('=NoFilter(Sum([Revenue]))');
check(nf.warnings.some(w => /NoFilter/.test(w) && /unfiltered element/i.test(w)), 'NoFilter → specific how-to warning');
const at = translateWebiFormula('=@Prompt("Enter region")');
check(at.warnings.some(w => /@Prompt/i.test(w) && /control|parameter/i.test(w)), '@Prompt → model as control/parameter');
const bad = translateWebiFormula('=Sum([Revenue] ((( ');
check(Array.isArray(bad.warnings) && typeof bad.sigma === 'string', 'malformed input degrades to warned stub, never throws');
const unknown = translateWebiFormula('=NoSuchFn([X])');
check(unknown.warnings.some(w => /NoSuchFn/i.test(w)), 'unknown function is flagged for manual review');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-formula.test.mjs`
Expected: FAIL — NoFilter/@Prompt produce no specific warning; unknown fn silently title-cased.

- [ ] **Step 3: Write minimal implementation**

Add a known-Sigma-function allowlist and detection near the maps:

```js
const KNOWN_SIGMA = new Set(['sum','count','countdistinct','avg','min','max','median','if','switch','coalesce','isnull','left','right','mid','len','search','upper','lower','trim','replace','text','date','today','abs','round','trunc','lag','lead','cumulativesum','cumulativecount','rank','rankdense','percentoftotal']);
```

In `emit`'s `case 'call'`, before the default mapping, handle NoFilter, `@`-functions (they tokenize as `punc '@'` + ident), and unknown functions. Replace the tail of `case 'call'` with:

```js
      const lc = node.name.toLowerCase();
      if (lc === 'nofilter') { state.warnings.push(`NoFilter() has no direct Sigma equivalent — compute this on a separate UNFILTERED element (a duplicate element without the report filter) and reference it. Raw: NoFilter(...)`); return node.args.map(a => emit(a, state)).join(', ') || 'Null()'; }
      const args = node.args.map(a => emit(a, state)).join(', ');
      const mappedName = FN_MAP[lc] || (node.name[0].toUpperCase() + node.name.slice(1));
      if (!WINDOW_FN[lc] && !FN_MAP[lc] && !KNOWN_SIGMA.has(mappedName.toLowerCase())) {
        state.warnings.push(`function ${node.name}() has no known Sigma mapping — emitted verbatim; review manually.`);
      }
      return `${mappedName}(${args})`;
```

Handle `@`-functions: in `tokenize`, when `c === '@'` and the next char is a letter, emit `{ t: 'ident', v: '@' + word }`. Then in `translateWebiFormula`, before parsing, detect `/@\w+/` and push the mapped warning (mirror `bobj.mjs::translateBobjExpr`: `@Prompt` → control/parameter, `@Variable` → substitute, `@Select` → inline, `@Aggregate_Aware` → first branch), and strip the `@fn(...)` to its first arg so parsing proceeds.

Finally, wrap the `emit` call in `translateWebiFormula`'s `try` so any emit-time throw also degrades to the raw-passthrough stub (already covered by the existing try/catch — verify the `@` handling sits inside it).

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-formula.test.mjs`
Expected: PASS — all Tier-4 + never-throw checks green.

- [ ] **Step 5: Commit**

```bash
git add converters/webi-formula.mjs test/webi-formula.test.mjs
git commit -m "feat(webi): Tier-4 warn+stub (NoFilter/@-fns/unknown) + never-throw"
```

---

## Task 5: Integrate into `webi.mjs` — variables IR, dataModelAdditions, name resolution

**Files:**
- Modify: `converters/webi.mjs`
- Create: `fixtures/sample_webi_variables.json`
- Create: `test/webi-integration.test.mjs`

**Interfaces:**
- Consumes: `translateWebiFormula` (Task 1–4).
- Produces: `convertWebiToWorkbook(input, options)` returns `{ workbook, dataModelAdditions: { metrics: Array<{id,name,formula}>, columns: Array<{id,name,formula}> }, warnings, stats }`. `normalizeWebiDocument` output gains `variables: Array<{ name, qualification, formula }>`.

- [ ] **Step 1: Write the failing test**

Create `fixtures/sample_webi_variables.json` — the `sample_webi.json` doc plus a `variables` array and one block that references a variable:

```json
{
  "document": {
    "name": "Retail Performance",
    "variables": [
      { "name": "Margin Pct", "qualification": "measure", "formula": "=Sum([Net Revenue]) / Sum([Gross Revenue])" },
      { "name": "Running Revenue", "qualification": "measure", "formula": "=RunningSum([Net Revenue])" }
    ],
    "reports": [
      { "name": "Revenue Overview", "blocks": [
        { "kind": "VTable", "title": "Detail", "dimensions": ["Customer Region"], "measures": ["Net Revenue", "Margin Pct", "Running Revenue"] }
      ] }
    ],
    "filters": []
  }
}
```

Create `test/webi-integration.test.mjs`:

```js
#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertWebiToWorkbook } from '../converters/webi.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => JSON.parse(readFileSync(join(root, p), 'utf8'));
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) failures++; };

const r = convertWebiToWorkbook(read('fixtures/sample_webi_variables.json'), {
  dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View',
  measureMap: { 'Net Revenue': 'Sum([Net Revenue])', 'Gross Revenue': 'Sum([Gross Revenue])' }, schemaVersion: 1,
});

// context-free measure → data-model addition (metric), qualified by source name
check(r.dataModelAdditions.metrics.some(m => m.name === 'Margin Pct' && /PercentOfTotal|\/ Sum/.test(m.formula)), 'Margin Pct → dataModelAdditions.metric');
check(!r.dataModelAdditions.metrics.some(m => m.name === 'Running Revenue'), 'Running Revenue is NOT a DM addition (it is layout-dependent)');

// layout-dependent → workbook element calc column
const cols = r.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(cols.some(c => c.name === 'Running Revenue' && /CumulativeSum/.test(c.formula)), 'Running Revenue → workbook calc column (CumulativeSum)');

// refs are qualified by the source element name, no circular refs
check(cols.every(c => !(c.name && `[${c.name}]` === c.formula)), 'no self-referential column formulas');
check(r.dataModelAdditions.metrics.every(m => /Order Fact View\//.test(m.formula)), 'DM-addition formulas qualified by source name');

console.log(`\n${failures ? '❌ ' + failures + ' failed' : '✅ all passed'}`);
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-integration.test.mjs`
Expected: FAIL — `r.dataModelAdditions` is undefined; variables not translated.

- [ ] **Step 3: Write minimal implementation**

In `converters/webi.mjs`:

1. In `normalizeWebiDocument`, after building `filters`, collect variables:

```js
  const variables = [];
  const rawVars = root.variables || input?.variables;
  if (Array.isArray(rawVars)) for (const v of rawVars) variables.push({
    name: v.name || v.variableName || 'Variable',
    qualification: (v.qualification || v.type || '').toString().toLowerCase() || undefined,
    formula: v.formula || v.definition || v.expression || '',
  });
  return { name, reports, filters, variables };
```

2. Import the engine at the top: `import { translateWebiFormula } from './webi-formula.mjs';`

3. In `convertWebiToWorkbook`, after `const doc = normalizeWebiDocument(input);`, translate variables and split by placement. Reuse the existing `q()` source-name qualifier for refs:

```js
  const dataModelAdditions = { metrics: [], columns: [] };
  const workbookVarFormula = new Map();   // variable name → qualified workbook formula
  for (const v of doc.variables) {
    if (!v.formula) continue;
    const tr = translateWebiFormula(v.formula, { qualification: v.qualification });
    tr.warnings.forEach(w => warnings.push(`Variable "${v.name}": ${w}`));
    const qualified = q(tr.sigma);
    if (tr.placement === 'dm') {
      const bucket = tr.kind === 'measure' ? dataModelAdditions.metrics : dataModelAdditions.columns;
      if (!bucket.some(x => x.name === v.name)) bucket.push({ id: uid('add'), name: v.name, formula: qualified });
    } else {
      workbookVarFormula.set(v.name, qualified);
    }
  }
```

4. In `blockToElement`, when a measure/dimension name matches a `workbookVarFormula` entry, emit its calc formula instead of the default `Sum([name])`. Thread `workbookVarFormula` into `blockToElement` (add a parameter) and, where measure columns are built, use:

```js
      const vf = workbookVarFormula.get(m);
      cols.push({ id, name: displayName(m), formula: vf || measFormula(m) });
```

(DM-placed variables resolve automatically because they become metrics on the View element referenced by name via `measureMap`; extend `measFormula` lookups so a block measure named after a DM-addition metric resolves — pass the additions' names into `measureMap` as `Sum` is not needed; the metric ref is just `[source/Name]`. Simplest: after building `dataModelAdditions`, add each DM metric to a local `measureMap` copy as `q([Name])`.)

5. Return `dataModelAdditions` in the result object alongside `workbook`, `warnings`, `stats`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/webi-integration.test.mjs`
Expected: PASS — split, qualification, and no-circular checks green.

- [ ] **Step 5: Wire into `npm test` and run the full suite**

Edit `package.json` `scripts.test`:

```json
    "test": "node test/smoke.mjs && node test/webi-formula.test.mjs && node test/webi-integration.test.mjs",
```

Run: `npm test`
Expected: PASS — smoke (unchanged), formula engine, and integration all green.

- [ ] **Step 6: Commit**

```bash
git add converters/webi.mjs fixtures/sample_webi_variables.json test/webi-integration.test.mjs package.json
git commit -m "feat(webi): translate variables into dataModelAdditions + workbook calc columns"
```

---

## Task 6: Extraction — fetch `/variables`, retain element formulas

**Files:**
- Modify: `scripts/bo-rws.mjs`
- Test: `test/webi-integration.test.mjs` (add a normalize-shape assertion using an inline mock — no network)

**Interfaces:**
- Produces: `getWebiVariables(id) → Promise<Array<{ name, qualification, dataType, formula }>>`; `getWebiDocument(id)` result gains `document.variables` and block-level `dataExpression` formula text retained.

- [ ] **Step 1: Write the failing test**

Add to `test/webi-integration.test.mjs` a pure-shape check that the converter reads a `variables[]` provided in the friendly shape (already covered by Task 5 fixture) AND that an element `dataExpression` formula is retained on a block column. Append:

```js
// element-level in-place formula (not a named variable) is retained on the block column
const r2 = convertWebiToWorkbook({ document: { name: 'D', reports: [ { name: 'R', blocks: [
  { kind: 'VTable', title: 'T', dimensions: [{ name: 'Bucket', formula: '=If([Revenue] > 1000 ; "High" ; "Low")' }], measures: ['Net Revenue'] } ] } ], variables: [], filters: [] } },
  { dataModelId: 'DM', dataModelElementId: 'VIEW', sourceName: 'Order Fact View', measureMap: {}, schemaVersion: 1 });
const r2cols = r2.workbook.pages.flatMap(p => p.elements).flatMap(e => e.columns || []);
check(r2cols.some(c => c.name === 'Bucket' && /If\(\[Order Fact View\/Revenue\] > 1000, "High", "Low"\)/.test(c.formula)), 'block-column dataExpression formula translated + qualified');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/webi-integration.test.mjs`
Expected: FAIL — the dimension is treated as a plain name; its `formula` is ignored and no `If(...)` is produced.

- [ ] **Step 3: Write minimal implementation**

(a) `converters/webi.mjs`: in `normalizeBlock`, keep the raw formula on dimension/measure entries. Change `exprNames` to `exprItems` returning `{ name, formula }`, and adapt `dimensions`/`measures` to arrays of `{name, formula}` OR keep back-compat by storing a parallel `formulaByName` map on the block. Minimal approach: build `block.formulaByName = {}` mapping name → raw formula for any dim/measure object carrying a `formula`/`expression`. Then in `blockToElement`, when a column is built, if `block.formulaByName[name]` exists, translate it via `translateWebiFormula`, qualify with `q()`, and use that formula (push warnings prefixed with the block title).

(b) `scripts/bo-rws.mjs`: add

```js
export async function getWebiVariables(id) {
  let list = [];
  try { list = asArray((await getJson(`/raylight/v1/documents/${id}/variables`)).variables?.variable); } catch { return []; }
  const out = [];
  for (const v of list) {
    let def = v.definition || v.formula;
    if (!def && (v.id ?? v.variableId) != null) {
      try { const one = await getJson(`/raylight/v1/documents/${id}/variables/${v.id ?? v.variableId}`); def = one.variable?.definition || one.definition; } catch { /* tolerate */ }
    }
    out.push({ name: v.name, qualification: (v.qualification || '').toLowerCase() || undefined, dataType: v.dataType, formula: def || '' });
  }
  return out;
}
```

and in `getWebiDocument`, call `getWebiVariables(id)` and attach as `document.variables`; when walking `/reports/{rid}/elements`, retain each expression's `formula`/`dataExpression` text alongside its name (so `normalizeBlock` sees `formulaByName`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — block `dataExpression` formulas translate and qualify; all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add scripts/bo-rws.mjs converters/webi.mjs test/webi-integration.test.mjs
git commit -m "feat(webi): fetch /variables + retain element formulas in extraction"
```

---

## Task 7: Wiring — apply `dataModelAdditions` to the DM, then POST the workbook

**Files:**
- Modify: `scripts/sigma.mjs` (add `getDataModelSpec` / `postDataModelSpec` if absent)
- Modify: `scripts/migrate-webi.mjs`
- Test: manual dry-run note (network step; real assertion happens in Task 8)

**Interfaces:**
- Consumes: `convertWebiToWorkbook(...).dataModelAdditions`.
- Produces: `applyDataModelAdditions(dmId, additions, viewElementId) → Promise<{ addedMetrics, addedColumns, skipped }>` in `migrate-webi.mjs` (or `sigma.mjs`).

- [ ] **Step 1: Write the failing test**

Add a pure-function unit for the merge logic (no network). Create `test/dm-merge.test.mjs`:

```js
#!/usr/bin/env node
import { mergeAdditionsIntoView } from '../scripts/dm-merge.mjs';
let failures = 0; const check = (c, m) => { console.log(`${c?'✅':'❌'} ${m}`); if (!c) failures++; };

const spec = { pages: [{ elements: [ { id: 'VIEW', name: 'Order Fact View', columns: [{ id: 'c1', name: 'Net Revenue', formula: '[.../Net Revenue]' }], metrics: [] } ] }] };
const additions = { metrics: [{ id: 'a1', name: 'Margin Pct', formula: 'X' }, { id: 'a2', name: 'Net Revenue', formula: 'DUP' }], columns: [] };
const res = mergeAdditionsIntoView(spec, 'VIEW', additions);
const view = spec.pages[0].elements[0];
check(view.metrics.some(m => m.name === 'Margin Pct'), 'new metric added to View');
check(!view.metrics.some(m => m.name === 'Net Revenue'), 'metric duplicating an existing column name is skipped');
check(res.skipped.includes('Net Revenue'), 'skip is reported');
console.log(`\n${failures?'❌ '+failures+' failed':'✅ all passed'}`); process.exit(failures?1:0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/dm-merge.test.mjs`
Expected: FAIL — `../scripts/dm-merge.mjs` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/dm-merge.mjs` (pure, testable):

```js
/** Merge dataModelAdditions into the named View element of a DM spec (in place).
 *  Dedupe by name against existing columns AND metrics; report skips. */
export function mergeAdditionsIntoView(spec, viewElementId, additions) {
  const el = (spec.pages || []).flatMap(p => p.elements || []).find(e => e.id === viewElementId);
  if (!el) throw new Error(`View element ${viewElementId} not found in DM spec`);
  el.metrics = el.metrics || []; el.columns = el.columns || []; el.order = el.order || [];
  const taken = new Set([...el.columns, ...el.metrics].map(x => x.name).filter(Boolean));
  const skipped = [];
  const add = (arr, item) => { if (taken.has(item.name)) { skipped.push(item.name); return false; } arr.push(item); taken.add(item.name); return true; };
  const addedMetrics = (additions.metrics || []).filter(m => add(el.metrics, m)).length;
  const addedColumns = (additions.columns || []).filter(c => { const ok = add(el.columns, c); if (ok) el.order.push(c.id); return ok; }).length;
  return { addedMetrics, addedColumns, skipped };
}
```

In `scripts/migrate-webi.mjs`, after conversion and before `postWorkbook`:

```js
  if (result.dataModelAdditions && (result.dataModelAdditions.metrics.length || result.dataModelAdditions.columns.length)) {
    const spec = await getDataModelSpec(binding.dataModelId);           // GET /v2/datasets/{id} spec (YAML→JSON per project note)
    const merge = mergeAdditionsIntoView(spec, binding.viewElementId, result.dataModelAdditions);
    console.log(`  DM additions: +${merge.addedMetrics} metrics, +${merge.addedColumns} cols${merge.skipped.length ? `, skipped ${merge.skipped.join(', ')}` : ''}`);
    await postDataModelSpec(spec);                                      // POST updated spec
  }
```

Add `getDataModelSpec` / `postDataModelSpec` to `scripts/sigma.mjs` following the existing `postWorkbook`/`referenceWorkbookSchemaVersion` auth+fetch pattern (reuse the Sigma token + base URL already wired there). Import `mergeAdditionsIntoView` into `migrate-webi.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/dm-merge.test.mjs` then `npm test` (add `dm-merge.test.mjs` to the `test` script).
Expected: PASS — merge dedupes and reports skips; full suite green.

- [ ] **Step 5: Commit**

```bash
git add scripts/dm-merge.mjs scripts/migrate-webi.mjs scripts/sigma.mjs test/dm-merge.test.mjs package.json
git commit -m "feat(webi): apply dataModelAdditions to DM (dedupe by name) before workbook POST"
```

---

## Task 8: Live end-to-end tie-out — the commit gate

**Files:**
- Create: `scripts/e2e-webi-formula.mjs`
- Uses: CSA.TJ connection `cb2f5180-641f-47bd-8efa-da9d590d855a`, test folder `9ca9bf60-6a33-43dd-967d-1ba6352c54bb`, token via `~/sigma-migration/env` (or the powerbi-to-sigma `get-token.sh`).

**Interfaces:**
- Consumes: the full pipeline (universe→DM, then Webi variables → additions + workbook).

- [ ] **Step 1: Write the E2E harness**

Create `scripts/e2e-webi-formula.mjs` that, against the live Sigma API:
1. Converts `fixtures/efashion_universe.xml` → data model; POSTs it to the CSA.TJ connection/test folder; records the View element id + measureMap.
2. Converts a bundled Webi fixture (all four tiers: a context-free `Margin Pct`, a layout `Running Revenue`, an `In`-context sum, and a `NoFilter`/`@Prompt` stub) with that binding → `{ workbook, dataModelAdditions }`.
3. Applies `dataModelAdditions` to the posted DM (GET spec → `mergeAdditionsIntoView` → POST).
4. POSTs the workbook.
5. `describe` + `query` the workbook's table element via the Sigma API.

- [ ] **Step 2: Assert tie-out (the gate)**

The script asserts and exits non-zero on any failure:
- **Zero error-typed columns** in `describe` (no `--metric-…`-style error columns beyond the known benign `SELECT *` artifact).
- **`Margin Pct`** value equals `Net Revenue / Gross Revenue` computed independently from a raw `query` of the two base measures (within float tolerance).
- **`Running Revenue`** is monotonically non-decreasing across the ordered rows (running-total sanity).
- **`In`-context sum** groups at the expected grain (spot-check one region's total against a raw grouped query).
- Print each assertion with ✅/❌.

- [ ] **Step 3: Run it live**

Run: `set -a; . ~/.sigma-migration/env; set +a; node scripts/e2e-webi-formula.mjs`
Expected: PASS — all tie-out assertions green on real warehouse data.

- [ ] **Step 4: Clean up**

The script deletes the test workbook and data model it created (DELETE `/v2/workbooks/{id}` and `/v2/files/{dmId}`), leaving the org clean. Verify nothing test-created remains.

- [ ] **Step 5: Commit (only if green)**

```bash
git add scripts/e2e-webi-formula.mjs fixtures/*.json
git commit -m "test(webi): live end-to-end tie-out for the formula translator (commit gate)"
```

- [ ] **Step 6: Update SKILL.md workflow note**

Add a one-paragraph note to `SKILL.md` Phase 3 that Webi variables now convert (split DM/workbook), point to the warnings for `NoFilter`/`@`/`ForEach`, and that `migrate-webi.mjs` patches the DM before creating the workbook. Commit.

---

## Self-Review

**Spec coverage:**
- Extraction of `/variables` + formula text → Task 6. ✅
- IR extension (`variables[]`, block formula) → Tasks 5–6. ✅
- Engine (tokenizer/parser/emitter, Tiers 1–4) → Tasks 1–4. ✅
- Split-by-kind classifier + `dataModelAdditions` → Tasks 2–5. ✅
- DM-patch wiring + idempotency (dedupe by name) → Task 7. ✅
- Unit tests per tier + malformed input → Tasks 1–4; classifier/split → Task 5. ✅
- Live E2E tie-out gate → Task 8. ✅
- Error handling / never-throw → Task 4 + Task 1 try/catch. ✅
- Non-goals (full index, full ForEach semantics, NoFilter auto, MCP/browser mirror) respected — Tiers cap scope; context ops are warn-only. ✅

**Placeholder scan:** No TBD/TODO left except the intentional `CumulativeAvgTODO` sentinel replaced in Task 2 Step 3 with the ratio form — confirm it does not ship (the emit branch returns the ratio, never the sentinel). Fix if the sentinel is reachable.

**Type consistency:** `translateWebiFormula → { sigma, kind, placement, warnings }` used identically in Tasks 1–5. `dataModelAdditions = { metrics[], columns[] }` consistent across Tasks 5, 7, 8. `mergeAdditionsIntoView(spec, viewElementId, additions)` signature matches its test and caller. `getWebiVariables`, `getDataModelSpec`, `postDataModelSpec` names consistent across Tasks 6–8.

**Note for implementer:** exact Sigma window-function optional-arg forms (partition/order) for `In`/`ForEach` grouping are deliberately NOT hardcoded — v1 emits the base call + a warning and validates real grouping behavior live in Task 8. If Task 8 reveals a clean partition-arg form, fold it into the emitter as a fast-follow, not a v1 blocker.
