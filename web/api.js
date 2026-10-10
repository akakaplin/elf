// Thin client over the Rust server. One request per contiguous stretch of real
// data in the viewport, so a window that straddles a week-long gap costs two
// small queries instead of one enormous one.

async function getJson(url, signal) {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * Heartbeat. Resolves true when the server answers, false on any failure --
 * a dead socket, a timeout, or a non-2xx. Never throws, so the caller can poll
 * it on a bare interval without a catch on every tick.
 */
export async function checkHealth(timeoutMs = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/health', { signal: ctl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function getCatalog(signal) {
  return getJson('/api/catalog', signal);
}

/// `mergeMs` joins per-series gaps that short; the union stays exact.
export function getCoverage(bucketMs, mergeMs, signal) {
  return getJson(
    `/api/coverage?bucket_ms=${Math.round(bucketMs)}&merge_ms=${Math.round(mergeMs)}`,
    signal,
  );
}

/**
 * Loads one viewport.
 *
 * `ranges` come from the time axis and are already gap-free. Buckets are shared
 * out by how much screen each range occupies, so pixel density stays even
 * across a window that spans several bursts.
 *
 * The point budget covers the viewport, and the server will not take less than
 * `minPoints` for one request. When there are more ranges than the budget can
 * give that much each, neighbouring ranges are fetched together -- one request
 * spanning the gaps between them -- and the answer is cut back into the ranges
 * by timestamp. Gaps hold no rows, so nothing is lost in the cut; what a merged
 * request gives up is the buckets that land in its gaps.
 */
export async function loadWindow({
  ranges, channels, totalBuckets, maxRaw = 12000, maxPoints, minPoints = 2000, signal,
}) {
  if (!ranges.length || !channels.length) return [];

  const uSpan = ranges.reduce((acc, r) => acc + (r.u1 - r.u0), 0) || 1;
  const chanParam = encodeURIComponent(channels.join(','));
  const groups = groupRanges(ranges, Math.max(1, Math.floor(maxPoints / minPoints)));
  // Budgets cover the viewport, not each request: a window straddling several
  // bursts issues several queries, and they share one allowance rather than
  // each claiming the whole thing.
  const pointShare = Math.floor(maxPoints / groups.length);
  const rawShare = Math.max(500, Math.floor(maxRaw / groups.length));

  const requests = groups.map(async (group) => {
    const from = group[0].from;
    const to = group[group.length - 1].to;
    const uWidth = group.reduce((acc, r) => acc + (r.u1 - r.u0), 0);
    // A merged request buckets wall-clock time, gaps included; scale the count
    // up so the stretches that hold data keep their share of the resolution.
    const spread = (to - from) / (uWidth || 1);
    const buckets = Math.min(20000, Math.max(8, Math.round(totalBuckets * (uWidth / uSpan) * spread)));
    const url =
      `/api/data?from=${from}&to=${to}&buckets=${buckets}` +
      `&max_raw=${rawShare}&max_points=${pointShare}&channels=${chanParam}`;
    const body = await getJson(url, signal);
    if (group.length === 1) return [flatten(group[0], body)];
    return splitBody(body, group).map((part, i) => flatten(group[i], part));
  });

  return (await Promise.all(requests)).flat();
}

/// Consecutive runs of `ranges`, at most `n` of them, as even in count as they
/// can be. With `n` at least the number of ranges, each range is its own run.
function groupRanges(ranges, n) {
  if (ranges.length <= n) return ranges.map((r) => [r]);
  const out = [];
  for (let g = 0; g < n; g++) {
    const a = Math.floor((g * ranges.length) / n);
    const b = Math.floor(((g + 1) * ranges.length) / n);
    out.push(ranges.slice(a, b));
  }
  return out;
}

/// Cuts one response covering several ranges into one response per range. A
/// point belongs to the range its reading falls in -- `t_last` for a bucket,
/// since a bucket's start can sit in a gap. The response-level totals go with
/// the first part so that summing over parts still gives the right figures.
function splitBody(body, group) {
  const parts = group.map((_, i) => ({
    points: 0,
    capped: body.capped,
    series: {},
  }));
  for (const [name, sd] of Object.entries(body.series || {})) {
    const key = sd.t_last || sd.t;
    let lo = 0;
    let rowsLeft = sd.rows || 0;
    group.forEach((r, i) => {
      let hi = lo;
      while (hi < key.length && key[hi] < r.to) hi++;
      const at = (a) => a && a.slice(lo, hi);
      const channels = {};
      for (const [field, c] of Object.entries(sd.channels || {})) {
        channels[field] = { v: at(c.v), lo: at(c.lo), hi: at(c.hi), first: at(c.first), last: at(c.last) };
      }
      const n = hi - lo;
      // Raw rows are counted exactly; a bucketed series' row total cannot be
      // divided after the fact, so it goes with the first part that has data.
      const rows = sd.mode === 'raw' ? n : n ? rowsLeft : 0;
      if (sd.mode !== 'raw' && n) rowsLeft = 0;
      parts[i].series[name] = { ...sd, rows, t: sd.t.slice(lo, hi), t_last: at(sd.t_last), channels };
      const perRow = Object.keys(channels).length * (sd.mode === 'raw' ? 1 : 4) + (sd.t_last ? 2 : 1);
      parts[i].points += n * perRow;
      lo = hi;
    });
  }
  return parts;
}

/// Server groups by series; charts think in channels.
function flatten(range, body) {
  const byChannel = {};
  let rows = 0;
  let anyRaw = false;
  let bucketUs = 0;

  for (const [series, sd] of Object.entries(body.series || {})) {
    rows += sd.rows || 0;
    if (sd.mode === 'raw') anyRaw = true;
    else bucketUs = Math.max(bucketUs, sd.bucket_us || 0);
    for (const [field, c] of Object.entries(sd.channels || {})) {
      byChannel[`${series}:${field}`] = {
        t: sd.t,
        // When each bucket's `last` was recorded; absent on raw series.
        tLast: sd.t_last,
        mode: sd.mode,
        bucketUs: sd.bucket_us,
        v: c.v,
        lo: c.lo,
        hi: c.hi,
        first: c.first,
        last: c.last,
      };
    }
  }

  return {
    from: range.from,
    to: range.to,
    u0: range.u0,
    u1: range.u1,
    rows,
    anyRaw,
    bucketUs,
    points: body.points || 0,
    capped: !!body.capped,
    byChannel,
  };
}
