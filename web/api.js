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

export function getCoverage(bucketMs, signal) {
  return getJson(`/api/coverage?bucket_ms=${Math.round(bucketMs)}`, signal);
}

/**
 * Loads one viewport.
 *
 * `ranges` come from the time axis and are already gap-free. Buckets are shared
 * out by how much screen each range occupies, so pixel density stays even
 * across a window that spans several bursts.
 */
export async function loadWindow({ ranges, channels, totalBuckets, maxRaw = 12000, maxPoints, signal }) {
  if (!ranges.length || !channels.length) return [];

  const uSpan = ranges.reduce((acc, r) => acc + (r.u1 - r.u0), 0) || 1;
  const chanParam = channels.join(',');
  // Budgets cover the viewport, not each request: a window straddling several
  // bursts issues several queries, and they share one allowance rather than
  // each claiming the whole thing.
  const rawShare = Math.max(500, Math.floor(maxRaw / ranges.length));

  const requests = ranges.map(async (r) => {
    const share = (r.u1 - r.u0) / uSpan;
    const buckets = Math.max(8, Math.round(totalBuckets * share));
    const url =
      `/api/data?from=${r.from}&to=${r.to}&buckets=${buckets}` +
      `&max_raw=${rawShare}&max_points=${Math.round(maxPoints / ranges.length)}` +
      `&channels=${encodeURIComponent(chanParam)}`;
    const body = await getJson(url, signal);
    return flatten(r, body);
  });

  return Promise.all(requests);
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
