// A time axis that collapses the empty stretches.
//
// The store has data in a handful of bursts separated by gaps up to a week
// long. Plotting real time would spend most of the width on nothing, so the
// axis maps wall-clock time onto "u" units where every covered span keeps its
// true duration and every gap is squeezed down to a fixed sliver.

const MIN_SPAN_US = 1000; // don't let a degenerate span collapse to zero width

export function buildAxis(spans, { gapShare = 0.012 } = {}) {
  const clean = (spans || [])
    .map(([a, b]) => [a, Math.max(b, a + MIN_SPAN_US)])
    .sort((p, q) => p[0] - q[0]);

  if (!clean.length) return emptyAxis();

  // Merge anything that touches or overlaps.
  const merged = [clean[0].slice()];
  for (const [a, b] of clean.slice(1)) {
    const last = merged[merged.length - 1];
    if (a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }

  const dataUs = merged.reduce((acc, [a, b]) => acc + (b - a), 0);
  const gapCount = merged.length - 1;
  // Each gap gets the same slice of the axis regardless of how long it is --
  // that is the whole point, a week and a minute both read as "a break".
  const gapU = gapCount ? dataUs * gapShare : 0;

  const segments = [];
  let u = 0;
  merged.forEach((span, i) => {
    if (i > 0) {
      const prev = merged[i - 1];
      segments.push({ kind: 'gap', t0: prev[1], t1: span[0], u0: u, u1: u + gapU });
      u += gapU;
    }
    const width = span[1] - span[0];
    segments.push({ kind: 'data', t0: span[0], t1: span[1], u0: u, u1: u + width });
    u += width;
  });

  return makeAxis(segments, u, merged);
}

function emptyAxis() {
  return makeAxis([], 1, []);
}

function makeAxis(segments, totalU, spans) {
  const dataSegments = segments.filter((s) => s.kind === 'data');

  function segmentAtT(t) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid];
      if (t < s.t0) hi = mid - 1;
      else if (t >= s.t1) lo = mid + 1;
      else return s;
    }
    return null;
  }

  function segmentAtU(uu) {
    let lo = 0;
    let hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid];
      if (uu < s.u0) hi = mid - 1;
      else if (uu >= s.u1) lo = mid + 1;
      else return s;
    }
    return null;
  }

  function toU(t) {
    if (!segments.length) return 0;
    if (t <= segments[0].t0) return 0;
    const lastSeg = segments[segments.length - 1];
    if (t >= lastSeg.t1) return totalU;
    const s = segmentAtT(t);
    if (!s) return 0;
    const frac = (t - s.t0) / (s.t1 - s.t0);
    return s.u0 + frac * (s.u1 - s.u0);
  }

  function toT(uu) {
    if (!segments.length) return 0;
    if (uu <= 0) return segments[0].t0;
    if (uu >= totalU) return segments[segments.length - 1].t1;
    const s = segmentAtU(uu);
    if (!s) return segments[0].t0;
    const frac = (uu - s.u0) / (s.u1 - s.u0);
    return s.t0 + frac * (s.t1 - s.t0);
  }

  // The real-time windows a u-range actually covers, gaps dropped. These are
  // what get sent to the server -- one query per burst of real data.
  function rangesForU(u0, u1) {
    const out = [];
    for (const s of dataSegments) {
      if (s.u1 <= u0 || s.u0 >= u1) continue;
      const a = Math.max(s.u0, u0);
      const b = Math.min(s.u1, u1);
      const from = Math.round(toT(a));
      const to = Math.round(toT(b));
      if (to > from) out.push({ from, to, u0: a, u1: b });
    }
    return out;
  }

  function gapsInU(u0, u1) {
    return segments
      .filter((s) => s.kind === 'gap' && s.u1 > u0 && s.u0 < u1)
      .map((s) => ({ ...s }));
  }

  return {
    segments,
    spans,
    totalU,
    dataUs: dataSegments.reduce((acc, s) => acc + (s.t1 - s.t0), 0),
    toU,
    toT,
    rangesForU,
    gapsInU,
    /// Real duration covered by a u-window (excludes the squeezed gaps).
    dataUsInU(u0, u1) {
      return rangesForU(u0, u1).reduce((acc, r) => acc + (r.to - r.from), 0);
    },
  };
}

// -------------------------------------------------------------- formatting --

export function fmtDuration(us) {
  const ms = us / 1000;
  if (ms < 1) return `${(us).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/// `2026-08-10 07:58:30.000`. Microseconds are rounded to the millisecond --
/// past that the digits are noise at any zoom the page can draw.
export function fmtTime(us, precision = 'ms') {
  const stamp = precision === 'us' ? us : Math.round(us / 1000) * 1000;
  const d = new Date(stamp / 1000);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const hms = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (precision === 'us') {
    return `${date} ${hms}.${String(Math.abs(us) % 1000000).padStart(6, '0')}`;
  }
  return `${date} ${hms}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/// How long a window is, read as a clock rather than a rounded phrase:
/// `01:10.123`, `11:13:30.000`, `6d 09:41:20.000`. Millisecond resolution, to
/// match the timestamp it sits beside.
export function fmtDelta(us) {
  const sign = us < 0 ? '-' : '';
  const ms = Math.round(Math.abs(us) / 1000);
  const secs = Math.floor(ms / 1000);
  const tail = `${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}.${pad(ms % 1000, 3)}`;
  const hours = Math.floor(secs / 3600);
  if (hours >= 24) return `${sign}${Math.floor(hours / 24)}d ${pad(hours % 24)}:${tail}`;
  if (hours > 0) return `${sign}${pad(hours)}:${tail}`;
  return `${sign}${tail}`;
}

/// Tick times inside a u-window, chosen so labels stay readable and never land
/// inside a collapsed gap.
export function timeTicks(axis, u0, u1, target = 7) {
  const ranges = axis.rangesForU(u0, u1);
  const totalUs = ranges.reduce((acc, r) => acc + (r.to - r.from), 0);
  if (!totalUs) return [];
  const step = niceTimeStep(totalUs / target);
  const ticks = [];
  for (const r of ranges) {
    const first = Math.ceil(r.from / step) * step;
    for (let t = first; t < r.to; t += step) {
      ticks.push({ t, u: axis.toU(t) });
      if (ticks.length > 400) return ticks;
    }
  }
  return ticks;
}

const TIME_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, // us
  1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, // ms
  1e6, 2e6, 5e6, 1e7, 1.5e7, 3e7, // s
  6e7, 1.2e8, 3e8, 6e8, 9e8, 1.8e9, // min
  3.6e9, 7.2e9, 1.08e10, 2.16e10, 4.32e10, // h
  8.64e10, 1.728e11, 6.048e11, // days
];

function niceTimeStep(want) {
  for (const s of TIME_STEPS) if (s >= want) return s;
  return TIME_STEPS[TIME_STEPS.length - 1];
}

/// How much precision the tick labels need at this zoom.
export function tickPrecision(spanUs) {
  if (spanUs < 2e6) return 'ms';
  if (spanUs < 2 * 86400e6) return 'hms';
  return 'date';
}

export function fmtTick(t, precision) {
  const d = new Date(t / 1000);
  if (precision === 'ms') {
    return `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
  }
  if (precision === 'date') {
    return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
