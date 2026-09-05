// Arithmetic over channels, parsed and compiled here rather than handed to
// `eval`: the expression comes from a text box that ends up in a shareable URL,
// so it must never be able to reach anything but the numbers it was given.

/// Null-prototype throughout: these are looked up with `in` and `[name]`
/// against names typed by a user, and an ordinary object literal would happily
/// answer to `constructor`, `toString` and the rest of Object.prototype --
/// turning "unknown name" into a live reference to a builtin.
const table = (o) => Object.assign(Object.create(null), o);

const FUNCS = table({
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, sign: Math.sign,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  ln: Math.log, log10: Math.log10, log2: Math.log2,
  min: Math.min, max: Math.max, pow: Math.pow,
});
/// Arity is checked at parse time so a typo is reported while it is being
/// typed rather than as a NaN line an hour later. `null` means variadic.
const ARITY = table({ min: null, max: null, pow: 2 });

const CONSTS = table({ pi: Math.PI, e: Math.E });

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new Error(`bad number at ${i + 1}`);
      out.push({ k: 'num', v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ k: 'name', v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    if (src.startsWith('**', i)) { out.push({ k: 'op', v: '^', at: i }); i += 2; continue; }
    if ('+-*/%^(),'.includes(ch)) { out.push({ k: 'op', v: ch, at: i }); i++; continue; }
    throw new Error(`unexpected "${ch}" at ${i + 1}`);
  }
  return out;
}

/**
 * Compiles `src` against the variable names in `vars`.
 *
 * Returns `{ fn, used }`: `fn(env)` takes an array positionally matching
 * `vars` and returns a number; `used` is the subset actually referenced, so a
 * caller can tell which inputs a formula really depends on. Throws an `Error`
 * whose message is meant to be shown verbatim to whoever typed the formula.
 */
export function compile(src, vars) {
  const toks = tokenize(src);
  const slot = new Map(vars.map((v, i) => [v, i]));
  const used = new Set();
  let p = 0;

  const peek = () => toks[p];
  const eat = (v) => {
    const t = toks[p];
    if (t && t.k === 'op' && t.v === v) { p++; return true; }
    return false;
  };
  const expect = (v) => {
    if (!eat(v)) throw new Error(`expected "${v}"${peek() ? ` at ${peek().at + 1}` : ' at end'}`);
  };

  // expr := term (('+'|'-') term)*
  function expr() {
    let left = term();
    for (;;) {
      if (eat('+')) { const r = term(), l = left; left = (s) => l(s) + r(s); }
      else if (eat('-')) { const r = term(), l = left; left = (s) => l(s) - r(s); }
      else return left;
    }
  }

  // term := unary (('*'|'/'|'%') unary)*
  function term() {
    let left = unary();
    for (;;) {
      if (eat('*')) { const r = unary(), l = left; left = (s) => l(s) * r(s); }
      else if (eat('/')) { const r = unary(), l = left; left = (s) => l(s) / r(s); }
      else if (eat('%')) { const r = unary(), l = left; left = (s) => l(s) % r(s); }
      else return left;
    }
  }

  function unary() {
    if (eat('-')) { const r = unary(); return (s) => -r(s); }
    if (eat('+')) return unary();
    return power();
  }

  // Right-associative, so a^b^c is a^(b^c) as in ordinary notation.
  function power() {
    const base = primary();
    if (eat('^')) { const ex = unary(); return (s) => base(s) ** ex(s); }
    return base;
  }

  function primary() {
    const t = peek();
    if (!t) throw new Error('unexpected end of formula');
    if (t.k === 'num') { p++; const { v } = t; return () => v; }
    if (t.k === 'op' && t.v === '(') { p++; const e = expr(); expect(')'); return e; }
    if (t.k === 'name') {
      p++;
      const name = t.v;
      if (peek() && peek().k === 'op' && peek().v === '(') {
        p++;
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function "${name}"`);
        const args = [];
        if (!eat(')')) {
          do { args.push(expr()); } while (eat(','));
          expect(')');
        }
        const want = name in ARITY ? ARITY[name] : 1;
        if (want !== null && args.length !== want) {
          throw new Error(`${name}() takes ${want} argument${want === 1 ? '' : 's'}, got ${args.length}`);
        }
        if (want === null && !args.length) throw new Error(`${name}() needs at least one argument`);
        return (s) => fn(...args.map((a) => a(s)));
      }
      if (slot.has(name)) {
        const i = slot.get(name);
        used.add(name);
        return (s) => s[i];
      }
      if (name in CONSTS) { const v = CONSTS[name]; return () => v; }
      if (name in FUNCS) throw new Error(`"${name}" is a function — write ${name}(…)`);
      throw new Error(`unknown name "${name}" — inputs are ${vars.join(', ') || 'none yet'}`);
    }
    throw new Error(`unexpected "${t.v}" at ${t.at + 1}`);
  }

  const fn = expr();
  if (p < toks.length) throw new Error(`unexpected "${toks[p].v}" at ${toks[p].at + 1}`);
  return { fn, used };
}

/// The names bound to a formula's inputs, in order: a, b, c, …
export function varNames(n) {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));
}

/**
 * Evaluates one compiled formula across a segment.
 *
 * The inputs are separate channels with their own sample times, so this walks
 * them in one merged pass and holds each one's most recent value between its
 * own samples -- a step function, which is what a quote or a position actually
 * is. Output lands on the union of the input timestamps.
 *
 * Nothing is emitted before every input has been seen at least once: until
 * then "the last value" is a value that does not exist yet.
 */
export function evalSegment(seg, refs, fn) {
  const cols = refs.map((id) => seg.byChannel[id]);
  if (cols.some((c) => !c || !c.t || !c.t.length)) return null;

  // An aggregated bucket stands for its closing value here, matching what the
  // chart draws as the line through an envelope.
  const pick = cols.map((c) => (c.mode === 'agg' ? c.last : c.v) || []);
  const n = cols.length;
  const idx = new Int32Array(n);
  const held = new Array(n).fill(null);
  const env = new Array(n);
  const outT = [];
  const outV = [];
  let seen = 0;

  for (;;) {
    let tMin = Infinity;
    for (let k = 0; k < n; k++) {
      const t = cols[k].t;
      if (idx[k] < t.length && t[idx[k]] < tMin) tMin = t[idx[k]];
    }
    if (tMin === Infinity) break;

    for (let k = 0; k < n; k++) {
      const t = cols[k].t;
      while (idx[k] < t.length && t[idx[k]] === tMin) {
        const v = pick[k][idx[k]];
        if (v != null && Number.isFinite(v)) {
          if (held[k] == null) seen++;
          held[k] = v;
        }
        idx[k]++;
      }
    }
    if (seen < n) continue;

    for (let k = 0; k < n; k++) env[k] = held[k];
    const y = fn(env);
    if (Number.isFinite(y)) { outT.push(tMin); outV.push(y); }
  }

  if (!outT.length) return null;
  return {
    t: outT,
    v: outV,
    // Always a plain line: an envelope cannot survive an arbitrary formula
    // (the low of a-b is not the low of a minus the low of b), so the honest
    // thing is to draw only the value the formula actually produced.
    mode: 'raw',
    bucketUs: Math.max(0, ...cols.map((c) => c.bucketUs || 0)),
  };
}
