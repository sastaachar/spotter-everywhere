import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { extractTwbXml, parseTableauColumns } from '../tableau';
import { generateTml } from '../tml';
import { importTml, findGuid, findMetadataId, ensureUser, sanitizeUsername, searchUser } from '../thoughtspot';
import { rowsToCsv } from '../csv';
import { deleteTable } from '../userdata';
import { datasetNames, buildDataset } from '../dataset-pipeline';
import type { Deps } from '../deps';

export function registerDatasetRoutes(app: Hono, deps: Deps): void {
  const { options, canAdmin, adminEnv, maxBody } = deps;

  app.post('/worksheet', bodyLimit({ maxSize: maxBody }), async (c) => {
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

  // Read-only existence check for a dataset's ThoughtSpot objects, so the client
  // can show what already exists and skip rebuilding. Same reuse key as /dataset
  // (userid, platform, name). Reports the user, the loaded table ("data model")
  // and the worksheet; `ready` means the worksheet exists and can be embedded
  // as-is. Body: JSON { userid, platform, name? }.
  app.post('/dataset/check', async (c) => {
    if (!canAdmin()) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set' }, 503);
    }
    let body: Record<string, string>;
    try {
      body = (await c.req.json()) as Record<string, string>;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const userid = (body.userid ?? '').trim();
    const platform = (body.platform ?? '').trim();
    const name = (body.name ?? '').trim();
    if (!userid || !platform) return c.json({ error: 'invalid_request', detail: 'userid and platform are required' }, 400);

    const tsEnv = (await adminEnv())!;
    const { worksheetName, tableName } = datasetNames(userid, platform, name);
    const username = sanitizeUsername(`${options.tsUserPrefix ?? ''}${userid}`);

    // All read-only lookups, in parallel; a lookup failure reads as "absent"
    // rather than failing the whole check.
    const [user, tableId, worksheetId] = await Promise.all([
      searchUser(tsEnv, username).catch(() => undefined),
      findMetadataId(tsEnv, tableName, 'LOGICAL_TABLE').catch(() => undefined),
      findMetadataId(tsEnv, worksheetName, 'LOGICAL_TABLE').catch(() => undefined),
    ]);

    return c.json({
      userid,
      platform,
      user: user ? { exists: true, username: user.name, id: user.id } : { exists: false, username },
      table: tableId ? { exists: true, id: tableId, name: tableName } : { exists: false, name: tableName },
      worksheet: worksheetId ? { exists: true, id: worksheetId, name: worksheetName } : { exists: false, name: worksheetName },
      ready: Boolean(worksheetId),
    });
  });

  // Load real data ROWS into Falcon so Spotter can answer, then wrap the
  // uploaded table in a worksheet. Body (JSON): { userid, platform, name?, and
  // one of: data:{columns,rows} | csv | csvBase64 } — or multipart with a CSV
  // `file`. Returns the table + worksheet ids and ready-to-use embed sources.
  app.post('/dataset', bodyLimit({ maxSize: maxBody }), async (c) => {
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

    const hostBase = options.tsHost!.replace(/\/$/, '');
    const groups = options.tsUserGroups ?? [];
    const params = { userid, platform, name, csv };

    // Stream per-stage progress (load -> worksheet -> share) as NDJSON when the
    // client asks (?stream=1 or an ndjson Accept header) so the checklist fills
    // in live; otherwise return the single JSON result exactly as before. The
    // final line is `{ stage: 'result', status, ...body }`.
    const wantsStream = c.req.query('stream') === '1'
      || (c.req.header('accept') ?? '').includes('application/x-ndjson');
    if (wantsStream) {
      c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      c.header('X-Accel-Buffering', 'no'); // don't let a proxy buffer the stream
      return stream(c, async (s) => {
        // Serialized writes + a heartbeat so the long Falcon load doesn't leave
        // the stream idle long enough for the MV3 worker/connection to be torn
        // down ("network error").
        let chain: Promise<unknown> = Promise.resolve();
        const write = (obj: Record<string, unknown>): Promise<unknown> => {
          chain = chain.then(() => s.write(JSON.stringify(obj) + '\n')).catch(() => {});
          return chain;
        };
        const heartbeat = setInterval(() => { void write({ stage: 'heartbeat', status: 'active' }); }, 5000);
        try {
          const result = await buildDataset(tsEnv, hostBase, groups, params, async (e) => { await write(e); });
          await write({ stage: 'result', status: result.status, ...result.body });
        } catch (e) {
          await write({ stage: 'result', status: 500, error: 'internal_error', detail: (e as Error).message });
        } finally {
          clearInterval(heartbeat);
          await chain;
        }
      });
    }

    const result = await buildDataset(tsEnv, hostBase, groups, params, () => {});
    return c.json(result.body, result.status);
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
}
