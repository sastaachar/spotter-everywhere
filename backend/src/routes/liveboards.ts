import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { extractTwbXml, parseTableauColumns, type Column } from '../tableau';
import { parseTmdlColumns } from '../powerbi';
import { generateTml, generateLiveboardTml, generateLiveboardOverSources } from '../tml';
import type { LiveboardSource } from '../tml';
import { importTml, findGuid, importErrors, findMetadataId, shareMetadata } from '../thoughtspot';
import type { Deps } from '../deps';

// Deterministic liveboard name from (platform, guid) alone, so /get-liveboard
// and /create-liveboard agree on the reuse key without sharing any other state.
const liveboardKey = (platform: string, guid: string): string =>
  `Spotter · ${platform} · ${guid}`.slice(0, 80);

// Each source platform declares its modeling language and how to read columns.
const CONVERTERS: Record<string, { modeling: string; binary: boolean; parse: (data: Uint8Array | string) => Column[] }> = {
  tableau: { modeling: 'twb', binary: true, parse: (d) => parseTableauColumns(extractTwbXml(d as Uint8Array)) },
  powerbi: { modeling: 'tmdl', binary: false, parse: (d) => parseTmdlColumns(String(d)) },
};

export function registerLiveboardRoutes(app: Hono, deps: Deps): void {
  const { options, adminEnv, canAdmin, loadDataset, maxBody } = deps;

  // Convert a Tableau .twb/.twbx to ThoughtSpot TML and return it — no cluster
  // needed, no import, no user provisioned. Body: multipart with a `file`, or
  // JSON { filename?, fileBase64 }. Returns the table + worksheet TML text.
  app.post('/twb-to-tml', bodyLimit({ maxSize: maxBody }), async (c) => {
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

  // Build once, then reuse. `name` is the idempotency key (pass the workbook's
  // LUID or a "<workbook> <luid>" so two same-named workbooks don't collide).
  // Called with just { name } it looks up an existing liveboard and returns it
  // with no download; 404 not_built means "resend with the .twb to build it".
  app.post('/liveboard', bodyLimit({ maxSize: maxBody }), async (c) => {
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

  // Build (or reuse) a liveboard from a platform's model, reporting each stage:
  // lookup -> parse -> generate -> import -> locate. Body: multipart { platform,
  // name, file } or JSON { platform, name, fileBase64 | model }. `name` is the
  // reuse key. Returns { reused, liveboardId, stages: [{stage,status,detail}] }.
  app.post('/create-liveboard', bodyLimit({ maxSize: maxBody }), async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let platform = '';
    let name = '';
    let guid = '';
    let filename = '';
    let bytes: Uint8Array | null = null;
    let text = '';
    let dataInput: { columns: { name: string; type?: string; dataType?: string }[]; rows: unknown[][] } | null = null;
    // One entry per source visual: the liveboard gets a tile per visual, each
    // answering from a worksheet loaded with that visual's own rows.
    let datasetsInput: { title: string; columns: { name: string }[]; rows: unknown[][] }[] = [];
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
      if (Array.isArray(b.datasets)) {
        datasetsInput = (b.datasets as { title?: string; name?: string; columns?: { name: string }[]; rows?: unknown[][] }[])
          .filter((d2) => d2 && Array.isArray(d2.columns) && d2.columns.length && Array.isArray(d2.rows) && d2.rows.length)
          .map((d2, i) => ({ title: String(d2.title ?? d2.name ?? `Source ${i + 1}`), columns: d2.columns!, rows: d2.rows! }));
      }
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


    let liveboardId: string | undefined;

    /** Share a liveboard with the privileged groups; without it the embed user
     *  gets ThoughtSpot's "request access" page. loadDataset already shares the
     *  worksheets underneath. Best effort — a share failure must not discard
     *  the liveboard. */
    const shareLiveboard = async (env: { host: string; token: string }, id: string) => {
      const groups = options.tsUserGroups ?? [];
      if (!groups.length) return stage('share', 'skipped', 'TS_USER_GROUPS not set');
      try {
        await shareMetadata(
          env, [id],
          groups.map((g) => ({ identifier: g, type: 'USER_GROUP' as const })), 'READ_ONLY', 'LIVEBOARD',
        );
        stage('share', 'ok');
      } catch (e) {
        stage('share', 'failed', (e as Error).message);
      }
    };

    // Report path: each source visual's rows become their own worksheet and the
    // liveboard gets one tile per source — the report's real data, not a
    // schema-only shell. Runs before the parse stage, which needs a model.
    if (datasetsInput.length && tsEnv) {
      const sources: LiveboardSource[] = [];
      const loaded: { title: string; worksheetId: string }[] = [];
      for (const [i, ds] of datasetsInput.entries()) {
        const wsName = `${name} · ${ds.title}`.slice(0, 80);
        let ws;
        try {
          ws = await loadDataset(tsEnv, wsName, ds.columns, ds.rows);
        } catch (e) {
          stage(`load-data[${i + 1}]`, 'failed', `${ds.title}: ${(e as Error).message}`);
          continue;
        }
        if (!ws.worksheetId || !ws.loaded) {
          stage(`load-data[${i + 1}]`, 'failed', `${ds.title}: ${(ws.messages || []).join('; ') || 'no worksheet after load'}`);
          continue;
        }
        stage(`load-data[${i + 1}]`, 'ok', `${ds.title}: ${ds.rows.length} rows`);
        loaded.push({ title: ds.title, worksheetId: ws.worksheetId });
        // Type off the loaded rows so a tile charts what is actually numeric.
        const numeric = ds.columns.map((_, ci) => ds.rows.some((r) => typeof r[ci] === 'number'));
        sources.push({
          title: ds.title,
          worksheetName: ws.worksheetName,
          columns: ds.columns.map((col, ci) => ({
            id: `col_${ci}`,
            name: col.name,
            type: numeric[ci] ? 'MEASURE' : 'ATTRIBUTE',
            dataType: numeric[ci] ? 'DOUBLE' : 'VARCHAR',
          })),
        });
      }
      if (!sources.length) {
        return c.json({ platform, name, reused: false, error: 'data_load_failed', detail: 'no source loaded', stages }, 502);
      }

      const liveboardTml = generateLiveboardOverSources(name, sources);
      stage('generate', 'ok', `${sources.length} tiles`);
      try {
        const result = await importTml(tsEnv, [liveboardTml]);
        liveboardId = (await findMetadataId(tsEnv, name, 'LIVEBOARD')) ?? findGuid(result, name);
        if (!liveboardId) {
          const detail = importErrors(result).join(' | ') || 'no liveboard GUID in the import response';
          stage('import', 'failed', detail);
          return c.json({ platform, name, reused: false, error: 'import_failed', detail, stages }, 502);
        }
        stage('import', 'ok');
        stage('locate', 'ok');
      } catch (e) {
        stage('import', 'failed', (e as Error).message);
        return c.json({ platform, name, reused: false, error: 'cluster_error', detail: (e as Error).message, stages }, 502);
      }
      await shareLiveboard(tsEnv, liveboardId);
      return c.json({ platform, name, reused: false, sources: loaded, liveboardId, liveboardUrl: pinboardUrl(liveboardId), stages }, 201);
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
}
