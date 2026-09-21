import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth } from './auth';
import { rateLimit } from './rate-limit';
import { SessionStore, ValidationError, parseSessionInput, summarize } from './session';
import { extractTwbXml, parseTableauColumns } from './tableau';
import { generateTml, generateWorksheetOnTable } from './tml';
import { importTml, findGuid, ensureUser, findMetadataId } from './thoughtspot';
import { rowsToCsv } from './csv';
import { uploadCsvDataset, deleteTable } from './userdata';

export interface AppOptions {
  apiKey: string;
  store?: SessionStore;
  maxBodyBytes?: number;
  rateLimitPerMinute?: number;
  now?: () => number;
  /** Optional: when set, /worksheet also imports the worksheet into ThoughtSpot. */
  tsHost?: string;
  /** The tsadmin token — server-only secret; never sent to or held by clients. */
  tsToken?: string;
  /** Optional namespace prepended to provisioned usernames (e.g. "tableau_"). */
  tsUserPrefix?: string;
  /** Account type for provisioned users; default LOCAL_USER. */
  tsAccountType?: string;
  /** Domain for synthesized provisioned-user emails (default spotter.local). */
  tsEmailDomain?: string;
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

  // Idempotently provision a ThoughtSpot user for a platform identity, using
  // the server-held tsadmin token. The client never sees a TS token. Body:
  // JSON { userid, platform, email? }. Returns the (existing or created) user.
  app.post('/provision', async (c) => {
    if (!options.tsHost || !options.tsToken) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to provision users' }, 503);
    }
    let body: Record<string, string>;
    try {
      body = (await c.req.json()) as Record<string, string>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userid = (body.userid ?? '').trim();
    const platform = (body.platform ?? '').trim();
    if (!userid || !platform) return c.json({ error: 'invalid_request', detail: 'userid and platform are required' }, 400);

    const user = await ensureUser(
      { host: options.tsHost, token: options.tsToken },
      {
        userid, platform, prefix: options.tsUserPrefix, accountType: options.tsAccountType,
        emailDomain: options.tsEmailDomain, email: body.email,
      },
    );
    return c.json({ userid, platform, user }, user.created ? 201 : 200);
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

    let user;
    let worksheetId: string | undefined;
    let searchUrl: string | undefined;
    if (options.tsHost && options.tsToken) {
      const tsEnv = { host: options.tsHost, token: options.tsToken };
      // Provision the user first, then import the worksheet (both as tsadmin).
      user = await ensureUser(tsEnv, {
        userid, platform, prefix: options.tsUserPrefix, accountType: options.tsAccountType,
        emailDomain: options.tsEmailDomain,
      });
      const result = await importTml(tsEnv, [tml.tableTml, tml.worksheetTml]);
      worksheetId = findGuid(result, name);
      if (worksheetId) searchUrl = `${options.tsHost.replace(/\/$/, '')}/#/data/tables/${worksheetId}`;
    }

    return c.json({
      userid,
      platform,
      user,
      worksheet: { name, columns },
      worksheetId,
      searchUrl,
      imported: Boolean(worksheetId),
      tml,
    }, 201);
  });

  // Load real data ROWS into Falcon so Spotter can answer, then wrap the
  // uploaded table in a worksheet. Body (JSON): { userid, platform, name?, and
  // one of: data:{columns,rows} | csv | csvBase64 } — or multipart with a CSV
  // `file`. Returns the table + worksheet ids and ready-to-use embed sources.
  app.post('/dataset', bodyLimit({ maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }), async (c) => {
    if (!options.tsHost || !options.tsToken) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to load data' }, 503);
    }
    const tsEnv = { host: options.tsHost, token: options.tsToken };
    const ct = c.req.header('content-type') ?? '';
    let userid = '';
    let platform = '';
    let name = '';
    let csv = '';

    if (ct.includes('multipart/form-data')) {
      const f = await c.req.formData();
      userid = String(f.get('userid') ?? '');
      platform = String(f.get('platform') ?? '');
      name = String(f.get('name') ?? '');
      const file = f.get('file');
      if (file && typeof file !== 'string') {
        csv = await file.text();
        if (!name) name = file.name.replace(/\.csv$/i, '');
      }
    } else {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      userid = String(b.userid ?? '').trim();
      platform = String(b.platform ?? '').trim();
      name = String(b.name ?? '').trim();
      if (typeof b.csvBase64 === 'string') {
        csv = new TextDecoder().decode(Uint8Array.from(atob(b.csvBase64), (ch) => ch.charCodeAt(0)));
      } else if (typeof b.csv === 'string') {
        csv = b.csv;
      } else {
        const data = b.data as { columns?: { name: string }[]; rows?: unknown[][] } | undefined;
        if (data && Array.isArray(data.columns) && Array.isArray(data.rows)) {
          csv = rowsToCsv(data.columns, data.rows);
        }
      }
    }

    if (!userid || !platform) return c.json({ error: 'invalid_request', detail: 'userid and platform are required' }, 400);
    if (!csv.trim()) {
      return c.json({ error: 'invalid_request', detail: 'no data: send data.{columns,rows}, csv, csvBase64, or a CSV file' }, 400);
    }

    const user = await ensureUser(tsEnv, {
      userid, platform, prefix: options.tsUserPrefix, accountType: options.tsAccountType,
      emailDomain: options.tsEmailDomain,
    });

    const baseName = `${userid} ${platform} ${name || 'data'}`.replace(/\s+/g, ' ').trim().slice(0, 78);
    const tableName = `${baseName} Table`.slice(0, 90);

    const dataset = await uploadCsvDataset(tsEnv, csv, tableName);
    const tableId = dataset.tableId ?? (await findMetadataId(tsEnv, tableName));

    // Best-effort: wrap the loaded table in a worksheet so Spotter has a model.
    let worksheetId: string | undefined;
    let worksheetError: string | undefined;
    const worksheetName = baseName;
    if (dataset.loaded && dataset.columns.length && tableId) {
      try {
        const wsTml = generateWorksheetOnTable(worksheetName, tableName, dataset.columns);
        const imp = await importTml(tsEnv, [wsTml]);
        worksheetId = findGuid(imp, worksheetName) ?? (await findMetadataId(tsEnv, worksheetName, 'LOGICAL_TABLE'));
        if (!worksheetId) worksheetError = `import returned no guid: ${JSON.stringify(imp).slice(0, 400)}`;
      } catch (e) {
        worksheetError = (e as Error).message;
        console.error('worksheet wrap failed:', worksheetError);
      }
    }

    const dataSources = worksheetId ? [worksheetId] : tableId ? [tableId] : [];
    const searchUrl = tableId ? `${options.tsHost.replace(/\/$/, '')}/#/data/tables/${tableId}` : undefined;

    return c.json({
      userid,
      platform,
      user,
      dataset: {
        tableId,
        tableName,
        worksheetId,
        worksheetName: worksheetId ? worksheetName : undefined,
        worksheetError,
        columns: dataset.columns,
        loaded: dataset.loaded,
        loadMessages: dataset.errors,
      },
      embed: { dataSources, worksheetId },
      dataSources,
      searchUrl,
    }, dataset.loaded ? 201 : 502);
  });

  // Delete an uploaded dataset (Falcon table) by GUID — the "delete the
  // spreadsheet" action. The worksheet on top, if any, is removed with it.
  app.delete('/dataset/:tableId', async (c) => {
    if (!options.tsHost || !options.tsToken) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set' }, 503);
    }
    const tableId = c.req.param('tableId');
    if (!/^[0-9a-f-]{16,}$/i.test(tableId)) return c.json({ error: 'invalid_request', detail: 'bad tableId' }, 400);
    await deleteTable({ host: options.tsHost, token: options.tsToken }, tableId);
    return c.body(null, 204);
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
