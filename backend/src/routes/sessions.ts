import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { parseSessionInput, summarize } from '../session';
import type { Deps } from '../deps';

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Ephemeral capture of a platform view's data + context, for debug/inspection.
export function registerSessionRoutes(app: Hono, deps: Deps): void {
  const { store, maxBody } = deps;

  app.post('/session', bodyLimit({ maxSize: maxBody }), async (c) => {
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
}
