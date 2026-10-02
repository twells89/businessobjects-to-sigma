/**
 * Crystal formula language → Sigma formula.
 *
 * This is a dependency-free expression parser for the high-frequency Crystal
 * subset used by the Meridian proof and common operational reports. It never
 * silently drops unsupported source: every result carries the raw formula and
 * warnings, and a parse failure emits a safe Null() stub.
 */

import { sigmaDisplayName } from '../helpers.mjs';

const FUNCTION_MAP = {
  iif: 'If',
  isnull: 'IsNull',
  totext: 'Text',
  cdate: 'Date',
  datevalue: 'Date',
  datetimevalue: 'Date',
  dateadd: 'DateAdd',
  datediff: 'DateDiff',
  year: 'Year',
  month: 'Month',
  day: 'Day',
  currentdate: 'Today',
  currentdatetime: 'Now',
  uppercase: 'Upper',
  lowercase: 'Lower',
  trim: 'Trim',
  left: 'Left',
  right: 'Right',
  mid: 'Mid',
  instr: 'Search',
  replace: 'Replace',
  len: 'Len',
  abs: 'Abs',
  round: 'Round',
  truncate: 'Trunc',
  sum: 'Sum',
  count: 'Count',
  distinctcount: 'CountDistinct',
  average: 'Avg',
  minimum: 'Min',
  maximum: 'Max',
};

const AGGREGATES = new Set(['sum', 'count', 'distinctcount', 'average', 'minimum', 'maximum']);
const KNOWN_SIGMA = new Set([
  'if', 'isnull', 'text', 'date', 'dateadd', 'datediff', 'year', 'month', 'day',
  'today', 'now', 'upper', 'lower', 'trim', 'left', 'right', 'mid', 'search',
  'replace', 'len', 'abs', 'round', 'trunc', 'sum', 'count', 'countdistinct',
  'avg', 'min', 'max', 'in',
]);

export function tokenizeCrystalFormula(source) {
  const text = String(source || '').trim();
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '{') {
      const end = text.indexOf('}', i + 1);
      if (end < 0) throw new Error('unterminated Crystal field reference');
      const raw = text.slice(i + 1, end).trim();
      const sigil = raw[0] === '@' || raw[0] === '?' ? raw[0] : '';
      tokens.push({
        type: sigil === '@' ? 'formula-ref' : sigil === '?' ? 'parameter-ref' : 'field-ref',
        value: sigil ? raw.slice(1) : raw,
      });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let value = '';
      i++;
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        if (text[i] === quote) { i++; break; }
        value += text[i++];
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let end = i + 1;
      while (end < text.length && /[0-9.eE+-]/.test(text[end])) {
        if ((text[end] === '+' || text[end] === '-') && !/[eE]/.test(text[end - 1])) break;
        end++;
      }
      tokens.push({ type: 'number', value: text.slice(i, end) });
      i = end;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let end = i + 1;
      while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) end++;
      const value = text.slice(i, end);
      const keyword = /^(if|then|else|and|or|not|in|true|false|null|whileprintingrecords|whilereadingrecords|shared|global|local)$/i.test(value);
      tokens.push({ type: keyword ? 'keyword' : 'identifier', value });
      i = end;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (['<=', '>=', '<>', ':='].includes(pair)) {
      tokens.push({ type: 'operator', value: pair });
      i += 2;
      continue;
    }
    if ('+-*/&=<>'.includes(c)) {
      tokens.push({ type: 'operator', value: c });
      i++;
      continue;
    }
    if ('(),;[]'.includes(c)) {
      tokens.push({ type: 'punctuation', value: c });
      i++;
      continue;
    }
    tokens.push({ type: 'unknown', value: c });
    i++;
  }
  return tokens;
}

export function parseCrystalFormula(tokens) {
  let position = 0;
  const peek = () => tokens[position];
  const take = () => tokens[position++];
  const is = (type, value) => peek()?.type === type &&
    (value == null || peek().value.toLowerCase() === value.toLowerCase());
  const expect = (type, value) => {
    if (!is(type, value)) throw new Error(`expected ${value || type}, got ${peek()?.value || 'end'}`);
    return take();
  };

  function expression() { return conditional(); }
  function conditional() {
    if (is('keyword', 'if')) {
      take();
      const condition = expression();
      expect('keyword', 'then');
      const whenTrue = expression();
      expect('keyword', 'else');
      const whenFalse = expression();
      return { type: 'if', condition, whenTrue, whenFalse };
    }
    return logicalOr();
  }
  function logicalOr() {
    let node = logicalAnd();
    while (is('keyword', 'or')) {
      take();
      node = { type: 'binary', operator: 'or', left: node, right: logicalAnd() };
    }
    return node;
  }
  function logicalAnd() {
    let node = comparison();
    while (is('keyword', 'and')) {
      take();
      node = { type: 'binary', operator: 'and', left: node, right: comparison() };
    }
    return node;
  }
  function comparison() {
    let node = additive();
    while ((is('operator') && ['=', '<>', '<', '>', '<=', '>='].includes(peek().value)) ||
           is('keyword', 'in')) {
      const operator = take().value;
      node = { type: 'binary', operator, left: node, right: additive() };
    }
    return node;
  }
  function additive() {
    let node = multiplicative();
    while (is('operator') && ['+', '-', '&'].includes(peek().value)) {
      const operator = take().value;
      node = { type: 'binary', operator, left: node, right: multiplicative() };
    }
    return node;
  }
  function multiplicative() {
    let node = unary();
    while (is('operator') && ['*', '/'].includes(peek().value)) {
      const operator = take().value;
      node = { type: 'binary', operator, left: node, right: unary() };
    }
    return node;
  }
  function unary() {
    if (is('operator', '-') || is('operator', '+')) {
      return { type: 'unary', operator: take().value, argument: unary() };
    }
    if (is('keyword', 'not')) {
      take();
      return { type: 'unary', operator: 'not', argument: unary() };
    }
    return primary();
  }
  function primary() {
    const token = peek();
    if (!token) throw new Error('unexpected end of formula');
    if (['number', 'string', 'field-ref', 'formula-ref', 'parameter-ref'].includes(token.type)) {
      take();
      return { type: token.type, value: token.value };
    }
    if (token.type === 'keyword' && /^(true|false|null)$/i.test(token.value)) {
      take();
      return { type: 'literal', value: token.value };
    }
    if (token.type === 'punctuation' && token.value === '(') {
      take();
      const node = expression();
      expect('punctuation', ')');
      return node;
    }
    if (token.type === 'identifier') {
      const name = take().value;
      if (is('punctuation', '(')) {
        take();
        const args = [];
        if (!is('punctuation', ')')) {
          args.push(expression());
          while (is('punctuation', ',')) {
            take();
            args.push(expression());
          }
        }
        expect('punctuation', ')');
        return { type: 'call', name, args };
      }
      return { type: 'identifier', value: name };
    }
    throw new Error(`unexpected token ${token.type}:${token.value}`);
  }

  const node = expression();
  return { node, trailing: tokens.slice(position) };
}

export function translateCrystalFormula(source, options = {}) {
  const warnings = [];
  const dependencies = new Set();
  const parameters = new Set();
  const raw = String(source || '').trim();
  const placementHints = [];

  for (const marker of [
    ['WhilePrintingRecords', 'while-printing-records'],
    ['WhileReadingRecords', 'while-reading-records'],
    ['Shared ', 'shared-variable'],
    ['Global ', 'global-variable'],
    [':=', 'assignment'],
  ]) {
    if (raw.toLowerCase().includes(marker[0].toLowerCase())) {
      placementHints.push(marker[1]);
      warnings.push(`${marker[0].trim()} semantics require Crystal multi-pass evaluation and are not reproduced automatically.`);
    }
  }

  try {
    const tokens = tokenizeCrystalFormula(raw);
    const { node, trailing } = parseCrystalFormula(tokens);
    if (trailing.length) {
      warnings.push(`untranslated trailing Crystal tokens: ${trailing.map(renderToken).join(' ')}`);
    }
    const state = { warnings, dependencies, parameters, options };
    const sigma = emitCrystalFormula(node, state);
    return {
      sigma,
      kind: hasAggregate(node) ? 'measure' : 'dimension',
      placement: parameters.size || placementHints.length ? 'report' : 'dm',
      dependencies: [...dependencies],
      parameters: [...parameters],
      warnings,
      source: raw,
      fullyTranslated: warnings.length === 0 && trailing.length === 0,
    };
  } catch (error) {
    warnings.push(`could not parse Crystal formula (${error.message}); emitted Null() and preserved source`);
    return {
      sigma: 'Null()',
      kind: 'dimension',
      placement: 'report',
      dependencies: [...dependencies],
      parameters: [...parameters],
      warnings,
      source: raw,
      fullyTranslated: false,
    };
  }
}

export function emitCrystalFormula(node, state) {
  switch (node.type) {
    case 'number': return node.value;
    case 'string': return JSON.stringify(node.value);
    case 'literal': return canonicalLiteral(node.value);
    case 'identifier': return node.value;
    case 'field-ref': {
      const name = state.options.fieldMap?.[node.value] ||
        state.options.fieldMap?.[node.value.toLowerCase()] ||
        sigmaDisplayName(node.value.split('.').at(-1));
      state.dependencies.add(name);
      return `[${name}]`;
    }
    case 'formula-ref': {
      const name = state.options.formulaMap?.[node.value] || node.value;
      state.dependencies.add(name);
      return `[${name}]`;
    }
    case 'parameter-ref': {
      const controlId = state.options.parameterMap?.[node.value] ||
        `p-${node.value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      state.parameters.add(node.value);
      return `[${controlId}]`;
    }
    case 'unary': {
      const arg = emitCrystalFormula(node.argument, state);
      return node.operator === 'not' ? `Not(${arg})` : `${node.operator}${arg}`;
    }
    case 'binary': {
      const left = emitCrystalFormula(node.left, state);
      const right = emitCrystalFormula(node.right, state);
      if (node.operator.toLowerCase() === 'and') return `And(${left}, ${right})`;
      if (node.operator.toLowerCase() === 'or') return `Or(${left}, ${right})`;
      if (node.operator.toLowerCase() === 'in') return `In(${left}, ${right})`;
      const op = node.operator === '<>' ? '!=' : node.operator;
      return `${left} ${op} ${right}`;
    }
    case 'if':
      return `If(${emitCrystalFormula(node.condition, state)}, ${emitCrystalFormula(node.whenTrue, state)}, ${emitCrystalFormula(node.whenFalse, state)})`;
    case 'call':
      return emitCall(node, state);
    default:
      throw new Error(`cannot emit AST node ${node.type}`);
  }
}

function emitCall(node, state) {
  const lower = node.name.toLowerCase();
  const args = node.args.map(arg => emitCrystalFormula(arg, state));
  if (lower === 'chr') {
    if (args[0] === '13' || args[0] === '10') return JSON.stringify('\n');
    state.warnings.push(`Chr(${args.join(', ')}) has no general Sigma mapping; emitted Unicode().`);
    return `Unicode(${args.join(', ')})`;
  }
  if (lower === 'ccur' || lower === 'cdbl' || lower === 'cdec' || lower === 'cint' || lower === 'clng') {
    state.warnings.push(`${node.name}() numeric cast removed; Sigma uses the source column's numeric type.`);
    return args[0] || 'Null()';
  }
  if (lower === 'hasvalue') {
    return `Not(IsNull(${args[0] || 'Null()'}))`;
  }
  if (lower === 'totext' && args.length > 1) {
    const mappedMask = translateCrystalFormatLiteral(node.args[1]);
    if (mappedMask) return `Text(${args[0]}, ${JSON.stringify(mappedMask)})`;
    state.warnings.push(`ToText() format argument ${args.slice(1).join(', ')} needs visual verification.`);
  }
  if (lower === 'datediff' && node.args[0]?.type === 'string') {
    args[0] = JSON.stringify(datePart(node.args[0].value));
  }
  const mapped = FUNCTION_MAP[lower] || `${node.name[0].toUpperCase()}${node.name.slice(1)}`;
  if (!KNOWN_SIGMA.has(mapped.toLowerCase())) {
    state.warnings.push(`function ${node.name}() has no verified Sigma mapping; emitted ${mapped}() for review.`);
  }
  return `${mapped}(${args.join(', ')})`;
}

function translateCrystalFormatLiteral(node) {
  if (!node || node.type !== 'string') return null;
  const value = node.value;
  if (/^0+$/.test(value)) return value;
  if (/^d{1,2}-M{3}-y{2,4}$/i.test(value)) return value;
  return null;
}

function datePart(value) {
  return {
    d: 'day',
    dd: 'day',
    m: 'month',
    mm: 'month',
    yyyy: 'year',
    q: 'quarter',
    h: 'hour',
    n: 'minute',
    s: 'second',
  }[String(value).toLowerCase()] || value;
}

function canonicalLiteral(value) {
  const lower = value.toLowerCase();
  if (lower === 'true') return 'True';
  if (lower === 'false') return 'False';
  return 'Null()';
}

function hasAggregate(node) {
  if (!node) return false;
  if (node.type === 'call') {
    return AGGREGATES.has(node.name.toLowerCase()) || node.args.some(hasAggregate);
  }
  if (node.type === 'binary') return hasAggregate(node.left) || hasAggregate(node.right);
  if (node.type === 'unary') return hasAggregate(node.argument);
  if (node.type === 'if') {
    return hasAggregate(node.condition) || hasAggregate(node.whenTrue) || hasAggregate(node.whenFalse);
  }
  return false;
}

function renderToken(token) {
  if (token.type === 'field-ref') return `{${token.value}}`;
  if (token.type === 'formula-ref') return `{@${token.value}}`;
  if (token.type === 'parameter-ref') return `{?${token.value}}`;
  if (token.type === 'string') return JSON.stringify(token.value);
  return token.value;
}

