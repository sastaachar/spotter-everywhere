import type { MiddlewareHandler } from 'hono';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  now?: () => number;
  keyFor?: (headers: Headers) => string;
}

interface Window {
  start: number;
  count: number;
}

function clientKey(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'anonymous';
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const keyFor = options.keyFor ?? clientKey;
  const windows = new Map<string, Window>();

  return async (c, next) => {
    const t = now();
    const key = keyFor(c.req.raw.headers);
    let w = windows.get(key);
    if (!w || t - w.start >= options.windowMs) {
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    w.count += 1;
    const remaining = Math.max(options.max - w.count, 0);
    c.header('RateLimit-Limit', String(options.max));
    c.header('RateLimit-Remaining', String(remaining));
    if (w.count > options.max) {
      const retryAfter = Math.ceil((w.start + options.windowMs - t) / 1000);
      return c.json({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) });
    }
    if (windows.size > 10_000) {
      for (const [k, v] of windows) if (t - v.start >= options.windowMs) windows.delete(k);
    }
    await next();
  };
}
