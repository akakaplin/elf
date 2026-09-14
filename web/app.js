// elf -- multi-channel viewer.
//
// React via the vendored UMD build plus htm for templating, so there is no
// bundler and no node_modules: the Rust server hands these files straight to
// the browser.

import { checkHealth, getCatalog, getCoverage, loadWindow } from './api.js';
import { buildAxis, fmtDelta, fmtDuration, fmtTime } from './timeaxis.js';
import {
  drawChart, drawTimeline, PALETTE, PAD, sampleAt,
  TIMELINE_AXIS, TIMELINE_LANE, TIMELINE_LEFT, TIMELINE_TOP,
} from './chart.js';
import { channelExtent, describeRange, fmtValue, groupChannels, unionExtent } from './scales.js';
import { compile, evalSegment, varNames } from './formula.js';

const html = htm.bind(React.createElement);
const { useCallback, useEffect, useMemo, useRef, useState } = React;

const MAX_CHANNELS = 10;
/// Synthetic channels live in their own id namespace so nothing downstream has
/// to special-case them: `syn:spread` groups, colours and hovers like any other.
const SYN = 'syn:';
const MAX_SYNTH = 10;
/// Values the page is willing to hold for one viewport. Roughly 14 bytes each
/// over the wire, so the middle option is about 14 MB.
const POINT_BUDGETS = [250_000, 1_000_000, 4_000_000];
/// How near a click has to land to count as hitting a line, in pixels.
const PICK_SLOP = 7;
/// Travel below which a press-and-release on the timeline is a click, not a drag.
const DRAG_SLOP = 3;
/// Shortest window worth loading: 1 ms of real time.
const MIN_SPAN_U = 1000;

/// Wheel over a time plot: ⌘/ctrl scales about the pointer, anything else pans.
/// `perPlot` is what one plot-width of travel is worth -- the window's own span
/// in a chart, the whole axis on the timeline, which is why the timeline moves
/// so much faster for the same flick.
function wheelNav(e, { u, perPlot, plotW, view, onWindow, onZoom }) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    onZoom(u, e.deltaY > 0 ? 1.25 : 0.8);
    return;
  }
  const shift = (wheelPixels(e) / Math.max(1, plotW)) * perPlot;
  onWindow(view.u0 + shift, view.u1 + shift);
}

/// Fits a window inside the axis by sliding it rather than squashing it.
/// Panning or jumping to the very end should keep the span you had -- clamping
/// each edge on its own silently shrinks the window instead.
function clampWindow(u0, u1, totalU) {
  const span = Math.min(u1 - u0, totalU);
  const lo = Math.max(0, Math.min(u0, totalU - span));
  return { u0: lo, u1: lo + span };
}
/// Fields that describe the encoding rather than the signal.
const DEMOTED = /^(price_dp|size_dp)$/;

/// Wheel deltas arrive in pixels, lines or pages depending on the device.
function wheelPixels(e) {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const x = e.deltaX * scale;
  const y = e.deltaY * scale;
  // A trackpad's vertical flick is the natural "scroll along" gesture here, so
  // whichever axis the user pushed hardest drives the pan.
  return Math.abs(x) > Math.abs(y) ? x : y;
}

// ------------------------------------------------------------------- hooks --

/// A callback ref rather than an effect: the measured element often mounts
/// after its owner's first render (the app shows a placeholder until the
/// catalog arrives), and a mount-time effect would observe nothing.
function useMeasure() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const roRef = useRef(null);
  const ref = useCallback((node) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (!node) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(node);
    roRef.current = ro;
    const r = node.getBoundingClientRect();
    setSize({ width: Math.round(r.width), height: Math.round(r.height) });
  }, []);
  return [ref, size];
}

/// Server liveness, polled on a timer. The page is otherwise silent between
/// viewport changes, so without this a server that died while the user sat
/// still would go unnoticed until their next pan.
///
/// A recursive timeout rather than an interval, so a slow answer delays the
/// next probe instead of stacking one behind it.
function useHealth(periodMs = 5000) {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    let alive = true;
    let timer = null;
    let busy = false;

    const tick = async () => {
      if (!alive || busy) return;
      busy = true;
      const ok = await checkHealth();
      busy = false;
      if (!alive) return;
      setOnline(ok);
      clearTimeout(timer);
      // A server that is down gets re-probed sooner, so the light returns to
      // green promptly once it is back rather than sitting red for a full
      // period after the fact.
      timer = setTimeout(tick, ok ? periodMs : 2000);
    };

    // A laptop that slept through several periods would wake showing a stale
    // green, so probe as soon as the tab is looked at again.
    const onWake = () => {
      if (document.visibilityState === 'visible') tick();
    };

    tick();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [periodMs]);

  return online;
}

// -------------------------------------------------------------------- app ---

function App() {
  const [catalog, setCatalog] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState([]);
  /// Channels that stay loaded but are not drawn -- toggled from the legend.
  const [hidden, setHidden] = useState([]);
  const [view, setView] = useState(null); // { u0, u1 } in collapsed-time units
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [queryMs, setQueryMs] = useState(null);

  const [groupMode, setGroupMode] = useState('auto');
  const [tolerance, setTolerance] = useState('auto');
  const [logScale, setLogScale] = useState(false);
  /// 'step' | 'line' | 'dot' -- how a channel's samples are joined, if at all.
  const [lineStyle, setLineStyle] = useState('step');
  const [rawBudget, setRawBudget] = useState(12000);
  const [maxPoints, setMaxPoints] = useState(POINT_BUDGETS[1]);
  const [hoverU, setHoverU] = useState(null);

  /// `{ name, expr, refs }` -- refs are real channel ids bound positionally to
  /// the names a, b, c, … that the expression is written against.
  const [synths, setSynths] = useState([]);
  const [collapsed, setCollapsed] = useState(false);

  const [stackRef, stackSize] = useMeasure();
  const hashRef = useRef(readHash());
  const online = useHealth();

  /// Formulas are compiled once per edit, not once per frame. A broken one
  /// keeps its place in the list -- it just carries an error and draws nothing,
  /// so a half-typed expression never vanishes the row being typed into.
  const compiled = useMemo(
    () => synths.map((d) => {
      try {
        return { ...d, id: SYN + d.name, fn: compile(d.expr, varNames(d.refs.length)).fn, error: null };
      } catch (e) {
        return { ...d, id: SYN + d.name, fn: null, error: String(e.message || e) };
      }
    }),
    [synths]
  );

  /// A formula's inputs have to be fetched whether or not they are themselves
  /// drawn, so the request list is the union of the two.
  const fetchChannels = useMemo(
    () => [...new Set([...selected, ...synths.flatMap((d) => d.refs)])],
    [selected, synths]
  );

  const displayIds = useMemo(
    () => [...selected, ...compiled.filter((d) => d.fn && d.refs.length).map((d) => d.id)],
    [selected, compiled]
  );

  // Catalog + coverage, once.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cat = await getCatalog();
        const cov = await getCoverage(15000);
        if (!alive) return;
        setCatalog(cat);
        setCoverage(cov);
        const have = new Set(cat.series.flatMap((x) => x.channels.map((c) => c.id)));
        const fromHash = (hashRef.current.c || []).filter((id) => have.has(id));
        const chosen = fromHash.length ? fromHash.slice(0, MAX_CHANNELS) : defaultChannels(cat);
        setSelected(chosen);
        setHidden(hashRef.current.h || []);
        setSynths(fitSynths(hashRef.current.s || [], chosen, have));
      } catch (e) {
        if (alive) setError(String(e.message || e));
      }
    })();
    return () => { alive = false; };
  }, []);

  const axis = useMemo(
    () => (coverage ? buildAxis(coverage.union) : null),
    [coverage]
  );

  // Open on whatever the URL asked for, else the most recent burst of data
  // rather than the whole week.
  useEffect(() => {
    if (!axis || view) return;
    const t = hashRef.current.t;
    if (t) {
      setView({ u0: axis.toU(t[0]), u1: axis.toU(t[1]) });
      return;
    }
    const last = axis.segments.filter((s) => s.kind === 'data').pop();
    setView(last ? { u0: last.u0, u1: last.u1 } : { u0: 0, u1: axis.totalU });
  }, [axis, view]);

  // Keep the address bar in step so a view can be bookmarked or shared.
  useEffect(() => {
    if (!axis || !view) return;
    const from = Math.round(axis.toT(view.u0));
    const to = Math.round(axis.toT(view.u1));
    const hash = buildHash({ from, to, selected, hidden, synths });
    if (hash !== window.location.hash) {
      window.history.replaceState(null, '', hash);
    }
  }, [axis, view, selected, hidden, synths]);

  const plotW = Math.max(120, stackSize.width - PAD.left - PAD.right);

  // Reload whenever the window, the channel set or the raw budget changes.
  const reqRef = useRef(0);
  const timerRef = useRef(null);
  useEffect(() => {
    if (!axis || !view || !fetchChannels.length) {
      setSegments([]);
      return;
    }
    const id = ++reqRef.current;
    const controller = new AbortController();
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      const started = performance.now();
      try {
        const ranges = axis.rangesForU(view.u0, view.u1);
        const segs = await loadWindow({
          ranges,
          channels: fetchChannels,
          totalBuckets: Math.min(3000, Math.max(200, Math.round(plotW))),
          maxRaw: rawBudget,
          maxPoints,
          signal: controller.signal,
        });
        if (reqRef.current !== id) return;
        setSegments(segs);
        setQueryMs(performance.now() - started);
        setError(null);
      } catch (e) {
        if (e.name !== 'AbortError' && reqRef.current === id) setError(String(e.message || e));
      } finally {
        if (reqRef.current === id) setLoading(false);
      }
    }, 90);
    return () => { clearTimeout(timerRef.current); controller.abort(); };
  }, [axis, view, fetchChannels, plotW, rawBudget, maxPoints]);

  /// Formulas are evaluated here rather than in SQL: their inputs live in
  /// different parquet files with unrelated sample times, and the join that
  /// needs is the step-function hold in `evalSegment` -- cheap over a viewport
  /// that has already been reduced to something a canvas can draw.
  const viewSegments = useMemo(() => {
    const live = compiled.filter((d) => d.fn && d.refs.length);
    if (!live.length) return segments;
    return segments.map((seg) => {
      const byChannel = { ...seg.byChannel };
      for (const d of live) {
        const c = evalSegment(seg, d.refs, d.fn);
        if (c) byChannel[d.id] = c;
      }
      return { ...seg, byChannel };
    });
  }, [segments, compiled]);

  const extents = useMemo(() => {
    const out = {};
    for (const id of displayIds) {
      const e = channelExtent(viewSegments, id);
      if (e) out[id] = e;
    }
    return out;
  }, [viewSegments, displayIds]);

  /// Formulas take the top of the stack. They are the thing being looked at
  /// when they exist at all, and magnitude-grouping alone would bury a spread
  /// among whatever else happens to share its range. Grouped separately from
  /// the real channels for the same reason: a derived line is rarely wanted
  /// overlaid on its own inputs.
  ///
  /// "One chart" is left alone -- it was asked for explicitly.
  const groups = useMemo(() => {
    if (groupMode === 'single') return groupChannels(displayIds, extents, groupMode, tolerance);
    const syn = displayIds.filter((id) => id.startsWith(SYN));
    const real = displayIds.filter((id) => !id.startsWith(SYN));
    if (!syn.length) return groupChannels(real, extents, groupMode, tolerance);
    return [
      ...groupChannels(syn, extents, groupMode, tolerance),
      ...groupChannels(real, extents, groupMode, tolerance),
    ];
  }, [displayIds, extents, groupMode, tolerance]);

  const colorOf = useCallback(
    (id) => PALETTE[Math.max(0, displayIds.indexOf(id)) % PALETTE.length],
    [displayIds]
  );

  const toggle = useCallback((id) => {
    setSelected((cur) => {
      if (cur.includes(id)) {
        // Dropping a channel drops its hidden flag with it, so re-adding it
        // later comes back visible rather than mysteriously blank.
        setHidden((h) => h.filter((x) => x !== id));
        return cur.filter((x) => x !== id);
      }
      if (cur.length >= MAX_CHANNELS) return cur;
      return [...cur, id];
    });
  }, []);

  /// Adding a formula can pull new inputs into the request, so capacity is
  /// checked against the union rather than against the selection alone.
  const roomFor = useCallback(
    (refs, skipIndex = -1) => {
      const others = synths.filter((_, i) => i !== skipIndex).flatMap((d) => d.refs);
      return new Set([...selected, ...others, ...refs]).size <= MAX_CHANNELS;
    },
    [selected, synths]
  );

  const addSynth = useCallback((def) => {
    setSynths((cur) => (cur.length >= MAX_SYNTH ? cur : [...cur, def]));
  }, []);

  const updateSynth = useCallback((i, def) => {
    setSynths((cur) => cur.map((d, k) => (k === i ? def : d)));
  }, []);

  const removeSynth = useCallback((i) => {
    setSynths((cur) => {
      const gone = cur[i];
      if (gone) setHidden((h) => h.filter((x) => x !== SYN + gone.name));
      return cur.filter((_, k) => k !== i);
    });
  }, []);

  const toggleVisible = useCallback((id) => {
    setHidden((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }, []);

  /// Scales about a point, keeping whatever sits under the pointer under it.
  const zoomAround = useCallback((centerU, factor) => {
    setView((v) => {
      if (!v || !axis) return v;
      const span = Math.min(axis.totalU, Math.max(MIN_SPAN_U, (v.u1 - v.u0) * factor));
      const frac = (centerU - v.u0) / Math.max(1e-9, v.u1 - v.u0);
      const u0 = centerU - frac * span;
      return clampWindow(u0, u0 + span, axis.totalU);
    });
  }, [axis]);

  const setWindow = useCallback((u0, u1) => {
    if (!axis) return;
    const lo = Math.min(u0, u1);
    const hi = Math.max(u0, u1);
    if (hi - lo < MIN_SPAN_U) return;
    setView(clampWindow(lo, hi, axis.totalU));
  }, [axis]);

  if (error && !catalog) return html`<div class="fatal">${error}</div>`;
  if (!catalog || !axis || !view) return html`<div class="fatal">loading…</div>`;

  const windowRanges = axis.rangesForU(view.u0, view.u1);
  const realSpan = windowRanges.reduce((a, r) => a + (r.to - r.from), 0);

  return html`
    <div class=${'app' + (collapsed ? ' collapsed' : '')}>
      <${Sidebar}
        catalog=${catalog}
        online=${online}
        collapsed=${collapsed}
        onCollapse=${() => setCollapsed(true)}
        onExpand=${() => setCollapsed(false)}
        compiled=${compiled}
        roomFor=${roomFor}
        onAddSynth=${addSynth}
        onUpdateSynth=${updateSynth}
        onRemoveSynth=${removeSynth}
        fetchCount=${fetchChannels.length}
        selected=${selected}
        hidden=${hidden}
        onToggle=${toggle}
        onClear=${() => { setSelected([]); setHidden([]); }}
        colorOf=${colorOf}
        chartCount=${groups.length}
        settings=${{
          groupMode, setGroupMode,
          tolerance, setTolerance,
          logScale, setLogScale,
          lineStyle, setLineStyle,
          rawBudget, setRawBudget,
          maxPoints, setMaxPoints,
          ceiling: catalog.limits ? catalog.limits.max_points_ceiling : POINT_BUDGETS[2],
        }}
      />
      <div class="main">
        <${Timeline}
          axis=${axis}
          coverage=${coverage}
          catalog=${catalog}
          selected=${selected}
          view=${view}
          onWindow=${setWindow}
          onZoom=${zoomAround}
          hoverU=${hoverU}
        />
        <${Toolbar}
          axis=${axis}
          view=${view}
          onWindow=${setWindow}
          onZoom=${zoomAround}
          realSpan=${realSpan}
        />
        <div class="stack" ref=${stackRef}>
          ${groups.length === 0
            ? html`<div class="empty">Pick up to ${MAX_CHANNELS} channels on the left.</div>`
            : groups.map((ids, i) => html`
                <${Chart}
                  key=${ids.join('|') || `empty-${i}`}
                  ids=${ids}
                  index=${i}
                  total=${groups.length}
                  axis=${axis}
                  view=${view}
                  segments=${viewSegments}
                  extents=${extents}
                  colorOf=${colorOf}
                  hidden=${hidden}
                  onToggleVisible=${toggleVisible}
                  logScale=${logScale}
                  lineStyle=${lineStyle}
                  hoverU=${hoverU}
                  onHoverU=${setHoverU}
                  onWindow=${setWindow}
                  onZoom=${zoomAround}
                />
              `)}
        </div>
        <${StatusBar}
          view=${view}
          axis=${axis}
          ranges=${windowRanges}
          realSpan=${realSpan}
          segments=${segments}
          channels=${displayIds.length}
          maxPoints=${maxPoints}
          loading=${loading}
          queryMs=${queryMs}
          error=${error}
        />
      </div>
    </div>
  `;
}

// --------------------------------------------------------------- formulas ---

/// Type-to-search over channel ids.
///
/// Not a `<select>`: there are hundreds of channels with long qualified names,
/// and the useful way in is "bbo bid" -- space-separated fragments that all
/// have to appear, in any order. The list sits in the flow rather than
/// floating, because the panel it lives in scrolls and would clip it.
function ChannelPicker({ all, value, onChange, label }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const blurRef = useRef(null);

  const matches = useMemo(() => {
    const parts = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = all.filter((id) => {
      const hay = id.toLowerCase();
      return parts.every((p) => hay.includes(p));
    });
    // The field name is what people are usually after, so an id whose part
    // after the colon starts with the query sorts first.
    const head = parts[0] || '';
    return hit
      .sort((a, b) => rank(a, head) - rank(b, head) || a.localeCompare(b))
      .slice(0, 60);
  }, [all, q]);

  const commit = (id) => {
    onChange(id);
    setQ('');
    setOpen(false);
  };

  return html`
    <div class="picker">
      <input
        class=${'p-input' + (value ? '' : ' unset')}
        placeholder=${value || 'search channels…'}
        value=${q}
        aria-label=${`Channel for ${label}`}
        onFocus=${() => { clearTimeout(blurRef.current); setOpen(true); setCursor(0); }}
        onBlur=${() => { blurRef.current = setTimeout(() => setOpen(false), 120); }}
        onInput=${(e) => { setQ(e.target.value); setOpen(true); setCursor(0); }}
        onKeyDown=${(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor((i) => Math.min(matches.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Enter') {
            if (open && matches[cursor]) { e.preventDefault(); e.stopPropagation(); commit(matches[cursor]); }
          } else if (e.key === 'Escape') { e.stopPropagation(); setQ(''); setOpen(false); }
        }}
      />
      ${value && !open ? html`<span class="p-chosen" title=${value}>${value}</span>` : null}
      ${open && html`
        <div class="p-list">
          ${matches.length
            ? matches.map((id, i) => html`
                <button
                  key=${id}
                  type="button"
                  class=${'p-opt' + (i === cursor ? ' on' : '') + (id === value ? ' cur' : '')}
                  onMouseEnter=${() => setCursor(i)}
                  onMouseDown=${(e) => { e.preventDefault(); commit(id); }}
                >${id}</button>
              `)
            : html`<div class="p-none">nothing matches “${q}”</div>`}
        </div>
      `}
    </div>
  `;
}

/// Lower sorts earlier: an exact field match, then a field prefix, then the rest.
function rank(id, head) {
  if (!head) return 2;
  const field = id.slice(id.indexOf(':') + 1).toLowerCase();
  if (field === head) return 0;
  if (field.startsWith(head)) return 1;
  return 2;
}

/// Editor for one synthetic channel.
///
/// The inputs are bound to short names rather than referenced by channel id:
/// an id like `binance_bbo_BTC:bid` is unreadable inside arithmetic, and the
/// thing people actually want to type is `a - b`.
function FormulaEditor({ catalog, initial, taken, roomFor, onSave, onCancel }) {
  const [name, setName] = useState(initial ? initial.name : '');
  const [expr, setExpr] = useState(initial ? initial.expr : '');
  const [refs, setRefs] = useState(initial ? initial.refs : []);

  const all = useMemo(
    () => catalog.series.flatMap((s) => s.channels.map((c) => c.id)),
    [catalog]
  );
  const vars = varNames(refs.length);

  // Validated on every keystroke: the formula is short and the parse is cheap,
  // and finding out at save time what is wrong is the annoying version.
  const problem = useMemo(() => {
    const n = name.trim();
    if (!n) return 'give it a name';
    if (!/^[A-Za-z0-9_. -]+$/.test(n)) return 'letters, digits, dot, dash, space and _ only';
    if (taken.includes(n)) return `"${n}" is already taken`;
    if (!refs.length) return 'add at least one input';
    if (refs.some((r) => !r)) return 'every input needs a channel';
    if (!roomFor(refs)) return `that would need more than ${MAX_CHANNELS} channels in one request`;
    if (!expr.trim()) return `write a formula over ${vars.join(', ')}`;
    try { compile(expr, vars); } catch (e) { return String(e.message || e); }
    return null;
  }, [name, expr, refs, taken, roomFor, vars.join(',')]);

  const save = () => {
    if (problem) return;
    onSave({ name: name.trim(), expr: expr.trim(), refs });
  };

  return html`
    <div class="editor">
      <input
        class="f-name"
        placeholder="name, e.g. spread"
        value=${name}
        onInput=${(e) => setName(e.target.value)}
      />

      ${refs.map((r, i) => html`
        <div class="f-ref" key=${i}>
          <em>${vars[i]}</em>
          <${ChannelPicker}
            all=${all}
            value=${r}
            label=${vars[i]}
            onChange=${(v) => setRefs((cur) => cur.map((x, k) => (k === i ? v : x)))}
          />
          <button
            class="mini"
            title=${`Remove ${vars[i]}`}
            aria-label=${`Remove input ${vars[i]}`}
            onClick=${() => setRefs((cur) => cur.filter((_, k) => k !== i))}
          >✕</button>
        </div>
      `)}

      <button
        class="ghost tight"
        disabled=${refs.length >= MAX_CHANNELS}
        onClick=${() => setRefs((cur) => [...cur, ''])}
      >+ input ${varNames(refs.length + 1)[refs.length]}</button>

      <input
        class="f-expr"
        placeholder=${vars.length > 1 ? `${vars[0]} - ${vars[1]}` : 'a'}
        value=${expr}
        onInput=${(e) => setExpr(e.target.value)}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') onCancel();
        }}
      />

      ${problem && html`<div class="f-why">${problem}</div>`}

      <div class="f-actions">
        <button class="ghost tight" onClick=${onCancel}>cancel</button>
        <button class="ghost tight go" disabled=${!!problem} onClick=${save}>
          ${initial ? 'save' : 'add'}
        </button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------- sidebar ---

function Sidebar(props) {
  const {
    catalog, online, collapsed, onCollapse, onExpand, selected, hidden, onToggle, onClear, colorOf,
    chartCount, settings, compiled, roomFor, onAddSynth, onUpdateSynth,
    onRemoveSynth, fetchCount,
  } = props;
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  /// `-1` is the draft row, a number is the formula being edited, null is neither.
  const [editing, setEditing] = useState(null);
  // A formula's inputs occupy request slots too, so the budget shown is the
  // one the server actually enforces.
  const full = fetchCount >= MAX_CHANNELS;

  // Collapsed, the panel keeps a rail of its own rather than vanishing and
  // floating a button over the chart -- which lands on the timeline's labels.
  if (collapsed) {
    return html`
      <aside class="sidebar rail">
        <button
          class="reveal"
          onClick=${onExpand}
          title="Show the panel"
          aria-label="Show the panel"
        >
          <span class=${'dot' + (online ? '' : ' off')}></span>
          <span class="chev">»</span>
        </button>
      </aside>
    `;
  }

  return html`
    <aside class="sidebar">
      <div class="topbar">
        <div class="brand">
          <span
            class=${'dot' + (online ? '' : ' off')}
            title=${online ? 'server reachable' : 'server unreachable'}
            aria-label=${online ? 'server reachable' : 'server unreachable'}
          ></span>elf
          <span class="sub" tabindex="0">${catalog.data_dir}</span>
          <span class="path-tip">${catalog.data_dir}</span>
          <button
            class=${'cog' + (open ? ' on' : '')}
            onClick=${() => setOpen((o) => !o)}
            title="Settings"
            aria-label="Settings"
            aria-expanded=${open}
          >⚙</button>
          <button
            class="cog"
            onClick=${onCollapse}
            title="Hide the panel"
            aria-label="Hide the panel"
            aria-expanded=${!collapsed}
          >«</button>
        </div>
        ${open && html`
          <${Settings} s=${settings} chartCount=${chartCount} onClose=${() => setOpen(false)} />
        `}
      </div>

      <div class="section">
        <div class="section-head">
          <span>Channels</span>
          <span
            class=${'count' + (full ? ' full' : '')}
            title=${fetchCount > selected.length
              ? `${selected.length} drawn + ${fetchCount - selected.length} read by formulas`
              : 'channels in the request'}
          >${fetchCount} / ${MAX_CHANNELS}</span>
        </div>
        <input
          class="filter"
          placeholder="filter…"
          value=${filter}
          onInput=${(e) => setFilter(e.target.value)}
        />
        <div class="channels">
          ${catalog.series.map((s) => {
            const visible = s.channels.filter(
              (c) => !filter || `${s.name}:${c.field}`.toLowerCase().includes(filter.toLowerCase())
            );
            if (!visible.length) return null;
            return html`
              <div class="series" key=${s.name}>
                <div class="series-head">
                  ${s.name}
                  <span class="rows">${s.rows.toLocaleString()}</span>
                </div>
                ${visible.map((c) => {
                  const on = selected.includes(c.id);
                  const off = on && hidden.includes(c.id);
                  const blocked = !on && full;
                  return html`
                    <button
                      key=${c.id}
                      type="button"
                      class=${'chan' + (on ? ' on' : '') + (off ? ' off' : '')
                        + (DEMOTED.test(c.field) ? ' demoted' : '')}
                      style=${{ borderLeftColor: on ? colorOf(c.id) : 'transparent' }}
                      aria-pressed=${on}
                      disabled=${blocked}
                      title=${blocked ? `Deselect one first — ${MAX_CHANNELS} is the limit` : c.id}
                      onClick=${() => onToggle(c.id)}
                    >
                      <span
                        class="swatch"
                        style=${on
                          ? { background: off ? 'transparent' : colorOf(c.id), borderColor: colorOf(c.id) }
                          : null}
                      ></span>
                      <span class="name">${c.field}</span>
                      <span class="dtype">${c.dtype.toLowerCase()}</span>
                    </button>
                  `;
                })}
              </div>
            `;
          })}
        </div>
        <button class="ghost" onClick=${onClear} disabled=${!selected.length}>clear selection</button>
      </div>

      <div class="section formulas">
        <div class="section-head">
          <span>Formulas</span>
          <span class="count">${compiled.length} / ${MAX_SYNTH}</span>
        </div>

        ${compiled.map((d, i) => (editing === i
          ? html`
            <${FormulaEditor}
              key=${`edit-${i}`}
              catalog=${catalog}
              initial=${d}
              taken=${compiled.filter((_, k) => k !== i).map((x) => x.name)}
              roomFor=${(refs) => roomFor(refs, i)}
              onSave=${(def) => { onUpdateSynth(i, def); setEditing(null); }}
              onCancel=${() => setEditing(null)}
            />`
          : html`
            <div class=${'synth' + (d.error ? ' bad' : '')} key=${d.id}>
              <span class="swatch" style=${d.error ? null : { background: colorOf(d.id), borderColor: colorOf(d.id) }}></span>
              <span class="body">
                <span class="name">${d.name}</span>
                <span class="expr">${d.expr}</span>
                ${d.error
                  ? html`<span class="why err">${d.error}</span>`
                  : html`<span class="why">${varNames(d.refs.length).map((v, k) =>
                      html`<span class="bind" key=${v}><em>${v}</em>${d.refs[k]}</span>`)}</span>`}
              </span>
              <button class="mini" title="Edit" aria-label=${`Edit ${d.name}`} onClick=${() => setEditing(i)}>✎</button>
              <button class="mini" title="Delete" aria-label=${`Delete ${d.name}`} onClick=${() => onRemoveSynth(i)}>✕</button>
            </div>`
        ))}

        ${editing === -1
          ? html`
            <${FormulaEditor}
              catalog=${catalog}
              initial=${null}
              taken=${compiled.map((x) => x.name)}
              roomFor=${(refs) => roomFor(refs)}
              onSave=${(def) => { onAddSynth(def); setEditing(null); }}
              onCancel=${() => setEditing(null)}
            />`
          : html`
            <button
              class="ghost"
              disabled=${compiled.length >= MAX_SYNTH}
              onClick=${() => setEditing(-1)}
            >+ new formula</button>`}
      </div>
    </aside>
  `;
}

// --------------------------------------------------------------- settings ---

/// Everything here has a working default -- charts group themselves and the
/// resolution follows the window -- so it lives behind the cog rather than
/// taking up room next to the channel list.
function Settings({ s, chartCount, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.cog')) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  const auto = s.tolerance === 'auto';

  return html`
    <div class="settings" ref=${ref}>
      <div class="section">
        <div class="section-head">
          <span>Charts</span>
          <span class="count">${chartCount} ${chartCount === 1 ? 'chart' : 'charts'}</span>
        </div>
        <div class="seg">
          ${[['auto', 'by range'], ['single', 'one chart'], ['separate', 'one each']].map(
            ([k, label]) => html`
              <button
                key=${k}
                class=${s.groupMode === k ? 'on' : ''}
                onClick=${() => s.setGroupMode(k)}
              >${label}</button>
            `
          )}
        </div>
        ${s.groupMode === 'auto' && html`
          <label class="check">
            <input
              type="checkbox"
              checked=${auto}
              onChange=${(e) => s.setTolerance(e.target.checked ? 'auto' : 50)}
            />
            detect the split from the data
          </label>
          ${!auto && html`
            <label class="slider">
              <span>split above <b>${s.tolerance}×</b> range gap</span>
              <input
                type="range" min="1" max="4" step="0.05"
                value=${Math.log10(s.tolerance)}
                onInput=${(e) => s.setTolerance(Math.round(Math.pow(10, +e.target.value)))}
              />
            </label>
          `}
        `}
        <label class="check">
          <input type="checkbox" checked=${s.logScale} onChange=${(e) => s.setLogScale(e.target.checked)} />
          log y-axis
        </label>
        <div class="slider">
          <span>lines</span>
          <div class="seg">
            ${[
              ['step', 'step', 'Hold each value until the next update — what was actually true'],
              ['line', 'line', 'Join samples directly'],
              ['dot', 'dot', 'One mark per sample, nothing joining them'],
            ].map(([k, label, why]) => html`
              <button
                key=${k}
                title=${why}
                class=${s.lineStyle === k ? 'on' : ''}
                onClick=${() => s.setLineStyle(k)}
              >${label}</button>
            `)}
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-head"><span>Resolution</span></div>
        <label class="slider">
          <span>serve raw points below</span>
          <select value=${s.rawBudget} onChange=${(e) => s.setRawBudget(+e.target.value)}>
            <option value="3000">3k rows</option>
            <option value="12000">12k rows</option>
            <option value="50000">50k rows</option>
          </select>
        </label>
        <p class="note">
          Above that the window is bucketed on the fly into min/max envelopes.
          Nothing is precomputed — every pixel comes from the parquet files.
        </p>
      </div>

      <div class="section">
        <div class="section-head"><span>Memory</span></div>
        <label class="slider">
          <span>hold at most</span>
          <select value=${s.maxPoints} onChange=${(e) => s.setMaxPoints(+e.target.value)}>
            ${POINT_BUDGETS.filter((n) => n <= s.ceiling).map((n) => html`
              <option key=${n} value=${n}>
                ${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M values
                · ≈${Math.round((n * 14) / 1e6)} MB
              </option>
            `)}
          </select>
        </label>
        <p class="note">
          The bucket count and the raw threshold are both trimmed to fit this,
          so no window — however wide, however many channels — pulls an
          unbounded result into memory. A viewport spanning several bursts
          shares one budget across its queries.
        </p>
      </div>
    </div>
  `;
}

// --------------------------------------------------------------- timeline ---

function Timeline({ axis, coverage, catalog, selected, view, onWindow, onZoom, hoverU }) {
  const [ref, size] = useMeasure();
  const canvasRef = useRef(null);
  const geomRef = useRef(null);
  const dragRef = useRef(null);
  const seriesOrder = catalog.series.map((s) => s.name);

  /// Only a series with a selected channel gets a lane, kept in catalog order.
  /// With nothing selected the strip is just the time axis -- still enough to
  /// move the window with.
  const chosen = new Set(selected.map((id) => id.split(':')[0]));
  const active = seriesOrder.filter((s) => chosen.has(s));

  /// Folded, the strip keeps a single lane: every series adds a row, and with
  /// enough of them the coverage overview pushes the charts down the page. One
  /// lane is still enough to steer the window by.
  const [folded, setFolded] = useState(false);
  // Folding a single lane changes nothing, so the fold only takes with several.
  const fold = folded && active.length > 1;
  /// The lane the user chose while folded. Until they choose, it follows the
  /// series of the first selected channel -- the one being looked at.
  const [picked, setPicked] = useState(null);
  const lead = selected.map((id) => id.split(':')[0]).find((s) => active.includes(s));
  const current = active.includes(picked) ? picked : lead;
  const lanes = fold ? [current] : active;
  const height = TIMELINE_TOP + lanes.length * TIMELINE_LANE + TIMELINE_AXIS;

  useEffect(() => {
    if (!canvasRef.current || !size.width) return;
    geomRef.current = drawTimeline(canvasRef.current, {
      width: size.width,
      height,
      axis,
      coverage: coverage.series,
      seriesOrder,
      lanes,
      // Folded, the picker sits where the label would be drawn.
      labels: !fold,
      viewU0: view.u0,
      viewU1: view.u1,
      hoverU,
    });
  }, [size.width, height, axis, coverage, view, hoverU, fold, seriesOrder.join(), lanes.join()]);

  const uAt = (e) => {
    const g = geomRef.current;
    if (!g) return 0;
    const rect = canvasRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(axis.totalU, g.uOfX(e.clientX - rect.left)));
  };

  const onPointerDown = (e) => {
    const g = geomRef.current;
    if (!g) return;
    const u = uAt(e);
    const edgeU = (6 / g.plotW) * axis.totalU;
    let mode = 'new';
    if (Math.abs(u - view.u0) < edgeU) mode = 'left';
    else if (Math.abs(u - view.u1) < edgeU) mode = 'right';
    else if (u > view.u0 && u < view.u1) mode = 'move';
    dragRef.current = { mode, startU: u, u0: view.u0, u1: view.u1, startX: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    // A few pixels of travel is a click with a shaky hand, not a drag. Without
    // this, pressing to jump would first collapse the window to nothing.
    if (!d.moved && Math.abs(e.clientX - d.startX) < DRAG_SLOP) return;
    d.moved = true;
    const u = uAt(e);
    if (d.mode === 'new') onWindow(d.startU, u);
    else if (d.mode === 'left') onWindow(u, d.u1);
    else if (d.mode === 'right') onWindow(d.u0, u);
    else {
      const delta = u - d.startU;
      onWindow(d.u0 + delta, d.u1 + delta);
    }
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    // A click rather than a drag: take the window to that point at the span it
    // already has. Dragging an edge is left alone -- that is a resize gesture,
    // and a click that missed one should not fling the window across the day.
    if (d && !d.moved && (d.mode === 'new' || d.mode === 'move')) {
      const half = (d.u1 - d.u0) / 2;
      onWindow(d.startU - half, d.startU + half);
    }
  };

  return html`
    <div class="timeline" ref=${ref} style=${{ height: `${height}px` }}>
      <canvas
        ref=${canvasRef}
        style=${{ width: '100%', height: `${height}px` }}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${onPointerUp}
        onWheel=${(e) => wheelNav(e, {
          u: uAt(e), perPlot: axis.totalU, view, onWindow, onZoom,
          plotW: geomRef.current ? geomRef.current.plotW : 0,
        })}
        onDblClick=${() => onWindow(0, axis.totalU)}
      />
      ${fold && html`
        <select
          class="lane-pick"
          style=${{ top: `${TIMELINE_TOP - 2}px`, width: `${TIMELINE_LEFT - 14}px` }}
          value=${current}
          onChange=${(e) => setPicked(e.target.value)}
          title="Series shown while the strip is folded"
          aria-label="Series shown while the strip is folded"
        >
          ${active.map((name) => html`<option key=${name} value=${name}>${name}</option>`)}
        </select>
      `}
      ${active.length > 1 && html`
        <button
          type="button"
          class="fold"
          onClick=${() => setFolded((f) => !f)}
          title=${fold ? 'Show every selected series' : 'Fold the strip to one series'}
          aria-expanded=${!fold}
        >${fold ? `▸ 1 of ${active.length}` : `▾ ${active.length} series`}</button>
      `}
    </div>
  `;
}

// ---------------------------------------------------------------- toolbar ---

const QUICK = [
  ['1s', 1e6], ['10s', 1e7], ['1m', 6e7], ['5m', 3e8],
  ['30m', 1.8e9], ['2h', 7.2e9], ['12h', 4.32e10],
];

function Toolbar({ axis, view, onWindow, onZoom, realSpan }) {
  const centerU = (view.u0 + view.u1) / 2;

  const setSpan = (us) => {
    // Spans are in real time; walk outward from the centre until the window
    // covers that much actual data, so collapsed gaps don't eat the request.
    let lo = 0;
    let hi = axis.totalU;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const got = axis.dataUsInU(
        Math.max(0, centerU - mid / 2),
        Math.min(axis.totalU, centerU + mid / 2)
      );
      if (got < us) lo = mid; else hi = mid;
    }
    onWindow(centerU - hi / 2, centerU + hi / 2);
  };

  const pan = (frac) => {
    const span = view.u1 - view.u0;
    onWindow(view.u0 + span * frac, view.u1 + span * frac);
  };

  return html`
    <div class="toolbar">
      <button onClick=${() => onWindow(0, axis.totalU)}>fit all</button>
      <span class="divider"></span>
      <button onClick=${() => pan(-0.5)} title="pan left">‹</button>
      <button onClick=${() => onZoom(centerU, 0.5)} title="zoom in">+</button>
      <button onClick=${() => onZoom(centerU, 2)} title="zoom out">−</button>
      <button onClick=${() => pan(0.5)} title="pan right">›</button>
      <span class="divider"></span>
      <span class="hint">window</span>
      ${QUICK.map(([label, us]) => html`
        <button key=${label} class=${Math.abs(realSpan - us) / us < 0.08 ? 'on' : ''} onClick=${() => setSpan(us)}>
          ${label}
        </button>
      `)}
      <span class="spacer"></span>
      <span class="hint">click to jump · drag to zoom · wheel or shift-drag to pan · ⌘/ctrl-wheel to scale</span>
    </div>
  `;
}

// ------------------------------------------------------------------ chart ---

function Chart(props) {
  const {
    ids, index, total, axis, view, segments, extents, colorOf,
    hidden, onToggleVisible, logScale, lineStyle, hoverU, onHoverU, onWindow, onZoom,
  } = props;
  const canvasRef = useRef(null);
  const geomRef = useRef(null);
  const [boxRef, box] = useMeasure();
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const showX = index === total - 1;
  const { width, height } = box;

  // Hiding a line rescales the axis around what is left -- that is most of the
  // reason to hide one. It does not regroup the charts, so nothing jumps.
  const shown = useMemo(() => ids.filter((id) => !hidden.includes(id)), [ids, hidden]);

  const extent = useMemo(() => unionExtent(shown, extents), [shown, extents]);

  useEffect(() => {
    if (!canvasRef.current || !width || !height) return;
    geomRef.current = drawChart(canvasRef.current, {
      width, height, axis, u0: view.u0, u1: view.u1,
      ids: shown, colorOf, segments, extent, showXLabels: showX, hoverU, logScale, lineStyle,
    });
  }, [width, height, axis, view, shown, segments, extent, showX, hoverU, logScale, lineStyle, colorOf]);

  const uAt = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const plotW = width - PAD.left - PAD.right;
    const frac = (e.clientX - rect.left - PAD.left) / Math.max(1, plotW);
    return view.u0 + frac * (view.u1 - view.u0);
  };

  const onPointerDown = (e) => {
    const u = uAt(e);
    dragRef.current = { startU: u, startX: e.clientX, pan: e.shiftKey, u0: view.u0, u1: view.u1 };
    setDrag(e.shiftKey ? null : { a: u, b: u });
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const u = uAt(e);
    onHoverU(u);
    const d = dragRef.current;
    if (!d) {
      const canvas = canvasRef.current;
      if (canvas) canvas.style.cursor = lineAt(e) ? 'pointer' : 'crosshair';
      return;
    }
    if (d.pan) {
      const delta = d.startU - u;
      onWindow(d.u0 + delta, d.u1 + delta);
    } else {
      setDrag({ a: d.startU, b: u });
    }
  };

  /// Which drawn line the pointer is on, if any. Agg channels are picked
  /// against their whole min/max band, not just the closing line.
  const lineAt = (e) => {
    const geom = geomRef.current;
    if (!geom) return null;
    const y = e.clientY - canvasRef.current.getBoundingClientRect().top;
    const u = uAt(e);
    let best = null;
    for (const id of shown) {
      const sample = sampleAt(segments, id, u);
      if (!sample) continue;
      let dist = Math.abs(geom.yOf(sample.value) - y);
      if (sample.mode === 'agg' && sample.lo != null && sample.hi != null) {
        const a = geom.yOf(sample.lo);
        const b = geom.yOf(sample.hi);
        const top = Math.min(a, b);
        const bottom = Math.max(a, b);
        dist = y < top ? top - y : y > bottom ? y - bottom : 0;
      }
      if (!best || dist < best.dist) best = { id, dist };
    }
    return best && best.dist <= PICK_SLOP ? best.id : null;
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (d && !d.pan) {
      if (Math.abs(e.clientX - d.startX) > 4) {
        onWindow(d.startU, uAt(e));
      } else {
        // A press that never moved is a pick, not a zoom. Landing on a line
        // toggles it; landing on empty plot does nothing.
        const hit = lineAt(e);
        if (hit) onToggleVisible(hit);
      }
    }
    setDrag(null);
  };

  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const xOfU = (u) => PAD.left + ((u - view.u0) / Math.max(1e-9, view.u1 - view.u0)) * plotW;

  return html`
    <div class="chart" ref=${boxRef}>
      <canvas
        ref=${canvasRef}
        style=${{ width: '100%', height: '100%' }}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${onPointerUp}
        onPointerLeave=${() => onHoverU(null)}
        onWheel=${(e) => wheelNav(e, {
          u: uAt(e), perPlot: view.u1 - view.u0, plotW, view, onWindow, onZoom,
        })}
        onDblClick=${() => onZoom((view.u0 + view.u1) / 2, 2.5)}
      />
      ${drag && Math.abs(drag.b - drag.a) > 0 && html`
        <div
          class="brush"
          style=${{
            left: `${Math.min(xOfU(drag.a), xOfU(drag.b))}px`,
            width: `${Math.abs(xOfU(drag.b) - xOfU(drag.a))}px`,
          }}
        ></div>
      `}
      <div class="legend">
        <span class="range">
          ${shown.length ? describeRange(shown, extents) : 'all hidden'}
        </span>
        ${ids.map((id) => {
          const off = hidden.includes(id);
          const s = hoverU != null ? sampleAt(segments, id, hoverU) : null;
          return html`
            <button
              type="button"
              key=${id}
              class=${'item' + (off ? ' off' : '')}
              aria-pressed=${!off}
              title=${off ? 'Show this line' : 'Hide this line — its data stays loaded'}
              onClick=${() => onToggleVisible(id)}
            >
              <i style=${{ background: colorOf(id) }}></i>
              ${labelFor(id)}
              <b>${s ? fmtValue(s.value) : ''}</b>
              ${s && s.mode === 'agg' && s.lo != null && s.hi !== s.lo
                ? html`<u>${fmtValue(s.lo)}…${fmtValue(s.hi)}</u>`
                : null}
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

function labelFor(id) {
  const [series, field] = id.split(':');
  // A formula has no series to qualify it, so it is marked as computed instead.
  if (series === 'syn') return html`<span class="lbl syn"><em>ƒ</em>${field}</span>`;
  return html`<span class="lbl"><em>${series.replace(/_BTC$/, '')}</em>${field}</span>`;
}

// ------------------------------------------------------------------ status --

function StatusBar(props) {
  const {
    view, axis, ranges, realSpan, segments, channels, maxPoints, loading, queryMs, error,
  } = props;
  const t0 = ranges.length ? ranges[0].from : axis.toT(view.u0);
  const t1 = ranges.length ? ranges[ranges.length - 1].to : axis.toT(view.u1);

  // Derived here rather than passed in: these describe the response, and every
  // one of them was a prop that existed only to be printed on this line.
  const modes = new Set(segments.flatMap((s) => Object.values(s.byChannel).map((c) => c.mode)));
  const mode = modes.size === 0 ? '—' : modes.size === 1 ? [...modes][0] : 'raw + agg';
  const rows = segments.reduce((a, s) => a + s.rows, 0);
  const points = segments.reduce((a, s) => a + (s.points || 0), 0);
  const bucketUs = Math.max(0, ...segments.map((s) => s.bucketUs || 0));
  const capped = segments.some((s) => s.capped);

  return html`
    <div class=${'status' + (loading ? ' busy' : '')}>
      <span class="k">window · utc</span>
      <span class="v">
        ${fmtTime(t0)}<span class="arrow">→</span>${fmtDelta(t1 - t0)}
      </span>
      ${ranges.length > 1 && html`
        <span class="k">covers</span>
        <span class="v">${fmtDuration(realSpan)} in ${ranges.length} spans</span>
      `}
      <span class="k">mode</span>
      <span class=${'v mode ' + mode.replace(/\W/g, '')}>
        ${mode}${mode !== 'raw' && bucketUs ? ` · ${fmtDuration(bucketUs)}/bucket` : ''}
      </span>
      <span class="k">rows</span>
      <span class="v">${rows.toLocaleString()}</span>
      <span class="k">held</span>
      <span
        class=${'v' + (capped ? ' capped' : '')}
        title=${`Values loaded into the page, against a ${maxPoints.toLocaleString()} budget. Change it under the cog.`}
      >
        ${points.toLocaleString()}${capped ? ' · capped' : ''}
      </span>
      <span class="k">channels</span>
      <span class="v">${channels}</span>
      <span class="spacer"></span>
      ${error && html`<span class="err">${error}</span>`}
      <span class="v dim">${loading ? 'querying…' : queryMs != null ? `${Math.round(queryMs)} ms` : ''}</span>
    </div>
  `;
}

// ----------------------------------------------------------------- helpers --

/// `#t=<from>-<to>&c=<channel>,…&h=<hidden channel>,…` -- epoch micros, UTC.
function readHash() {
  const out = {};
  const raw = window.location.hash.replace(/^#/, '');
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === 't' && v) {
      const m = v.match(/^(-?\d+)-(-?\d+)$/);
      if (m) out.t = [Number(m[1]), Number(m[2])];
    } else if ((k === 'c' || k === 'h') && v) {
      out[k] = decodeURIComponent(v).split(',').filter(Boolean);
    } else if (k === 's' && v) {
      // A shared link carries whatever the sender had typed; anything that is
      // not the shape written above is dropped rather than trusted.
      try {
        const raw = JSON.parse(decodeURIComponent(v));
        out.s = (Array.isArray(raw) ? raw : [])
          .filter((d) => Array.isArray(d) && typeof d[0] === 'string'
            && typeof d[1] === 'string' && Array.isArray(d[2]))
          .map((d) => ({ name: d[0], expr: d[1], refs: d[2].filter((x) => typeof x === 'string') }))
          .slice(0, MAX_SYNTH);
      } catch { /* a hand-edited URL is not worth a crash */ }
    }
  }
  return out;
}

/// The inverse of `readHash`.
function buildHash({ from, to, selected, hidden, synths }) {
  return `#t=${from}-${to}&c=${selected.join(',')}`
    + (hidden.length ? `&h=${hidden.join(',')}` : '')
    + (synths.length ? `&s=${encodeURIComponent(JSON.stringify(
        synths.map((d) => [d.name, d.expr, d.refs])))}` : '');
}

/// Takes formulas from a link while their inputs still fit inside one request.
/// Dropping the ones that do not beats failing the whole viewport.
function fitSynths(defs, selected, have) {
  const budget = new Set(selected);
  const kept = [];
  for (const d of defs) {
    if (!d.refs.length || !d.refs.every((r) => have.has(r))) continue;
    if (new Set([...budget, ...d.refs]).size > MAX_CHANNELS) continue;
    for (const r of d.refs) budget.add(r);
    kept.push(d);
  }
  return kept;
}

/// A useful opening set: quotes and prints from each venue, sizes included so
/// the range-splitting has something to split.
function defaultChannels(catalog) {
  const wanted = [
    'binance_bbo_BTC:bid',
    'binance_bbo_BTC:ask',
    'perpl_positions_BTC:bid1',
    'perpl_positions_BTC:ask1',
    'perpl_positions_BTC:bid1_size',
    'perpl_trades_BTC:price',
    'perpl_trades_BTC:size',
  ];
  const have = new Set(catalog.series.flatMap((s) => s.channels.map((c) => c.id)));
  const picked = wanted.filter((id) => have.has(id));
  if (picked.length) return picked.slice(0, MAX_CHANNELS);
  return catalog.series
    .flatMap((s) => s.channels)
    .filter((c) => !DEMOTED.test(c.field) && !/_ns$/.test(c.field))
    .slice(0, 4)
    .map((c) => c.id);
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
