// Value-range analysis: what does a channel span, and which channels belong on
// the same chart.

/// Min/max of a channel across every loaded range, ignoring nulls.
export function channelExtent(segments, id) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const seg of segments) {
    const c = seg.byChannel[id];
    if (!c) continue;
    if (c.v) {
      for (const x of c.v) {
        if (x == null) continue;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
    } else {
      for (const x of c.lo) if (x != null && x < lo) lo = x;
      for (const x of c.hi) if (x != null && x > hi) hi = x;
    }
  }
  return lo <= hi ? { lo, hi } : null;
}

/// The order of magnitude a channel lives at. Used to decide chart membership:
/// 63 000 and 64 000 belong together, 0.4 and 63 000 do not.
function magnitude(ext) {
  const m = Math.max(Math.abs(ext.lo), Math.abs(ext.hi));
  if (m > 0) return m;
  const span = ext.hi - ext.lo;
  return span > 0 ? span : 1;
}

/// Below this the magnitudes are close enough that one chart reads fine
/// (~5.6x). Two channels inside it always share an axis.
const MIN_SPLIT_DECADES = 0.75;

/**
 * Where the sorted magnitudes break into clusters.
 *
 * With `auto` the boundaries come from the data: the gaps between consecutive
 * magnitudes are compared against the largest one, so a set holding prices,
 * sizes and block heights splits three ways while a set of four price-like
 * channels stays on one chart. No hand-tuned ratio, and nothing to adjust when
 * a different set of channels is picked.
 *
 * A numeric `tolerance` overrides that with a fixed "split above Nx" rule.
 */
function splitPoints(logs, tolerance) {
  const out = new Set();
  if (logs.length < 2) return out;
  const gaps = logs.slice(1).map((v, i) => v - logs[i]);

  let threshold;
  if (tolerance === 'auto') {
    const widest = Math.max(...gaps);
    if (widest < MIN_SPLIT_DECADES) return out; // one coherent cluster
    threshold = Math.max(MIN_SPLIT_DECADES, widest * 0.5);
  } else {
    threshold = Math.log10(Math.max(1.0001, tolerance));
  }

  gaps.forEach((g, i) => {
    if (g >= threshold) out.add(i + 1);
  });
  return out;
}

/**
 * Splits channels across charts.
 *
 * - `auto`     clusters channels by order of magnitude, boundaries detected
 *              from the selected channels themselves.
 * - `single`   one chart, everything on it.
 * - `separate` one chart per channel.
 */
export function groupChannels(ids, extents, mode = 'auto', tolerance = 'auto') {
  if (mode === 'single') return ids.length ? [ids.slice()] : [];
  if (mode === 'separate') return ids.map((id) => [id]);

  const sized = ids
    .filter((id) => extents[id])
    .map((id) => ({ id, mag: magnitude(extents[id]) }))
    .sort((a, b) => a.mag - b.mag);

  const breaks = splitPoints(sized.map((x) => Math.log10(x.mag)), tolerance);

  const out = [];
  sized.forEach((item, i) => {
    if (i === 0 || breaks.has(i)) out.push([]);
    out[out.length - 1].push(item.id);
  });

  // Channels with no data in view still deserve a slot, so they are visible as
  // empty rather than silently dropped.
  const empty = ids.filter((id) => !extents[id]);
  if (empty.length) out.push(empty);
  return out;
}

/// The combined range of several channels -- what one chart has to fit.
export function unionExtent(ids, extents) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const id of ids) {
    const e = extents[id];
    if (!e) continue;
    if (e.lo < lo) lo = e.lo;
    if (e.hi > hi) hi = e.hi;
  }
  return lo <= hi ? { lo, hi } : null;
}

/// A label like "63.2k – 64.6k" describing what a chart covers.
export function describeRange(ids, extents) {
  const e = unionExtent(ids, extents);
  return e ? `${fmtValue(e.lo)} – ${fmtValue(e.hi)}` : 'no data in view';
}

// --------------------------------------------------------------- y scaling --

export function niceScale(lo, hi, targetTicks = 4) {
  if (!(isFinite(lo) && isFinite(hi))) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / targetTicks);
  const first = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let t = first; t <= hi + step * 1e-9 && ticks.length < 12; t += step) {
    ticks.push(round(t, step));
  }
  return { lo, hi, ticks, step };
}

function round(v, step) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(decimals, 12)));
}

function niceStep(want) {
  if (!(want > 0)) return 1;
  const exp = Math.floor(Math.log10(want));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= want) return m * base;
  }
  return 10 * base;
}

export function fmtValue(v) {
  if (v == null || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(2)}k`;
  if (a >= 100) return v.toFixed(2);
  if (a >= 1) return v.toFixed(4);
  if (a >= 1e-4) return v.toFixed(6);
  return v.toExponential(2);
}

/// Axis labels want to line up, so they follow the tick step, not the value.
export function fmtTickValue(v, step) {
  if (v == null || !isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toPrecision(6).replace(/\.?0+$/, '')}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(step >= 1000 ? 0 : 2)}k`;
  const decimals = step ? Math.max(0, Math.min(8, -Math.floor(Math.log10(step)) + (step < 1 ? 0 : 0))) : 2;
  return v.toFixed(decimals);
}
