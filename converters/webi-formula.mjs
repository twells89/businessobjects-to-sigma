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
      if (WINDOW_FN[lc] || WINDOW_SPECIAL.has(lc)) {
        state.placement = 'workbook';
        if (lc === 'runningaverage') {
          state.warnings.push('RunningAverage has no single Sigma window fn — emitted as ratio; verify.');
          return `(CumulativeSum(${args}) / CumulativeCount(${args}))`;
        }
        return `${WINDOW_FN[lc]}(${args})`;
      }
      const mapped = FN_MAP[lc] || (node.name[0].toUpperCase() + node.name.slice(1));
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
    : (state.ast && hasAggregate(state.ast)) ? 'measure' : 'dimension';
  return { sigma, kind, placement: state.placement, warnings };
}
