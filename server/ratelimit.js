// Tiny in-memory rate limiter — no dependency (keeps server/ dependency-free).
// Fixed-window per (bucket name + client IP). Intended for auth endpoints to blunt
// password / code brute-forcing. State is per-process; behind a single API process
// that's fine. Returns 429 with Retry-After when the window is exceeded.
/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip || req.socket?.remoteAddress || 'unknown';
}

/** @param {{ windowMs?: number, max?: number, name?: string }} [opts] */
export function rateLimit({ windowMs = 60_000, max = 10, name = 'rl' } = {}) {
  return (/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) => {
    const key = `${name}:${clientIp(req)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'too many attempts — please wait a moment and try again' });
    }
    next();
  };
}

// Drop expired buckets periodically so the map can't grow unbounded.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000);
sweep.unref?.();
