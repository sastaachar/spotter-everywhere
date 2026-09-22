import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth } from './auth';
import { rateLimit } from './rate-limit';
import { ValidationError } from './session';
import { makeDeps, DEFAULT_RATE_LIMIT_PER_MINUTE, type AppOptions } from './deps';
import { registerSessionRoutes } from './routes/sessions';
import { registerProvisioningRoutes } from './routes/provisioning';
import { registerLiveboardRoutes } from './routes/liveboards';
import { registerDatasetRoutes } from './routes/datasets';

export type { AppOptions } from './deps';
export { DEFAULT_MAX_BODY_BYTES, DEFAULT_RATE_LIMIT_PER_MINUTE } from './deps';

const ONE_MINUTE_MS = 60_000;

// Reflect only allowed origins (never a literal "*"): the configured list, or
// Tableau Cloud + localhost by default. Returns the origin to allow, or null.
function makeOriginCheck(allowed?: string[]) {
  return (origin: string): string | null => {
    if (!origin) return origin;
    if (allowed && allowed.length) return allowed.includes(origin) ? origin : null;
    if (/^https:\/\/[a-z0-9-]+\.online\.tableau\.com$/i.test(origin)) return origin;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin;
    return null;
  };
}

export function createApp(options: AppOptions) {
  const app = new Hono();
  const deps = makeDeps(options);

  app.use(logger()); // per-request access log: method, path, status, timing
  app.use(secureHeaders());
  // CORS before auth/rate-limit so the browser's preflight (OPTIONS, no auth
  // header) is answered directly instead of 401/429'd.
  app.use(cors({
    origin: makeOriginCheck(options.allowedOrigins),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }));
  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use(rateLimit({ windowMs: ONE_MINUTE_MS, max: options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE, now: options.now }));
  app.use(bearerAuth(options.apiKey));

  registerSessionRoutes(app, deps);
  registerProvisioningRoutes(app, deps);
  registerLiveboardRoutes(app, deps);
  registerDatasetRoutes(app, deps);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: 'invalid_request', detail: err.message }, 400);
    if ('status' in err && err.status === 413) return c.json({ error: 'payload_too_large' }, 413);
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
