import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { bearerAuth } from './auth';
import { rateLimit } from './rate-limit';
import { SessionStore, ValidationError, parseSessionInput, summarize } from './session';
import { extractTwbXml, parseTableauColumns, type Column } from './tableau';
import { parseTmdlColumns } from './powerbi';
import { generateTml, generateWorksheetOnTable, generateLiveboardTml } from './tml';
import { importTml, findGuid, importErrors, ensureUser, findMetadataId, mintUserToken, sanitizeUsername, shareMetadata, addUserToGroups } from './thoughtspot';
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
  /** Trusted-auth secret key — mints embed tokens AS the provisioned user, and
   *  (when tsToken is unset) the admin token too, so no static token is needed. */
  tsSecretKey?: string;
  /** Admin user the secret key mints the admin token as. Default "tsadmin". */
  tsAdminUser?: string;
  /** Groups (GUIDs/names) provisioned users join — carry the Spotter/search
   *  privileges. Without a privileged group, the user gets "no permission". */
  tsUserGroups?: string[];
  /** Exact origins allowed via CORS (the extension calls cross-origin). When
   *  unset, Tableau Cloud (*.online.tableau.com) and localhost are allowed. */
  allowedOrigins?: string[];
}

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

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const ONE_MINUTE_MS = 60_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Deterministic liveboard name from (platform, guid) alone, so /get-liveboard
// and /create-liveboard agree on the reuse key without sharing any other state.
const liveboardKey = (platform: string, guid: string): string =>
  `Spotter · ${platform} · ${guid}`.slice(0, 80);

export function createApp(options: AppOptions) {
  const store = options.store ?? new SessionStore();
  const app = new Hono();

  // Admin REST calls need an admin bearer. Prefer a static tsToken if given,
  // else mint one AS the admin user from the trusted-auth secret key and cache
  // it until just before expiry — so no static, expiring token is required.
  const adminUser = options.tsAdminUser ?? 'tsadmin';
  const canAdmin = () => Boolean(options.tsHost && (options.tsToken || options.tsSecretKey));
  let adminCache = { token: '', exp: 0 };
  async function adminEnv() {
    if (!options.tsHost) return null;
    if (options.tsToken) {
      console.log('[admin] using static TS_TOKEN (set TS_TOKEN empty to mint from the secret key instead)');
      return { host: options.tsHost, token: options.tsToken };
    }
    if (!options.tsSecretKey) return null;
    if (!adminCache.token || Date.now() >= adminCache.exp) {
      const validitySec = 3600;
      console.log(`[admin] minting admin token as "${adminUser}" from the secret key against ${options.tsHost}`);
      const token = await mintUserToken(options.tsHost, adminUser, options.tsSecretKey, { validitySec });
      adminCache = { token, exp: Date.now() + (validitySec - 120) * 1000 };
      console.log(`[admin] minted admin token (${token.slice(0, 6)}…, ${token.length} chars)`);
    }
    return { host: options.tsHost, token: adminCache.token };
  }

  // Load rows into a real Falcon table (same CSV pipeline as /dataset) and wrap
  // a worksheet on it, so a liveboard built on top has actual data. Idempotent:
  // reuses an existing worksheet of the same name. Returns the worksheet name.
  async function loadDataset(env: { host: string; token: string }, wsName: string, columns: { name: string }[], rows: unknown[][]) {
    const tableName = `${wsName} Table`.slice(0, 90);
    const dataset = await uploadCsvDataset(env, rowsToCsv(columns, rows), tableName);
    const tableId = dataset.tableId ?? (await findMetadataId(env, tableName));
    let worksheetId = await findMetadataId(env, wsName, 'LOGICAL_TABLE');
    if (!worksheetId && dataset.loaded && dataset.columns.length && tableId) {
      const imp = await importTml(env, [generateWorksheetOnTable(wsName, tableName, dataset.columns)]);
      worksheetId = findGuid(imp, wsName) ?? (await findMetadataId(env, wsName, 'LOGICAL_TABLE'));
    }
    const groups = options.tsUserGroups ?? [];
    const ids = [worksheetId, tableId].filter((x): x is string => Boolean(x));
    if (ids.length && groups.length) {
      try {
        await shareMetadata(env, ids, groups.map((g) => ({ identifier: g, type: 'USER_GROUP' as const })), 'READ_ONLY');
      } catch (e) {
        console.error('[loadDataset] share failed:', (e as Error).message);
      }
    }
    return { tableId, worksheetId, worksheetName: wsName, loaded: dataset.loaded, messages: dataset.errors };
  }

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
    if (!canAdmin()) {
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

    const env = (await adminEnv())!;
    const user = await ensureUser(
      env,
      {
        userid, platform, prefix: options.tsUserPrefix, accountType: options.tsAccountType,
        emailDomain: options.tsEmailDomain, email: body.email, groups: options.tsUserGroups,
      },
    );
    return c.json({ userid, platform, user }, user.created ? 201 : 200);
  });

  // Mint a cookieless login token FOR the provisioned user (not the admin), so
  // the embed runs as them. Uses the trusted-auth secret key held server-side.
  // Body: JSON { userid, platform }. 503 if no secret key is configured (the
  // extension then falls back to the admin embed).
  app.post('/embed-token', async (c) => {
    if (!options.tsHost) return c.json({ error: 'not_configured', detail: 'TS_HOST not set' }, 503);
    if (!options.tsSecretKey) {
      return c.json({ error: 'not_configured', detail: 'TS_SECRET_KEY not set — enable trusted auth and set its secret key' }, 503);
    }
    let body: Record<string, string>;
    try {
      body = (await c.req.json()) as Record<string, string>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userid = (body.userid ?? '').trim();
    const platform = (body.platform ?? 'tableau').trim();
    if (!userid) return c.json({ error: 'invalid_request', detail: 'userid is required' }, 400);
    const username = sanitizeUsername(`${options.tsUserPrefix ?? ''}${userid}`);
    const email = `${username}@${options.tsEmailDomain ?? 'thoughtspot.com'}`;
    try {
      // JIT: create the user (if absent) with the privileged groups AND mint the
      // token, in one call — provisioning happens at embed time.
      const token = await mintUserToken(options.tsHost, username, options.tsSecretKey, {
        autoCreate: true,
        groups: options.tsUserGroups,
        email,
        displayName: `${userid} (${platform})`,
      });
      // auto_create only assigns groups to NEW users; ensure membership for
      // existing users too (idempotent ADD) so they keep the Spotter privilege.
      if (options.tsUserGroups?.length) {
        try {
          const env = await adminEnv();
          if (env) await addUserToGroups(env, username, options.tsUserGroups);
        } catch (e) {
          console.error(`ensure groups for ${username} failed:`, (e as Error).message);
        }
      }
      return c.json({ token, username, host: options.tsHost });
    } catch (e) {
      return c.json({ error: 'token_failed', detail: (e as Error).message }, 502);
    }
  });

  // Turn an uploaded Tableau workbook into a Spotter-searchable worksheet.
  // Body: multipart/form-data { userid, platform, file } — or JSON
  // { userid, platform, filename, fileBase64 }. Returns the worksheet the
  // extension can point Spotter at (imported GUID + searchUrl when TS is
  // configured, otherwise the generated schema + TML to import).
  // Convert a Tableau .twb/.twbx to ThoughtSpot TML and return it — no cluster
  // needed, no import, no user provisioned. Body: multipart with a `file`, or
  // JSON { filename?, fileBase64 }. Returns the table + worksheet TML text.
  app.post('/twb-to-tml', bodyLimit({ maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }), async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let filename = '';
    let bytes: Uint8Array | null = null;
    if (ct.includes('multipart/form-data')) {
      const form = await c.req.formData();
      const file = form.get('file');
      if (file && typeof file !== 'string') {
        bytes = new Uint8Array(await file.arrayBuffer());
        filename = file.name;
      }
    } else if (ct.includes('application/json')) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      filename = b.filename ?? '';
      if (b.fileBase64) bytes = Uint8Array.from(atob(b.fileBase64), (ch) => ch.charCodeAt(0));
    }
    if (!bytes || bytes.length === 0) {
      return c.json({ error: 'invalid_request', detail: 'no .twb/.twbx file provided' }, 400);
    }

    let columns;
    try {
      columns = parseTableauColumns(extractTwbXml(bytes));
    } catch (e) {
      return c.json({ error: 'parse_failed', detail: (e as Error).message }, 422);
    }
    if (!columns.length) return c.json({ error: 'no_columns', detail: 'no fields found in the workbook' }, 422);

    const name = (filename || 'workbook').replace(/\.(twbx?|tdsx?)$/i, '').slice(0, 80);
    const tml = generateTml(name, columns);

    if (c.req.query('format') === 'text') {
      return c.text(`${tml.tableTml}\n---\n${tml.worksheetTml}\n`, 200, { 'Content-Type': 'text/yaml; charset=utf-8' });
    }
    return c.json({ name, columns, tml }, 200);
  });

  // Turn a Tableau .twb/.twbx into a ThoughtSpot Liveboard: a table + worksheet
  // plus a liveboard (table viz + a column chart per measure). Returns the TML;
  // when TS_HOST/TS_TOKEN are set it also imports table -> worksheet -> liveboard
  // and returns the liveboard id. Body: multipart `file`, or JSON { filename?, fileBase64 }.
  // Build once, then reuse. `name` is the idempotency key (pass the workbook's
  // LUID or a "<workbook> <luid>" so two same-named workbooks don't collide).
  // Called with just { name } it looks up an existing liveboard and returns it
  // with no download; 404 not_built means "resend with the .twb to build it".
  app.post('/liveboard', bodyLimit({ maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }), async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let filename = '';
    let provided = '';
    let bytes: Uint8Array | null = null;
    if (ct.includes('multipart/form-data')) {
      const form = await c.req.formData();
      provided = String(form.get('name') ?? '');
      const file = form.get('file');
      if (file && typeof file !== 'string') {
        bytes = new Uint8Array(await file.arrayBuffer());
        filename = file.name;
      }
    } else if (ct.includes('application/json')) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      provided = b.name ?? '';
      filename = b.filename ?? '';
      if (b.fileBase64) bytes = Uint8Array.from(atob(b.fileBase64), (ch) => ch.charCodeAt(0));
    }

    const name = (provided || filename.replace(/\.(twbx?|tdsx?)$/i, '') || '').slice(0, 80);
    const wantText = c.req.query('format') === 'text';
    const tsEnv = await adminEnv();
    const pinboardUrl = (id: string) => `${options.tsHost!.replace(/\/$/, '')}/#/pinboard/${id}`;

    if (!name && !bytes) {
      return c.json({ error: 'invalid_request', detail: 'provide a name (to look up) or a .twb/.twbx file (to build)' }, 400);
    }

    // Reuse an already-built liveboard by name — no download, no rebuild.
    if (tsEnv && name && !wantText) {
      const existing = await findMetadataId(tsEnv, name, 'LIVEBOARD');
      if (existing) {
        return c.json({ name, liveboardId: existing, liveboardUrl: pinboardUrl(existing), imported: true, reused: true }, 200);
      }
      if (!bytes) {
        return c.json({ error: 'not_built', detail: `no liveboard named "${name}"; resend with the .twb to build it` }, 404);
      }
    }

    if (!bytes || bytes.length === 0) {
      return c.json({ error: 'invalid_request', detail: 'no .twb/.twbx file provided' }, 400);
    }

    let columns;
    try {
      columns = parseTableauColumns(extractTwbXml(bytes));
    } catch (e) {
      return c.json({ error: 'parse_failed', detail: (e as Error).message }, 422);
    }
    if (!columns.length) return c.json({ error: 'no_columns', detail: 'no fields found in the workbook' }, 422);

    const base = generateTml(name, columns);
    const liveboardTml = generateLiveboardTml(name, base.worksheetName, columns);
    const tml = { ...base, liveboardTml };

    if (wantText) {
      return c.text([tml.tableTml, tml.worksheetTml, liveboardTml].join('\n---\n') + '\n', 200, {
        'Content-Type': 'text/yaml; charset=utf-8',
      });
    }

    let liveboardId: string | undefined;
    let liveboardUrl: string | undefined;
    let imported = false;
    if (tsEnv) {
      const result = await importTml(tsEnv, [tml.tableTml, tml.worksheetTml, liveboardTml]);
      liveboardId = findGuid(result, name);
      if (liveboardId) {
        imported = true;
        liveboardUrl = pinboardUrl(liveboardId);
      }
    }

    return c.json({ name, columns, tml, liveboardId, liveboardUrl, imported, reused: false }, 201);
  });

  // Look up an already-built liveboard by (platform, guid). Cheap: no model,
  // no download, no import. Body/query: { platform, guid }. Returns
  // { exists, liveboardId?, liveboardUrl? }. 503 when no cluster is configured.
  app.post('/get-liveboard', async (c) => {
    let platform = '';
    let guid = '';
    if ((c.req.header('content-type') ?? '').includes('application/json')) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      platform = b.platform ?? '';
      guid = b.guid ?? '';
    }
    platform = (platform || c.req.query('platform') || '').toLowerCase();
    guid = guid || c.req.query('guid') || '';
    if (!platform || !guid) {
      return c.json({ error: 'invalid_request', detail: 'platform and guid are required' }, 400);
    }
    if (!canAdmin()) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to look up liveboards' }, 503);
    }
    const name = liveboardKey(platform, guid);
    let id;
    try {
      id = await findMetadataId((await adminEnv())!, name, 'LIVEBOARD');
    } catch (e) {
      return c.json({ error: 'cluster_error', detail: (e as Error).message }, 502);
    }
    return c.json({
      platform, guid, name, exists: Boolean(id),
      liveboardId: id,
      liveboardUrl: id ? `${options.tsHost!.replace(/\/$/, '')}/#/pinboard/${id}` : undefined,
    }, 200);
  });

  // Platform-generic liveboard creation with per-stage status. Each source
  // platform declares its modeling language and how to read columns from it.
  const CONVERTERS: Record<string, { modeling: string; binary: boolean; parse: (data: Uint8Array | string) => Column[] }> = {
    tableau: { modeling: 'twb', binary: true, parse: (d) => parseTableauColumns(extractTwbXml(d as Uint8Array)) },
    powerbi: { modeling: 'tmdl', binary: false, parse: (d) => parseTmdlColumns(String(d)) },
  };

  // Build (or reuse) a liveboard from a platform's model, reporting each stage:
  // lookup -> parse -> generate -> import -> locate. Body: multipart { platform,
  // name, file } or JSON { platform, name, fileBase64 | model }. `name` is the
  // reuse key. Returns { reused, liveboardId, stages: [{stage,status,detail}] }.
  app.post('/create-liveboard', bodyLimit({ maxSize: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES }), async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let platform = '';
    let name = '';
    let guid = '';
    let filename = '';
    let bytes: Uint8Array | null = null;
    let text = '';
    let dataInput: { columns: { name: string; type?: string; dataType?: string }[]; rows: unknown[][] } | null = null;
    if (ct.includes('multipart/form-data')) {
      const form = await c.req.formData();
      platform = String(form.get('platform') ?? '');
      name = String(form.get('name') ?? '');
      guid = String(form.get('guid') ?? '');
      const model = form.get('model');
      if (typeof model === 'string') text = model;
      const file = form.get('file');
      if (file && typeof file !== 'string') {
        bytes = new Uint8Array(await file.arrayBuffer());
        filename = file.name;
      }
    } else if (ct.includes('application/json')) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      platform = String(b.platform ?? '');
      name = String(b.name ?? '');
      guid = String(b.guid ?? '');
      filename = String(b.filename ?? '');
      text = String(b.model ?? '');
      if (typeof b.fileBase64 === 'string') bytes = Uint8Array.from(atob(b.fileBase64), (ch) => ch.charCodeAt(0));
      const d = b.data as { columns?: { name: string; type?: string; dataType?: string }[]; rows?: unknown[][] } | undefined;
      if (d && Array.isArray(d.columns) && Array.isArray(d.rows)) dataInput = { columns: d.columns, rows: d.rows };
    }

    platform = platform.toLowerCase();
    // When a guid is given, key on it (matches /get-liveboard); else fall back
    // to an explicit name or the filename.
    name = guid ? liveboardKey(platform, guid) : (name || filename.replace(/\.(twbx?|tdsx?|tmdl|zip)$/i, '') || '').slice(0, 80);
    const conv = CONVERTERS[platform];
    if (!conv) {
      return c.json({ error: 'unsupported_platform', detail: `platform must be one of: ${Object.keys(CONVERTERS).join(', ')}` }, 400);
    }
    if (!name) return c.json({ error: 'invalid_request', detail: 'name is required (used as the reuse key)' }, 400);

    const tsEnv = await adminEnv();
    const pinboardUrl = (id: string) => `${options.tsHost!.replace(/\/$/, '')}/#/pinboard/${id}`;
    const stages: { stage: string; status: 'ok' | 'skipped' | 'failed'; detail?: string }[] = [];
    const stage = (s: string, status: 'ok' | 'skipped' | 'failed', detail?: string) => {
      stages.push(detail ? { stage: s, status, detail } : { stage: s, status });
    };

    // 1. lookup — reuse an existing liveboard by name.
    if (tsEnv) {
      let existing;
      try {
        existing = await findMetadataId(tsEnv, name, 'LIVEBOARD');
      } catch (e) {
        stage('lookup', 'failed', (e as Error).message);
        return c.json({ platform, name, reused: false, error: 'cluster_error', stages }, 502);
      }
      if (existing) {
        stage('lookup', 'ok', 'found existing');
        for (const s of ['parse', 'generate', 'import', 'locate']) stage(s, 'skipped');
        return c.json({ platform, name, reused: true, liveboardId: existing, liveboardUrl: pinboardUrl(existing), stages }, 200);
      }
      stage('lookup', 'ok', 'not found');
    } else {
      stage('lookup', 'skipped', 'no cluster configured');
    }

    // 2. parse/collect columns — from posted data (preferred: has rows) or the model.
    let columns: Column[];
    let rows: unknown[][] | null = null;
    if (dataInput) {
      columns = dataInput.columns
        .filter((c) => c && c.name)
        .map((c, i) => ({
          id: c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col_${i}`,
          name: c.name,
          type: c.type === 'MEASURE' ? 'MEASURE' : 'ATTRIBUTE',
          dataType: (c.dataType as Column['dataType']) || 'VARCHAR',
        }));
      rows = dataInput.rows;
      if (!columns.length) {
        stage('parse', 'failed', 'data.columns was empty');
        return c.json({ platform, name, reused: false, stages }, 422);
      }
      stage('parse', 'ok', `${columns.length} columns, ${rows.length} rows (from data)`);
    } else {
      const model: Uint8Array | string | null = conv.binary ? bytes : text || (bytes ? new TextDecoder().decode(bytes) : '');
      if (!model || (conv.binary ? (model as Uint8Array).length === 0 : String(model).length === 0)) {
        stage('parse', 'failed', `no ${conv.modeling} model or data provided for ${platform}`);
        return c.json({ platform, name, reused: false, stages }, 400);
      }
      try {
        columns = conv.parse(model);
      } catch (e) {
        stage('parse', 'failed', (e as Error).message);
        return c.json({ platform, name, reused: false, stages }, 422);
      }
      if (!columns.length) {
        stage('parse', 'failed', 'no fields found in the model');
        return c.json({ platform, name, reused: false, stages }, 422);
      }
      stage('parse', 'ok', `${columns.length} columns (schema only, no data)`);
    }

    let liveboardId: string | undefined;

    // Data path: load real rows via the CSV pipeline, then build the liveboard
    // on that populated worksheet.
    if (rows && tsEnv) {
      let ws;
      try {
        ws = await loadDataset(tsEnv, name + ' Data', columns, rows);
        stage('load-data', ws.loaded ? 'ok' : 'failed', ws.worksheetId ? `worksheet ${ws.worksheetId}` : (ws.messages || []).join('; '));
      } catch (e) {
        stage('load-data', 'failed', (e as Error).message);
        return c.json({ platform, name, reused: false, error: 'data_load_failed', detail: (e as Error).message, stages }, 502);
      }
      if (!ws.worksheetId) {
        return c.json({ platform, name, reused: false, error: 'data_load_failed', detail: 'no worksheet after load', stages }, 502);
      }
      const liveboardTml = generateLiveboardTml(name, ws.worksheetName, columns);
      stage('generate', 'ok');
      try {
        const result = await importTml(tsEnv, [liveboardTml]);
        liveboardId = findGuid(result, name);
        if (!liveboardId) {
          const detail = importErrors(result).join(' | ') || 'no liveboard GUID in the import response';
          console.error('[create-liveboard] liveboard import produced no GUID:', detail);
          stage('import', 'failed', detail);
          return c.json({ platform, name, reused: false, error: 'import_failed', detail, stages }, 502);
        }
        stage('import', 'ok');
        stage('locate', 'ok');
      } catch (e) {
        stage('import', 'failed', (e as Error).message);
        return c.json({ platform, name, reused: false, error: 'cluster_error', detail: (e as Error).message, stages }, 502);
      }
      return c.json({ platform, name, reused: false, worksheetId: ws.worksheetId, liveboardId, liveboardUrl: pinboardUrl(liveboardId), stages }, 201);
    }

    // 3. generate — schema-only TML (no data).
    const base = generateTml(name, columns);
    const liveboardTml = generateLiveboardTml(name, base.worksheetName, columns);
    const tml = { ...base, liveboardTml };
    stage('generate', 'ok');

    // 4/5. import + locate.
    if (tsEnv) {
      try {
        const result = await importTml(tsEnv, [tml.tableTml, tml.worksheetTml, liveboardTml]);
        const errors = importErrors(result);
        liveboardId = findGuid(result, name);
        if (liveboardId) {
          stage('import', 'ok');
          stage('locate', 'ok');
        } else {
          // ALL_OR_NONE: any TML that fails validation aborts the whole import.
          const detail = errors.length ? errors.join(' | ') : 'no GUID and no error in the import response';
          console.error('[create-liveboard] import produced no liveboard:', detail);
          stage('import', 'failed', detail);
          stage('locate', 'failed');
          return c.json({ platform, name, reused: false, error: 'import_failed', detail, columns, tml, stages }, 502);
        }
      } catch (e) {
        stage('import', 'failed', (e as Error).message);
        return c.json({ platform, name, reused: false, error: 'cluster_error', detail: (e as Error).message, columns, tml, stages }, 502);
      }
    } else {
      stage('import', 'skipped', 'no cluster configured');
      stage('locate', 'skipped');
    }

    return c.json({
      platform, name, reused: false, columns, tml,
      liveboardId,
      liveboardUrl: liveboardId ? pinboardUrl(liveboardId) : undefined,
      stages,
    }, liveboardId ? 201 : 200);
  });

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
    if (canAdmin()) {
      const tsEnv = (await adminEnv())!;
      // Provision the user first, then import the worksheet (both as tsadmin).
      user = await ensureUser(tsEnv, {
        userid, platform, prefix: options.tsUserPrefix, accountType: options.tsAccountType,
        emailDomain: options.tsEmailDomain, groups: options.tsUserGroups,
      });
      const result = await importTml(tsEnv, [tml.tableTml, tml.worksheetTml]);
      worksheetId = findGuid(result, name);
      if (worksheetId) searchUrl = `${options.tsHost!.replace(/\/$/, '')}/#/data/tables/${worksheetId}`;
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
    if (!canAdmin()) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to load data' }, 503);
    }
    const tsEnv = (await adminEnv())!;
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

    const baseName = `${userid} ${platform} ${name || 'data'}`.replace(/\s+/g, ' ').trim().slice(0, 78);
    const tableName = `${baseName} Table`.slice(0, 90);

    // Load the data. The USER isn't provisioned here — with JIT the user is
    // created (with groups) when their embed token is minted (POST /embed-token).
    // We just load + share with the group so any JIT member can search it.
    let dataset;
    let tableId: string | undefined;
    try {
      dataset = await uploadCsvDataset(tsEnv, csv, tableName);
      tableId = dataset.tableId ?? (await findMetadataId(tsEnv, tableName));
    } catch (e) {
      return c.json({ error: 'data_load_failed', detail: (e as Error).message }, 502);
    }

    // Best-effort: wrap the loaded table in a worksheet so Spotter has a model.
    let worksheetId: string | undefined;
    let worksheetError: string | undefined;
    const worksheetName = baseName;
    if (dataset.loaded && dataset.columns.length && tableId) {
      try {
        // Reuse the worksheet when it already exists. Importing the TML again
        // creates ANOTHER worksheet of the same name rather than replacing it,
        // and the extension could then be pointed at any one of them. The table
        // underneath was just reloaded in place, so the existing worksheet
        // already serves the rows we just extracted.
        worksheetId = await findMetadataId(tsEnv, worksheetName, 'LOGICAL_TABLE');
        if (!worksheetId) {
          const wsTml = generateWorksheetOnTable(worksheetName, tableName, dataset.columns);
          const imp = await importTml(tsEnv, [wsTml]);
          worksheetId = findGuid(imp, worksheetName) ?? (await findMetadataId(tsEnv, worksheetName, 'LOGICAL_TABLE'));
          if (!worksheetId) worksheetError = `import returned no guid: ${JSON.stringify(imp).slice(0, 400)}`;
        }
      } catch (e) {
        worksheetError = (e as Error).message;
        console.error('worksheet wrap failed:', worksheetError);
      }
    }

    // Share the worksheet + table with the privileged group so every JIT member
    // can search it (tsadmin owns the imported objects). Best-effort.
    let shareError: string | undefined;
    const groups = options.tsUserGroups ?? [];
    const ids = [worksheetId, tableId].filter((x): x is string => Boolean(x));
    if (ids.length && groups.length) {
      try {
        await shareMetadata(tsEnv, ids, groups.map((g) => ({ identifier: g, type: 'USER_GROUP' as const })), 'READ_ONLY');
      } catch (e) {
        shareError = (e as Error).message;
        console.error('share with group failed:', shareError);
      }
    }

    const dataSources = worksheetId ? [worksheetId] : tableId ? [tableId] : [];
    const searchUrl = tableId ? `${options.tsHost!.replace(/\/$/, '')}/#/data/tables/${tableId}` : undefined;

    return c.json({
      userid,
      platform,
      dataset: {
        tableId,
        tableName,
        worksheetId,
        worksheetName: worksheetId ? worksheetName : undefined,
        worksheetError,
        shareError,
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
    if (!canAdmin()) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set' }, 503);
    }
    const tableId = c.req.param('tableId');
    if (!/^[0-9a-f-]{16,}$/i.test(tableId)) return c.json({ error: 'invalid_request', detail: 'bad tableId' }, 400);
    await deleteTable((await adminEnv())!, tableId);
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
