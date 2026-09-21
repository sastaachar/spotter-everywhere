import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth } from './auth';
import { rateLimit } from './rate-limit';
import { SessionStore, ValidationError, parseSessionInput, summarize } from './session';
import { extractTwbXml, parseTableauColumns } from './tableau';
import { generateTml } from './tml';
import { importTml, findGuid } from './thoughtspot';

export interface AppOptions {
  apiKey: string;
  store?: SessionStore;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  /** Optional: when set, /worksheet also imports the worksheet into ThoughtSpot. */
  tsHost?: string;
  tsToken?: string;
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

  // Turn an uploaded Tableau workbook into a Spotter-searchable worksheet.
  // Body: multipart/form-data { userid, platform, file } — or JSON
  // { userid, platform, filename, fileBase64 }. Returns the worksheet the
  // extension can point Spotter at (imported GUID + searchUrl when TS is
  // configured, otherwise the generated schema + TML to import).
  app.post('/worksheet', bodyLimit({ maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }), async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let userid = '';
    let platform = '';
    let filename = '';
    let bytes: Uint8Array | null = null;

    if (ct.includes('multipart/form-data')) {
      const form = await c.req.formData();
      userid = String(form.get('userid') ?? '');
      platform = String(form.get('platform') ?? '');
      const file = form.get('file');
      if (file && typeof file !== 'string') {
        bytes = new Uint8Array(await file.arrayBuffer());
        filename = file.name;
      }
    } else if (ct.includes('application/json')) {
      const b = await c.req.json().catch(() => ({})) as Record<string, string>;
      userid = b.userid ?? '';
      platform = b.platform ?? '';
      filename = b.filename ?? '';
      if (b.fileBase64) bytes = Uint8Array.from(atob(b.fileBase64), (ch) => ch.charCodeAt(0));
    }

    if (!userid || !platform) return c.json({ error: 'invalid_request', detail: 'userid and platform are required' }, 400);
    if (!bytes || bytes.length === 0) return c.json({ error: 'invalid_request', detail: 'no .twb/.twbx file provided' }, 400);

    let columns;
    try {
      columns = parseTableauColumns(extractTwbXml(bytes));
    } catch (e) {
      return c.json({ error: 'parse_failed', detail: (e as Error).message }, 422);
    }
    if (!columns.length) return c.json({ error: 'no_columns', detail: 'no fields found in the workbook' }, 422);

    const name = `${userid} · ${platform} · ${(filename || 'workbook').replace(/\.(twbx?|tdsx?)$/i, '')}`.slice(0, 80);
    const tml = generateTml(name, columns);

    let worksheetId: string | undefined;
    let searchUrl: string | undefined;
    if (options.tsHost && options.tsToken) {
      const result = await importTml({ host: options.tsHost, token: options.tsToken }, [tml.tableTml, tml.worksheetTml]);
      worksheetId = findGuid(result, name);
      if (worksheetId) searchUrl = `${options.tsHost.replace(/\/$/, '')}/#/data/tables/${worksheetId}`;
    }

    return c.json({
      userid,
      platform,
      worksheet: { name, columns },
      worksheetId,
      searchUrl,
      imported: Boolean(worksheetId),
      tml,
    }, 201);
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

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: 'invalid_request', detail: err.message }, 400);
    if ('status' in err && err.status === 413) return c.json({ error: 'payload_too_large' }, 413);
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
