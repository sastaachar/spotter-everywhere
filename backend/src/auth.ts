import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const BEARER_PREFIX = 'Bearer ';

export function keysMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerAuth(expectedKey: string): MiddlewareHandler {
  if (expectedKey.length === 0) throw new Error('bearerAuth requires a non-empty key');
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const presented = header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : '';
    if (!keysMatch(presented, expectedKey)) {
      return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
    }
    await next();
  };
}
