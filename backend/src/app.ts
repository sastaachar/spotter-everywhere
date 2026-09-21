import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth } from './auth';
import { rateLimit } from './rate-limit';
import { SessionStore, ValidationError, parseSessionInput, summarize } from './session';
import { ThoughtSpotAuthError, mintToken, type ThoughtSpotCredentials } from './thoughtspot';

export interface AppOptions {
  apiKey: string;
  store?: SessionStore;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  thoughtSpot?: ThoughtSpotCredentials;
  fetchImpl?: typeof fetch;
}

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const ONE_MINUTE_MS = 60_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createApp(options: AppOptions) {
  const store = options.store ?? new SessionStore();
  const app = new Hono();

  app.use(secureHeaders());
  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use(rateLimit({ windowMs: ONE_MINUTE_MS, max: options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE, now: options.now }));
  app.use(bearerAuth(options.apiKey));

  app.post('/session', bodyLimit({ maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const input = parseSessionInput(body);
    const session = store.create(input);
    return c.json(summarize(session), 201, { Location: `/session/${session.id}` });
  });

  app.get('/session/:id', (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_PATTERN.test(id)) return c.json({ error: 'not_found' }, 404);
    const session = store.get(id);
    if (!session) return c.json({ error: 'not_found' }, 404);
    return c.json(session);
  });

  app.delete('/session/:id', (c) => {
    const id = c.req.param('id');
    if (!SESSION_ID_PATTERN.test(id) || !store.delete(id)) return c.json({ error: 'not_found' }, 404);
    return c.body(null, 204);
  });

  app.get('/token', async (c) => {
    if (!options.thoughtSpot) return c.json({ error: 'thoughtspot_not_configured' }, 503);
    const token = await mintToken(options.thoughtSpot, options.fetchImpl);
    return c.json({ token: token.token, expiresAt: token.expiresAt, host: options.thoughtSpot.host });
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: 'invalid_request', detail: err.message }, 400);
    if (err instanceof ThoughtSpotAuthError) {
      console.error('thoughtspot token error:', err.message);
      return c.json({ error: 'thoughtspot_auth_failed' }, 502);
    }
    if ('status' in err && err.status === 413) return c.json({ error: 'payload_too_large' }, 413);
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
