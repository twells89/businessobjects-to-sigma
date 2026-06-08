/**
 * Sigma ID generation, naming, format inference, and SQL CASE translation.
 * Ported verbatim from sigma-data-model-mcp (src/sigma-ids.ts, src/alteryx.ts)
 * so the standalone converters in this repo behave identically to the MCP
 * `convert_bobj_to_sigma` tool. Keep in sync if those change.
 */

const SIGMA_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const _usedIds = new Set();

const SIGMA_LOWERCASE_WORDS = new Set([
  'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'so', 'yet',
  'at', 'by', 'in', 'of', 'on', 'to', 'up', 'as', 'into', 'via', 'per',
]);

/** Reset the ID registry — call at the start of each conversion run. */
export function resetIds() { _usedIds.clear(); }

/** Generate a unique short random ID (base62). */
export function sigmaShortId(len = 10) {
  let id;
  do {
    id = Array.from({ length: len }, () => SIGMA_CHARS[Math.floor(Math.random() * SIGMA_CHARS.length)]).join('');
  } while (_usedIds.has(id));
  _usedIds.add(id);
  return id;
}

/** SNAKE_CASE or camelCase → "Title Case" display name. */
export function sigmaDisplayName(s) {
  const normalized = (s || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  const words = normalized.toLowerCase().split('_').filter(Boolean);
  return words.map((w, i) =>
    (i === 0 || !SIGMA_LOWERCASE_WORDS.has(w))
      ? w.charAt(0).toUpperCase() + w.slice(1)
      : w
  ).join(' ');
}

/** Map an Excel/.NET numeric format mask → Sigma format object, or null. */
export function formatFromMask(mask) {
  if (!mask || typeof mask !== 'string') return null;
  const s = mask.trim();
  if (!s || /general|date|time|@|yy|dd/i.test(s)) return null;
  const decM = s.match(/\.([0#]+)/);
  const decimals = decM ? decM[1].length : 0;
  const isPercent = /%/.test(s);
  const isCurrency = /[$£€¥]/.test(s);
  if (isPercent) return { kind: 'number', formatString: `,.${decimals}%` };
  if (isCurrency) return { kind: 'number', formatString: `$,.${decimals}f`, currencySymbol: '$' };
  if (/[0#]/.test(s)) return { kind: 'number', formatString: `,.${decimals}f` };
  return null;
}

/** Infer a Sigma format object from a formula string + display name, or null. */
export function inferSigmaFormat(formula, displayName, sourceMask) {
  const fromMask = formatFromMask(sourceMask);
  if (fromMask) return fromMask;
  if (!formula) return null;
  const f = formula.trim();
  const n = (displayName || '').toLowerCase();

  const alreadyPctScale = /\*\s*100\b/.test(f);
  if (alreadyPctScale && /\b(rate|margin|pct|percent|ratio|share|mix)\b|%/.test(n)) {
    return { kind: 'number', formatString: ',.2f', suffix: '%' };
  }
  const currencyWord = /\b(revenue|sales|profit|cost|spend|amount|discounts?|price|value|aov|arpu)\b/;
  const ratio = f.match(/^([A-Za-z]+)\s*\(([^)]*)\)\s*\/\s*([A-Za-z]+)\s*\(([^)]*)\)$/);
  if (ratio) {
    const [, numFn, numArg, denFn] = ratio;
    const isCount = fn => /^Count/i.test(fn);
    const numIsCurrency = currencyWord.test(numArg.toLowerCase());
    const nameSaysPct = /\b(rate|margin|pct|percent|ratio|share|mix)\b|%/.test(n);
    if (nameSaysPct || (isCount(numFn) && isCount(denFn))) return { kind: 'number', formatString: ',.2%' };
    if (numIsCurrency) return { kind: 'number', formatString: '$,.2f', currencySymbol: '$' };
    return { kind: 'number', formatString: ',.2f' };
  }
  if (/\b(rate|margin|pct|percent|ratio|share|mix)\b|%/.test(n)) return { kind: 'number', formatString: ',.2%' };
  if (currencyWord.test(n)) return { kind: 'number', formatString: '$,.2f', currencySymbol: '$' };
  if (/^Count(?:Distinct|If|DistinctIf)?\s*\(/.test(f)) return { kind: 'number', formatString: ',.0f' };
  return null;
}

/** SQL `CASE WHEN … THEN … ELSE … END` → nested Sigma `If(…)`. */
export function sqlCaseToIf(expr) {
  const caseRe = /\bCASE\b([\s\S]*?)\bEND\b/gi;
  return expr.replace(caseRe, (_, inner) => {
    const whenRe = /\bWHEN\b\s*([\s\S]+?)\s*\bTHEN\b\s*([\s\S]+?)(?=\s*\bWHEN\b|\s*\bELSE\b|\s*$)/gi;
    const elseMatch = inner.match(/\bELSE\b\s*([\s\S]+?)$/i);
    const elsePart = elseMatch ? elseMatch[1].trim() : 'Null()';
    const whens = [];
    let m;
    while ((m = whenRe.exec(inner)) !== null) whens.push([m[1].trim(), m[2].trim()]);
    if (!whens.length) return _;
    let result = elsePart;
    for (let i = whens.length - 1; i >= 0; i--) result = `If(${whens[i][0]}, ${whens[i][1]}, ${result})`;
    return result;
  });
}
