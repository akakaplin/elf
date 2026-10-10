// Canvas drawing for the chart stack and the overview timeline.
//
// Both draw against the collapsed time axis from timeaxis.js, so a gap is a
// narrow hatched band rather than a stretch of empty plot.

import { fmtDuration, fmtTick, tickPrecision, timeTicks } from './timeaxis.js';
import { fmtTickValue, niceScale } from './scales.js';

export const PALETTE = [
  '#4dabf7', '#f783ac', '#69db7c', '#ffd43b', '#a78bfa',
  '#ff922b', '#38d9a9', '#e599f7', '#ff8787', '#74c0fc',
];

const C = {
  bg: '#12161c',
  grid: '#222b35',
  gridStrong: '#2c3745',
  gap: '#1b222b',
  gapLine: '#39485a',
  text: '#7e8b9b',
  textBright: '#e3eaf2',
  crosshair: '#5b6b7d',
};

export const PAD = { left: 66, right: 12, top: 10, bottom: 8 };
export const AXIS_H = 22;

// Timeline geometry, shared with the React layer so it can size the strip.
export const TIMELINE_TOP = 8;
export const TIMELINE_LANE = 15; // 12px lane + 3px gap
export const TIMELINE_AXIS = 26;
export const TIMELINE_LEFT = 128;

/// Bottom-axis labels are drawn cheapest-first with collision rejection, so a
/// collapsed gap's "⋯ 7d" caption never lands on top of a time tick.
function labelPlacer(minGap = 9) {
  const taken = [];
  return (x, w) => {
    const a = x - w / 2 - minGap;
    const b = x + w / 2 + minGap;
    for (const [ta, tb] of taken) if (a < tb && b > ta) return false;
    taken.push([a, b]);
    return true;
  };
}

function drawXLabels(ctx, { ticks, gaps, xOf, y, min, max, prec }) {
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  const fits = labelPlacer();
  // Gaps first, longest first: knowing a week vanished here matters more than
  // one more time tick, and the biggest break matters most of all.
  ctx.fillStyle = C.gapLine;
  for (const g of [...gaps].sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0))) {
    const x = (xOf(g.u0) + xOf(g.u1)) / 2;
    const text = `⋯ ${fmtDuration(g.t1 - g.t0)}`;
    const w = ctx.measureText(text).width;
    if (x - w / 2 < min || x + w / 2 > max) continue;
    if (fits(x, w)) ctx.fillText(text, x, y);
  }
  ctx.fillStyle = C.text;
  for (const tk of ticks) {
    const x = xOf(tk.u);
    const text = fmtTick(tk.t, prec);
    const w = ctx.measureText(text).width;
    if (x - w / 2 < min || x + w / 2 > max) continue;
    if (fits(x, w)) ctx.fillText(text, x, y);
  }
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

export function fitCanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

/// u for a timestamp inside a loaded range. Inside a data span the axis is
/// linear with slope 1, so this avoids a binary search per point.
function uOf(range, t) {
  return range.u0 + (t - range.from);
}

/// Half-extent of a sample mark in dot mode. Small, so a dense feed stays
/// legible, but enough for a triangle's direction to read on its own.
const MARK_R = 1.6;

/// Shapes a column can be marked with in dot mode. `up` and `down` are kept for
/// the two sides of a book; everything else is assigned from the rest.
const OTHER_MARKS = ['circle', 'square', 'diamond', 'plus'];
/// Columns common enough to get a fixed shape rather than risk sharing one by
/// hash -- `price` and `size` often sit on the same chart.
const NAMED_MARKS = Object.assign(Object.create(null), {
  price: 'circle', px: 'circle', mid: 'circle', last: 'circle',
  size: 'square', qty: 'square', amount: 'square',
  bid_size: 'diamond', ask_size: 'plus',
});

/// The dot-mode mark for a channel, chosen by its column name alone, so `ask`
/// looks the same whichever table it comes from: asks point down, bids up
/// (`ask`, `ask1`, `ask_px`, …), and any other column gets a fixed shape hashed
/// from its name -- stable across reloads and selections.
export function markerFor(id) {
  const field = id.slice(id.indexOf(':') + 1).toLowerCase();
  if (/^ask(?:_?\d+|_?px|_?price)?$/.test(field)) return 'down';
  if (/^bid(?:_?\d+|_?px|_?price)?$/.test(field)) return 'up';
  if (field in NAMED_MARKS) return NAMED_MARKS[field];
  let h = 0;
  for (let i = 0; i < field.length; i++) h = (h * 31 + field.charCodeAt(i)) | 0;
  return OTHER_MARKS[Math.abs(h) % OTHER_MARKS.length];
}

/// Adds one mark centred on (x, y) to the current path. Every shape is filled,
/// so all of a channel's marks still go out in one `fill()`.
function addMark(ctx, shape, x, y, r) {
  switch (shape) {
    case 'up':
      ctx.moveTo(x, y - r * 1.2);
      ctx.lineTo(x + r * 1.1, y + r * 0.8);
      ctx.lineTo(x - r * 1.1, y + r * 0.8);
      ctx.closePath();
      break;
    case 'down':
      ctx.moveTo(x, y + r * 1.2);
      ctx.lineTo(x + r * 1.1, y - r * 0.8);
      ctx.lineTo(x - r * 1.1, y - r * 0.8);
      ctx.closePath();
      break;
    case 'square':
      ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
      break;
    case 'diamond':
      ctx.moveTo(x, y - r * 1.15);
      ctx.lineTo(x + r * 1.15, y);
      ctx.lineTo(x, y + r * 1.15);
      ctx.lineTo(x - r * 1.15, y);
      ctx.closePath();
      break;
    case 'plus':
      ctx.rect(x - r * 1.2, y - r * 0.35, r * 2.4, r * 0.7);
      ctx.rect(x - r * 0.35, y - r * 1.2, r * 0.7, r * 2.4);
      break;
    default:
      ctx.moveTo(x + r * 0.8, y);
      ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
  }
}

// ------------------------------------------------------------------ charts --

export function drawChart(canvas, spec) {
  const {
    width, height, axis, u0, u1, ids, colorOf, segments, extent,
    showXLabels, hoverU, logScale, lineStyle,
  } = spec;

  const ctx = fitCanvas(canvas, width, height);
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const bottom = height - PAD.bottom - (showXLabels ? AXIS_H : 0);
  const plotH = Math.max(1, bottom - PAD.top);
  const uSpan = Math.max(1e-9, u1 - u0);
  const xOf = (u) => PAD.left + ((u - u0) / uSpan) * plotW;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  // Squeezed gaps, drawn under everything.
  for (const g of axis.gapsInU(u0, u1)) {
    const x0 = xOf(g.u0);
    const x1 = xOf(g.u1);
    ctx.fillStyle = C.gap;
    ctx.fillRect(x0, PAD.top, Math.max(2, x1 - x0), plotH);
    ctx.strokeStyle = C.gapLine;
    ctx.setLineDash([2, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, PAD.top);
    ctx.lineTo(x0 + 0.5, bottom);
    ctx.moveTo(x1 - 0.5, PAD.top);
    ctx.lineTo(x1 - 0.5, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const scale = logScale
    ? logScaleFor(extent)
    : niceScale(extent ? extent.lo : 0, extent ? extent.hi : 1);
  const yOf = logScale
    ? (v) => {
        if (!(v > 0)) return bottom;
        const f = (Math.log10(v) - scale.lo) / Math.max(1e-9, scale.hi - scale.lo);
        return bottom - f * plotH;
      }
    : (v) => bottom - ((v - scale.lo) / Math.max(1e-9, scale.hi - scale.lo)) * plotH;

  // Horizontal grid + value labels.
  ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of scale.ticks) {
    const y = Math.round(yOf(logScale ? Math.pow(10, tick) : tick)) + 0.5;
    if (y < PAD.top - 1 || y > bottom + 1) continue;
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(width - PAD.right, y);
    ctx.stroke();
    ctx.fillStyle = C.text;
    const label = logScale
      ? fmtTickValue(Math.pow(10, tick), Math.pow(10, tick) / 4)
      : fmtTickValue(tick, scale.step);
    ctx.fillText(label, PAD.left - 8, y);
  }

  // Vertical grid at time ticks.
  const ticks = timeTicks(axis, u0, u1, Math.max(3, Math.round(plotW / 110)));
  const prec = tickPrecision(axis.dataUsInU(u0, u1));
  ctx.strokeStyle = C.grid;
  for (const tk of ticks) {
    const x = Math.round(xOf(tk.u)) + 0.5;
    if (x < PAD.left || x > width - PAD.right) continue;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }

  // Series.
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, plotW, plotH);
  ctx.clip();
  for (const id of ids) {
    drawChannel(ctx, { id, color: colorOf(id), segments, xOf, yOf, u0, u1, lineStyle });
  }
  ctx.restore();

  // Frame.
  ctx.strokeStyle = C.gridStrong;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD.left + 0.5, PAD.top + 0.5, plotW - 1, plotH - 1);

  if (hoverU != null && hoverU >= u0 && hoverU <= u1) {
    const x = Math.round(xOf(hoverU)) + 0.5;
    ctx.strokeStyle = C.crosshair;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (showXLabels) {
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    drawXLabels(ctx, {
      ticks,
      gaps: axis.gapsInU(u0, u1),
      xOf,
      y: bottom + 6,
      min: PAD.left,
      max: width - PAD.right,
      prec,
    });
  }

  return { scale, yOf, xOf, plotW, plotH, bottom };
}

function logScaleFor(extent) {
  const lo = Math.log10(Math.max(1e-12, extent ? Math.max(extent.lo, 1e-12) : 1e-3));
  const hi = Math.log10(Math.max(1e-11, extent ? extent.hi : 1));
  const pad = (hi - lo) * 0.06 || 0.1;
  const l = lo - pad;
  const h = hi + pad;
  const ticks = [];
  for (let e = Math.ceil(l); e <= h && ticks.length < 12; e += 1) ticks.push(e);
  return { lo: l, hi: h, ticks, step: 1 };
}

function drawChannel(ctx, { id, color, segments, xOf, yOf, u0, u1, lineStyle }) {
  const shape = markerFor(id);
  for (const seg of segments) {
    const c = seg.byChannel[id];
    if (!c || !c.t || !c.t.length) continue;
    if (seg.u1 < u0 || seg.u0 > u1) continue;

    const t = c.t;
    const gapUs = breakThreshold(t, c.bucketUs);

    if (c.mode === 'agg' && c.lo && c.hi) {
      // Envelope first: everything the bucket actually contained.
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.22;
      forEachRun(t, gapUs, (start, end) => {
        ctx.beginPath();
        let moved = false;
        for (let i = start; i <= end; i++) {
          if (c.hi[i] == null) continue;
          const x = xOf(uOf(seg, t[i]));
          const y = yOf(c.hi[i]);
          if (moved) ctx.lineTo(x, y);
          else { ctx.moveTo(x, y); moved = true; }
        }
        for (let i = end; i >= start; i--) {
          if (c.lo[i] == null) continue;
          ctx.lineTo(xOf(uOf(seg, t[i])), yOf(c.lo[i]));
        }
        if (moved) { ctx.closePath(); ctx.fill(); }
      });
      ctx.globalAlpha = 1;

      // The closing value goes where it was recorded. Breaks are still found
      // from the bucket starts, whose spacing is regular.
      draw(ctx, color, t, c.last, gapUs, seg, xOf, yOf, lineStyle, shape, c.tLast);
    } else if (c.v) {
      draw(ctx, color, t, c.v, gapUs, seg, xOf, yOf, lineStyle, shape);
    }
  }
}

/// Where to break a line: at a real dropout, not merely a quiet stretch.
/// A quote feed is bursty by nature -- breaking on every pause makes a healthy
/// feed look broken -- so the threshold follows the typical sample spacing
/// (subsampled median) rather than the mean.
function breakThreshold(t, bucketUs) {
  if (bucketUs) return 3 * bucketUs;
  const n = t.length;
  if (n < 8) return Infinity;
  const stride = Math.max(1, Math.floor(n / 512));
  const deltas = [];
  for (let i = stride; i < n; i += stride) deltas.push((t[i] - t[i - stride]) / stride);
  if (!deltas.length) return Infinity;
  deltas.sort((a, b) => a - b);
  const median = deltas[deltas.length >> 1];
  // Scaled off the typical spacing only. An earlier version also floored this
  // at a fraction of the window, which drew a sparse feed as a solid line and
  // hid real multi-minute dropouts.
  return Math.max(20 * median, 2000);
}

/// `tx`, when given, is where each value is placed; `t` still decides breaks.
function draw(ctx, color, t, values, gapUs, seg, xOf, yOf, lineStyle, shape, tx = t) {
  if (lineStyle === 'dot') strokeDots(ctx, color, tx, values, seg, xOf, yOf, shape);
  else strokeLine(ctx, color, t, values, gapUs, seg, xOf, yOf, lineStyle === 'step', tx);
}

/// One mark per sample with nothing joining them -- for reading a feed as the
/// discrete events it is, and for seeing where it actually reported rather than
/// where a line implies it did. Gap detection does not apply: with no joins
/// there is nothing to break.
///
/// Every mark goes into one path so a dense window costs a single fill instead
/// of tens of thousands.
function strokeDots(ctx, color, t, values, seg, xOf, yOf, shape) {
  if (!values) return;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < t.length; i++) {
    const v = values[i];
    if (v == null) continue;
    addMark(ctx, shape, xOf(uOf(seg, t[i])), yOf(v), MARK_R);
  }
  ctx.fill();
}

function strokeLine(ctx, color, t, values, gapUs, seg, xOf, yOf, step, tx = t) {
  if (!values) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let moved = false;
  let prevY = 0;
  for (let i = 0; i < t.length; i++) {
    const v = values[i];
    if (v == null) { moved = false; continue; }
    if (i > 0 && t[i] - t[i - 1] > gapUs) moved = false;
    const x = xOf(uOf(seg, tx[i]));
    const y = yOf(v);
    if (!moved) {
      ctx.moveTo(x, y);
      moved = true;
    } else if (step) {
      // The recorded value holds until the next update -- draw what was true,
      // not a slope nobody observed.
      ctx.lineTo(x, prevY);
      ctx.lineTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
    prevY = y;
  }
  ctx.stroke();
}

/// Splits an index range wherever the sample spacing jumps, so envelopes don't
/// bridge across a quiet stretch.
function forEachRun(t, gapUs, fn) {
  let start = 0;
  for (let i = 1; i < t.length; i++) {
    if (t[i] - t[i - 1] > gapUs) {
      if (i - 1 > start) fn(start, i - 1);
      start = i;
    }
  }
  if (t.length - 1 > start) fn(start, t.length - 1);
}

/// Nearest loaded sample to a u position -- drives the readout.
export function sampleAt(segments, id, u) {
  let best = null;
  for (const seg of segments) {
    const c = seg.byChannel[id];
    if (!c || !c.t || !c.t.length) continue;
    const t = c.t;
    const target = seg.from + (u - seg.u0);
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= t.length) continue;
      const d = Math.abs(t[i] - target);
      if (best && d >= best.dist) continue;
      const value = c.mode === 'agg' ? c.last?.[i] : c.v?.[i];
      if (value == null) continue;
      best = {
        dist: d, t: t[i], value, mode: c.mode,
        lo: c.lo?.[i], hi: c.hi?.[i], first: c.first?.[i], bucketUs: c.bucketUs,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------- timeline --

export function drawTimeline(canvas, spec) {
  const {
    width, height, axis, coverage, seriesOrder, viewU0, viewU1, hoverU,
    lanes = seriesOrder, labels = true,
  } = spec;
  const ctx = fitCanvas(canvas, width, height);
  const left = TIMELINE_LEFT;
  const plotW = Math.max(1, width - left - PAD.right);
  const xOf = (u) => left + (u / Math.max(1e-9, axis.totalU)) * plotW;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, width, height);

  const rowsTop = TIMELINE_TOP;
  const laneH = TIMELINE_LANE - 3;
  const stripH = height - TIMELINE_AXIS;

  // Gaps span the full strip.
  for (const g of axis.gapsInU(0, axis.totalU)) {
    const x0 = xOf(g.u0);
    const x1 = xOf(g.u1);
    ctx.fillStyle = C.gap;
    ctx.fillRect(x0, 0, Math.max(3, x1 - x0), stripH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, 0, Math.max(3, x1 - x0), stripH);
    ctx.clip();
    ctx.strokeStyle = C.gapLine;
    ctx.lineWidth = 1;
    for (let x = x0 - stripH; x < x1 + stripH; x += 5) {
      ctx.beginPath();
      ctx.moveTo(x, stripH);
      ctx.lineTo(x + stripH, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  // One lane per series showing where that series has rows. A lane keeps the
  // colour of its place in the full order, so folding the strip down to one
  // series does not repaint it.
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textBaseline = 'middle';
  lanes.forEach((name, i) => {
    const y = rowsTop + i * TIMELINE_LANE;
    ctx.fillStyle = '#1a212a';
    ctx.fillRect(left, y, plotW, laneH);
    ctx.fillStyle = PALETTE[Math.max(0, seriesOrder.indexOf(name)) % PALETTE.length];
    ctx.globalAlpha = 0.85;
    for (const [a, b] of coverage[name] || []) {
      const x0 = xOf(axis.toU(a));
      const x1 = xOf(axis.toU(b));
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), laneH);
    }
    ctx.globalAlpha = 1;
    if (!labels) return;
    ctx.fillStyle = C.text;
    ctx.textAlign = 'right';
    ctx.fillText(ellipsize(ctx, name, left - 14), left - 8, y + laneH / 2);
  });

  // Selected window.
  const vx0 = xOf(viewU0);
  const vx1 = xOf(viewU1);
  ctx.fillStyle = 'rgba(10,13,17,0.66)';
  ctx.fillRect(left, 0, Math.max(0, vx0 - left), stripH);
  ctx.fillRect(vx1, 0, Math.max(0, width - PAD.right - vx1), stripH);
  ctx.strokeStyle = '#ffd43b';
  ctx.lineWidth = 1;
  ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(1, vx1 - vx0 - 1), stripH - 1);
  ctx.fillStyle = '#ffd43b';
  ctx.fillRect(vx0 - 1, 0, 3, stripH);
  ctx.fillRect(vx1 - 2, 0, 3, stripH);

  if (hoverU != null) {
    const x = Math.round(xOf(hoverU)) + 0.5;
    ctx.strokeStyle = C.crosshair;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, stripH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Time labels along the bottom.
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  drawXLabels(ctx, {
    ticks: timeTicks(axis, 0, axis.totalU, Math.max(3, Math.round(plotW / 130))),
    gaps: axis.gapsInU(0, axis.totalU),
    xOf,
    y: stripH + 7,
    min: left,
    max: width - PAD.right,
    prec: tickPrecision(axis.dataUs),
  });

  return { xOf, uOfX: (x) => ((x - left) / plotW) * axis.totalU, left, plotW, stripH };
}
