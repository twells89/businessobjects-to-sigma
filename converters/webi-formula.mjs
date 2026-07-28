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
// Tier 2 window/layout family. Presence forces placement 'workbook'.
export const WINDOW_FN = {
  previous: 'Lag', runningsum: 'CumulativeSum', runningcount: 'CumulativeCount',
  rank: 'Rank', percentage: 'PercentOfTotal',
};
// RunningAverage has no single Sigma window fn — handled specially in `emit`
// as a CumulativeSum/CumulativeCount ratio rather than via WINDOW_FN.
const WINDOW_SPECIAL = new Set(['runningaverage']);

// Tier 3 context-operator canonical casing, independent of input case
// (Webi source may use any casing — `foreach`, `FOREACH`, `ForEach`, ...).
const CTX_CANON = { in: 'In', foreach: 'ForEach', forall: 'ForAll' };

// Tier 4 — known-Sigma-function allowlist. A mapped/passthrough call name
// that lands outside this set (and outside FN_MAP/WINDOW_FN/WINDOW_SPECIAL)
// gets an "unknown function" warning rather than being silently emitted.
const KNOWN_SIGMA = new Set(['sum', 'count', 'countdistinct', 'avg', 'min', 'max', 'median', 'if', 'switch', 'coalesce', 'isnull', 'left', 'right', 'mid', 'len', 'search', 'upper', 'lower', 'trim', 'replace', 'text', 'date', 'today', 'abs', 'round', 'trunc', 'lag', 'lead', 'cumulativesum', 'cumulativecount', 'rank', 'rankdense', 'percentoftotal']);

const AGG_FN = new Set(['sum', 'count', 'avg', 'average', 'min', 'max', 'median']);
// Functions/literals that indicate a text-typed operand, so a '+' between them
// is Webi string concatenation and must emit as Sigma's '&' (not numeric '+').
const TEXT_FN = new Set(['upper', 'lower', 'trim', 'substr', 'mid', 'left', 'right', 'formatdate', 'text', 'replace']);
function isTextNode(node) {
  if (!node) return false;
  switch (node.t) {
    case 'str': return true;
    case 'call': return TEXT_FN.has(node.name.toLowerCase());
    case 'bin': return node.op === '&' || (node.op === '+' && (isTextNode(node.left) || isTextNode(node.right)));
    default: return false;
  }
}
// Kind inference must find an aggregate ANYWHERE in the tree (e.g. a ratio of
// two aggregates like `Sum(...) / Count(...)` has a `bin` root, not a `call`),
// not only at the AST root — otherwise ratio-style measures misroute as dimensions.
function hasAggregate(node) {
  if (!node) return false;
  switch (node.t) {
    case 'call': return AGG_FN.has(node.name.toLowerCase()) || node.args.some(hasAggregate);
    case 'bin': return hasAggregate(node.left) || hasAggregate(node.right);
    case 'neg': return hasAggregate(node.arg);
    default: return false;
  }
}

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
    // Universe/report '@' functions (@Prompt, @Variable, ...) — tokenize `@word` as
    // a single ident so a stray one (the pre-parse strip below normally removes
    // these first) still degrades to a plain unknown-fn call rather than a stray
    // 'punc' token that would otherwise fail to parse.
    if (c === '@' && /[A-Za-z_]/.test(s[i + 1] || '')) { let j = i + 1; while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++; toks.push({ t: 'ident', v: '@' + s.slice(i + 1, j) }); i = j; continue; }
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
        const call = { t: 'call', name, args };
        const kw = peek();
        if (kw && kw.t === 'ident' && /^(in|foreach|forall)$/i.test(kw.v)) {
          next();
          expect('(');
          const dims = [];
          if (peek() && peek().t === 'ref') { dims.push(next().v); while (peek() && peek().t === 'sep') { next(); if (peek() && peek().t === 'ref') dims.push(next().v); } }
          expect(')');
          call.ctx = { op: CTX_CANON[kw.v.toLowerCase()] || kw.v, dims };
        }
        return call;
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
    case 'bin': {
      // Webi's '+' doubles as text concatenation; Sigma requires '&' for that.
      const op = node.op === '+' && (isTextNode(node.left) || isTextNode(node.right)) ? '&' : node.op;
      return `${emit(node.left, state)} ${op} ${emit(node.right, state)}`;
    }
    case 'call': {
      const lc = node.name.toLowerCase();
      const args = node.args.map(a => emit(a, state)).join(', ');
      if (node.ctx) {
        state.placement = 'workbook';
        const dimList = node.ctx.dims.join('; ');
        state.warnings.push(`context operator ${node.ctx.op}(${dimList}) on ${node.name}() — set the Sigma grouping/partition to [${node.ctx.dims.join('], [')}] and verify (auto-grouping not applied in v1).`);
      }
      // Tier 4 — NoFilter() has no direct Sigma equivalent. Warn with the specific
      // how-to and strip to the inner args so the rest of the formula still emits.
      if (lc === 'nofilter') {
        state.warnings.push(`NoFilter() has no direct Sigma equivalent — compute this on a separate UNFILTERED element (a duplicate element without the report filter) and reference it. Raw: NoFilter(${args})`);
        return args || 'Null()';
      }
      if (WINDOW_FN[lc] || WINDOW_SPECIAL.has(lc)) {
        state.placement = 'workbook';
        if (lc === 'runningaverage') {
          state.warnings.push('RunningAverage has no single Sigma window fn — emitted as ratio; verify.');
          return `(CumulativeSum(${args}) / CumulativeCount(${args}))`;
        }
        return `${WINDOW_FN[lc]}(${args})`;
      }
      const mappedName = FN_MAP[lc] || (node.name[0].toUpperCase() + node.name.slice(1));
      // Tier 4 — anything not mapped, not a window fn, and not a known Sigma
      // builtin is emitted verbatim but flagged for manual review.
      if (!WINDOW_FN[lc] && !FN_MAP[lc] && !KNOWN_SIGMA.has(mappedName.toLowerCase())) {
        state.warnings.push(`function ${node.name}() has no known Sigma mapping — emitted verbatim; review manually.`);
      }
      return `${mappedName}(${args})`;
    }
    default: throw new Error(`cannot emit ${node.t}`);
  }
}

// Splits a `@fn(...)`'s inner text on top-level (paren-depth-0) ',' or ';'
// separators, so the first "argument" (or first Aggregate_Aware branch) can
// be pulled out without needing a full tokenizer pass.
function splitTopLevelArgs(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if ((ch === ',' || ch === ';') && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  parts.push(cur);
  return parts.map(x => x.trim());
}

// Mirrors bobj.mjs::translateBobjExpr's @-function warnings.
function atFnWarning(name) {
  const lc = name.toLowerCase();
  if (lc === 'prompt') return `@${name}() (runtime prompt) — model it as a Sigma control/parameter.`;
  if (lc === 'variable') return `@${name}() (session variable) — substitute a literal or a Sigma control.`;
  if (lc === 'select') return `@${name}() (reference to another object) — inline the target object's definition manually.`;
  if (lc === 'aggregate_aware') return `@${name}() — kept the first aggregate branch; verify table routing.`;
  return `@${name}() — no Sigma equivalent; review manually.`;
}

// Universe/report '@' functions (@Prompt, @Variable, @Select, @Aggregate_Aware,
// ...) have no Sigma equivalent and our tokenizer/parser don't understand their
// syntax. Detect them before parsing, push a specific how-to warning per kind,
// then strip each `@fn(...)` down to its first argument (or, for
// @Aggregate_Aware, its first branch) so the remainder of the expression still
// parses normally.
function stripAtFunctions(src, warnings) {
  let f = src;
  const re = /@(\w+)\s*\(/;
  let guard = 0;
  let m;
  while ((m = re.exec(f)) && guard++ < 20) {
    const name = m[1];
    const openIdx = m.index + m[0].length - 1; // index of the '('
    let depth = 1, i = openIdx + 1;
    while (i < f.length && depth > 0) {
      if (f[i] === '(') depth++;
      else if (f[i] === ')') depth--;
      i++;
    }
    const closed = depth === 0;
    const closeIdx = closed ? i - 1 : f.length;
    const inner = f.slice(openIdx + 1, closeIdx);
    const firstArg = splitTopLevelArgs(inner)[0] || '';
    warnings.push(`${atFnWarning(name)} Raw: ${m[0]}${inner}${closed ? ')' : ''}`);
    f = f.slice(0, m.index) + firstArg + f.slice(closeIdx + (closed ? 1 : 0));
  }
  return f;
}

// ── Public entry ─────────────────────────────────────────────────────────────
export function translateWebiFormula(formula, opts = {}) {
  const warnings = [];
  const state = { warnings, placement: 'dm' };
  let sigma;
  try {
    let f = String(formula || '').replace(/^\s*=/, '').trim();
    f = stripAtFunctions(f, warnings);
    const ast = parse(tokenize(f));
    sigma = emit(ast, state);
    state.ast = ast;
  } catch (e) {
    // Never throw — any failure anywhere above (malformed input, an
    // unsupported construct, an @-function edge case the strip above didn't
    // fully clean up, ...) degrades to a warned, raw-passthrough stub.
    warnings.push(`could not parse Webi formula (${e.message}) — left raw: ${formula}`);
    sigma = String(formula || '').replace(/^\s*=/, '').trim();
  }
  const kind = opts.qualification === 'measure' ? 'measure'
    : opts.qualification === 'dimension' || opts.qualification === 'detail' ? 'dimension'
    : (state.ast && hasAggregate(state.ast)) ? 'measure' : 'dimension';
  return { sigma, kind, placement: state.placement, warnings };
}
