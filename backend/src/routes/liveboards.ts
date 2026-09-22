import type { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { extractTwbXml, parseTableauColumns, parseWorkbookStructure, type Column, type WorkbookStructure } from '../tableau';
import { parseTmdlColumns } from '../powerbi';
import { generateTml, generateLiveboardTml, generateLiveboardOverSources } from '../tml';
import type { LiveboardSource } from '../tml';
import { importTml, findGuid, importErrors, findMetadataId, shareMetadata } from '../thoughtspot';
import { liveboardKey, buildLiveboard } from '../liveboard-pipeline';
import type { Deps } from '../deps';

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
    let providedName = '';
    if ((c.req.header('content-type') ?? '').includes('application/json')) {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, string>;
      platform = b.platform ?? '';
      guid = b.guid ?? '';
      providedName = b.name ?? '';
    }
    platform = (platform || c.req.query('platform') || '').toLowerCase();
    guid = guid || c.req.query('guid') || '';
    providedName = providedName || c.req.query('name') || '';
    if (!platform || (!guid && !providedName)) {
      return c.json({ error: 'invalid_request', detail: 'platform and a name or guid are required' }, 400);
    }
    if (!canAdmin()) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to look up liveboards' }, 503);
    }
    // An explicit name (the workbook/view name) is the reuse key when given, so
    // it matches how /create-liveboard names the board; else the guid key.
    const name = (providedName || liveboardKey(platform, guid)).slice(0, 80);
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

  // Build (or reuse) a liveboard from a platform's model + data, streaming each
  // stage (lookup -> load-data -> generate -> import -> share) as NDJSON when the
  // client asks (?stream=1 or ndjson Accept), matching /dataset, so the extension
  // checklist fills in live; otherwise a single JSON result. `name`/`guid` is the
  // reuse key. A posted Tableau workbook makes the liveboard mirror its tabs.
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
    let datasetsInput: { title: string; visualType?: string; roles?: string[]; page?: string; text?: string; columns: { name: string }[]; rows: unknown[][] }[] = [];
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
        datasetsInput = (b.datasets as { title?: string; name?: string; visualType?: string; roles?: string[]; page?: string; text?: string; columns?: { name: string }[]; rows?: unknown[][] }[])
          // A note tile carries words and no rows, so it cannot be held to the
          // same shape as a source that becomes a worksheet.
          .filter((d2) => d2 && (typeof d2.text === 'string'
            ? d2.text.trim().length > 0
            : Array.isArray(d2.columns) && d2.columns.length && Array.isArray(d2.rows) && d2.rows.length))
          .map((d2, i) => ({
            title: String(d2.title ?? d2.name ?? `Source ${i + 1}`),
            visualType: d2.visualType ? String(d2.visualType) : undefined,
            roles: Array.isArray(d2.roles) ? d2.roles.map(String) : undefined,
            page: d2.page ? String(d2.page) : undefined,
            text: d2.text ? String(d2.text) : undefined,
            columns: d2.columns ?? [],
            rows: d2.rows ?? [],
          }));
      }
    }

    platform = platform.toLowerCase();
    // An explicit name (the workbook/view name) wins, so the liveboard heading is
    // readable; else key on the guid (matches /get-liveboard), else the filename.
    name = (name || (guid ? liveboardKey(platform, guid) : filename.replace(/\.(twbx?|tdsx?|tmdl|zip)$/i, '')) || '').slice(0, 80);
    const conv = CONVERTERS[platform];
    if (!conv) {
      return c.json({ error: 'unsupported_platform', detail: `platform must be one of: ${Object.keys(CONVERTERS).join(', ')}` }, 400);
    }
    if (!name) return c.json({ error: 'invalid_request', detail: 'name is required (used as the reuse key)' }, 400);

    const tsEnv = await adminEnv();
    const pinboardUrl = (id: string) => `${options.tsHost!.replace(/\/$/, '')}/#/pinboard/${id}`;
    const stages: { stage: string; status: 'ok' | 'skipped' | 'failed'; detail?: string }[] = [];
    // Set while the datasets path runs inside a stream, so each stage reaches
    // the client as it happens rather than only in the final response.
    let emit: (e: Record<string, unknown>) => void = () => {};
    const stage = (s: string, status: 'ok' | 'skipped' | 'failed', detail?: string) => {
      const event = detail ? { stage: s, status, detail } : { stage: s, status };
      stages.push(event);
      emit(event);
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
    //
    // A whole report is dozens of sources and takes minutes, so this has to be
    // able to stream: without traffic the connection and the extension's MV3
    // worker are both torn down long before the build finishes.
    const buildFromDatasets = async (): Promise<{ status: 200 | 201 | 502; body: Record<string, unknown> }> => {
      // Only ever called behind `datasetsInput.length && tsEnv`.
      const env = tsEnv!;
      const sources: LiveboardSource[] = [];
      const loaded: { title: string; worksheetId: string }[] = [];
      for (const [i, ds] of datasetsInput.entries()) {
        // A note tile is words, not rows: no worksheet, no upload, straight
        // through to the liveboard.
        if (ds.text) {
          sources.push({ title: ds.title, page: ds.page, text: ds.text, worksheetName: '', columns: [] });
          stage(`note[${i + 1}]`, 'ok', ds.title);
          continue;
        }
        // Names are capped at 80 characters, so two visuals whose titles share a
        // prefix — "Revenue won" and "Revenue Won and Revenue In Pipeline…" —
        // can truncate to near-identical worksheet names, and a tile then fails
        // to resolve its source. A short suffix keeps every worksheet distinct.
        // It hashes the liveboard name as well as the title, so two report pages
        // that both hold a "Revenue and forecast by Product" get their own.
        const suffix = Array.from(`${name}·${ds.title}`)
          .reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)
          .toString(36).slice(0, 4);
        // Budget the title first. The prefix carries the report and page ids and
        // can fill all 80 characters by itself, which truncated every title away
        // and left worksheets telling apart only by their hash.
        const shortTitle = ds.title.slice(0, 40);
        const prefix = name.slice(0, Math.max(8, 74 - shortTitle.length - 3));
        const wsName = `${prefix} · ${shortTitle} ${suffix}`;
        let ws;
        try {
          ws = await loadDataset(env, wsName, ds.columns, ds.rows);
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
        // Power BI hands some measures over as numeric strings, so testing
        // typeof alone left a KPI's only measure looking like an attribute and
        // the tile fell back to a table. Require every non-empty value to parse,
        // so a column of mixed text is not mistaken for a measure.
        const isNumeric = (v: unknown): boolean =>
          typeof v === 'number' ? Number.isFinite(v)
            : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));
        const filled = (ci: number) => ds.rows.filter((r) => r[ci] !== null && r[ci] !== undefined && r[ci] !== '');
        const numeric = ds.columns.map((_, ci) => {
          const values = filled(ci);
          return values.length > 0 && values.every((r) => isNumeric(r[ci]));
        });
        sources.push({
          title: ds.title,
          visualType: ds.visualType,
          roles: ds.roles,
          rowCount: ds.rows.length,
          page: ds.page,
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
        return { status: 502, body: { platform, name, reused: false, error: 'data_load_failed', detail: 'no source loaded', stages } };
      }

      const liveboardTml = generateLiveboardOverSources(name, sources);
      stage('generate', 'ok', `${sources.length} tiles`);
      try {
        const result = await importTml(env, [liveboardTml]);
        liveboardId = (await findMetadataId(env, name, 'LIVEBOARD')) ?? findGuid(result, name);
        if (!liveboardId) {
          const detail = importErrors(result).join(' | ') || 'no liveboard GUID in the import response';
          stage('import', 'failed', detail);
          return { status: 502, body: { platform, name, reused: false, error: 'import_failed', detail, stages } };
        }
        stage('import', 'ok');
        stage('locate', 'ok');
      } catch (e) {
        stage('import', 'failed', (e as Error).message);
        return { status: 502, body: { platform, name, reused: false, error: 'cluster_error', detail: (e as Error).message, stages } };
      }
      await shareLiveboard(env, liveboardId);
      return { status: 201, body: { platform, name, reused: false, sources: loaded, liveboardId, liveboardUrl: pinboardUrl(liveboardId), stages } };
    };

    const wantsStream = c.req.query('stream') === '1'
      || (c.req.header('accept') ?? '').includes('application/x-ndjson');

    if (datasetsInput.length && tsEnv) {
      if (!wantsStream) {
        const r = await buildFromDatasets();
        return c.json(r.body, r.status);
      }
      c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      c.header('X-Accel-Buffering', 'no');
      return stream(c, async (s2) => {
        let chain: Promise<unknown> = Promise.resolve();
        const write = (obj: Record<string, unknown>): Promise<unknown> => {
          chain = chain.then(() => s2.write(JSON.stringify(obj) + '\n')).catch(() => {});
          return chain;
        };
        emit = (e) => { void write(e); };
        // Loading one source is silent for several seconds; a heartbeat keeps
        // the connection and the extension's worker alive across the whole run.
        const heartbeat = setInterval(() => { void write({ stage: 'heartbeat', status: 'active' }); }, 5000);
        try {
          const r = await buildFromDatasets();
          await write({ stage: 'result', status: r.status, ...r.body });
        } catch (e) {
          await write({ stage: 'result', status: 500, error: 'internal_error', detail: (e as Error).message });
        } finally {
          clearInterval(heartbeat);
          await chain;
        }
      });
    }

    // 2. parse/collect columns — from posted data (preferred: has rows) or the model.
    let columns: Column[];
    let rows: unknown[][] | null = null;
    if (dataInput) {
      columns = dataInput.columns
        .filter((col) => col && col.name)
        .map((col, i) => ({
          id: col.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col_${i}`,
          name: col.name,
          type: col.type === 'MEASURE' ? 'MEASURE' : 'ATTRIBUTE',
          dataType: (col.dataType as Column['dataType']) || 'VARCHAR',
        }));
      rows = dataInput.rows;
      if (!columns.length) return c.json({ error: 'invalid_request', detail: 'data.columns was empty' }, 422);
    } else {
      const model: Uint8Array | string | null = conv.binary ? bytes : text || (bytes ? new TextDecoder().decode(bytes) : '');
      if (!model || (conv.binary ? (model as Uint8Array).length === 0 : String(model).length === 0)) {
        return c.json({ error: 'invalid_request', detail: `no ${conv.modeling} model or data provided for ${platform}` }, 400);
      }
      try {
        columns = conv.parse(model);
      } catch (e) {
        return c.json({ error: 'parse_failed', detail: (e as Error).message }, 422);
      }
      if (!columns.length) {
        stage('parse', 'failed', 'no fields found in the model');
        return c.json({ platform, name, reused: false, stages }, 422);
      }
      stage('parse', 'ok', `${columns.length} columns (schema only, no data)`);
    }


    let structure: WorkbookStructure | null = null;

    // Data path: load real rows via the CSV pipeline, then build the liveboard
    // on that populated worksheet.
    if (rows && tsEnv) {
      let ws;
      try {
        ws = await loadDataset(tsEnv, name + ' Data', columns, rows);
        stage('load-data', ws.loaded ? 'ok' : 'failed', ws.worksheetId ? `worksheet ${ws.worksheetId}` : (ws.messages || []).join('; '));
      } catch (e) {
        console.error('[create-liveboard] structure parse failed:', (e as Error).message);
      }
    }

    // Everything below talks to the cluster, so stop here rather than passing a
    // null env down the pipeline.
    if (!tsEnv) {
      return c.json({ error: 'not_configured', detail: 'TS_HOST and TS_TOKEN must be set to build a liveboard', stages }, 503);
    }

    const hostBase = options.tsHost!.replace(/\/$/, '');
    const groups = options.tsUserGroups ?? [];
    const params = { platform, name, columns, rows, structure };

    if (wantsStream) {
      c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      c.header('X-Accel-Buffering', 'no'); // don't let a proxy buffer the stream
      return stream(c, async (s) => {
        // Serialize every write so heartbeats and stage events can't interleave
        // and corrupt an NDJSON line.
        let chain: Promise<unknown> = Promise.resolve();
        const write = (obj: Record<string, unknown>): Promise<unknown> => {
          chain = chain.then(() => s.write(JSON.stringify(obj) + '\n')).catch(() => {});
          return chain;
        };
        // The Falcon load stage can be silent for ~20s; without traffic the stream
        // goes idle and the MV3 worker / connection is torn down ("network error").
        // A heartbeat every few seconds keeps it alive.
        const heartbeat = setInterval(() => { void write({ stage: 'heartbeat', status: 'active' }); }, 5000);
        try {
          const result = await buildLiveboard(tsEnv, hostBase, groups, loadDataset, params, async (e) => { await write(e); });
          await write({ stage: 'result', status: result.status, ...result.body });
        } catch (e) {
          console.error(`[create-liveboard] stream failed for "${name}":`, (e as Error).stack || (e as Error).message);
          await write({ stage: 'result', status: 500, error: 'internal_error', detail: (e as Error).message });
        } finally {
          clearInterval(heartbeat);
          await chain;
        }
      });
    }

    const result = await buildLiveboard(tsEnv, hostBase, groups, loadDataset, params, () => {});
    return c.json(result.body, result.status);
  });
}
