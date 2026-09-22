import { generateTml, generateLiveboardTml, generateTabbedLiveboardTml } from './tml';
import { importTml, findGuid, importErrors, findMetadataId, shareMetadata } from './thoughtspot';
import type { Column, WorkbookStructure } from './tableau';
import type { TsAdminEnv, LoadedDataset } from './deps';

// Deterministic liveboard name from (platform, guid) alone, so /get-liveboard
// and /create-liveboard agree on the reuse key without sharing any other state.
export const liveboardKey = (platform: string, guid: string): string =>
  `Spotter · ${platform} · ${guid}`.slice(0, 80);

/** Progress events for the streaming /create-liveboard path. Same shape as the
 *  dataset pipeline: { stage, status: 'start'|'done'|'error', detail?, ...ids }. */
export type ProgressEmit = (event: Record<string, unknown>) => void | Promise<void>;

export interface LiveboardParams {
  platform: string;
  name: string;
  columns: Column[];
  /** Real rows to load into Falcon; null builds a schema-only (empty) liveboard. */
  rows: unknown[][] | null;
  /** Parsed workbook structure; when it has dashboards, the liveboard is tabbed. */
  structure: WorkbookStructure | null;
}

type LoadDatasetFn = (
  env: TsAdminEnv,
  wsName: string,
  columns: { name: string }[],
  rows: unknown[][],
) => Promise<LoadedDataset>;

// The extension's MEASURE/ATTRIBUTE guess (from Tableau's underlying data types)
// is unreliable — when it labels everything an attribute, every viz has no
// measure and renders as a table. Reclassify from the real values instead: a
// column whose sample values are all numeric is a measure, unless it looks like
// an id/code. This is what the chart-type picker keys off, so it decides the
// difference between a column chart and a plain table.
function classifyColumns(columns: Column[], rows: unknown[][]): Column[] {
  if (!rows.length) return columns;
  const sample = rows.slice(0, 100);
  return columns.map((col, i) => {
    let seen = 0;
    let numeric = 0;
    for (const r of sample) {
      const v = r[i];
      if (v === null || v === undefined || v === '') continue;
      seen++;
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,%\s]/g, ''));
      if (Number.isFinite(n)) numeric++;
    }
    const looksLikeId = /(^|[\s_])id$/i.test(col.name) || /postal|zip|code|year|phone/i.test(col.name);
    const isMeasure = seen > 0 && numeric === seen && !looksLikeId;
    return { ...col, type: isMeasure ? 'MEASURE' : 'ATTRIBUTE' };
  });
}

// The liveboard is imported by the admin token, so tsadmin owns it. The embed
// runs AS the provisioned user, who otherwise sees "request access". Share it
// READ_ONLY with the Spotter group so every JIT-provisioned member can open it.
// Best-effort and idempotent, so it also heals liveboards shared on an earlier run.
async function shareLiveboard(env: TsAdminEnv, liveboardId: string, groups: string[]): Promise<void> {
  if (!liveboardId || !groups.length) return;
  try {
    await shareMetadata(
      env,
      [liveboardId],
      groups.map((g) => ({ identifier: g, type: 'USER_GROUP' as const })),
      'MODIFY', // edit access so the embed user can change the liveboard
      'LIVEBOARD',
    );
  } catch (e) {
    console.error('[create-liveboard] share liveboard failed:', (e as Error).message);
  }
}

type BuildResult = { status: 200 | 201 | 502; body: Record<string, unknown> };

// One build per liveboard name at a time. The extension can fire two requests
// for the same board almost together (the NDJSON stream plus its client-side
// fallback), and two concurrent Falcon loads on the same table collide with
// "LOAD_CYCLE_CONFLICTS". A second caller joins the in-flight build instead.
const inFlight = new Map<string, Promise<BuildResult>>();

/**
 * Build (or reuse) a liveboard, reporting each stage through `emit`:
 * lookup -> load-data -> generate -> import -> share. Serialized per name so
 * concurrent callers never start colliding loads. Both the JSON route (no-op
 * emit) and the streaming route use this, so they can never drift.
 */
export async function buildLiveboard(
  tsEnv: TsAdminEnv,
  hostBase: string,
  groups: string[],
  loadDataset: LoadDatasetFn,
  params: LiveboardParams,
  emit: ProgressEmit,
): Promise<BuildResult> {
  const key = `${params.platform}::${params.name}`;
  const running = inFlight.get(key);
  if (running) {
    await emit({ stage: 'lookup', status: 'start', detail: 'joining an in-progress build' });
    let result: BuildResult;
    try {
      result = await running;
    } catch (e) {
      const detail = (e as Error).message;
      await emit({ stage: 'lookup', status: 'error', detail });
      return { status: 502, body: { platform: params.platform, name: params.name, reused: false, error: 'build_failed', detail } };
    }
    if (result.status < 400) {
      for (const s of ['load-data', 'generate', 'import', 'share']) await emit({ stage: s, status: 'done', detail: 'built by concurrent request' });
      await emit({ stage: 'lookup', status: 'done', detail: 'joined build', liveboardId: result.body.liveboardId });
    } else {
      await emit({ stage: 'import', status: 'error', detail: String(result.body.detail ?? result.body.error ?? 'build failed') });
    }
    return result;
  }
  const p = runLiveboardBuild(tsEnv, hostBase, groups, loadDataset, params, emit);
  inFlight.set(key, p);
  try {
    return await p;
  } finally {
    inFlight.delete(key);
  }
}

async function runLiveboardBuild(
  tsEnv: TsAdminEnv,
  hostBase: string,
  groups: string[],
  loadDataset: LoadDatasetFn,
  { platform, name, columns, rows, structure }: LiveboardParams,
  emit: ProgressEmit,
): Promise<BuildResult> {
  const pinboardUrl = (id: string) => `${hostBase}/#/pinboard/${id}`;
  const tabbed = Boolean(structure && structure.dashboards.length);
  // Reclassify measures from the actual data so charts (not tables) get chosen.
  const typedColumns = rows && rows.length ? classifyColumns(columns, rows) : columns;
  const buildTml = (ws: string): string =>
    tabbed ? generateTabbedLiveboardTml(name, ws, structure!, typedColumns) : generateLiveboardTml(name, ws, typedColumns);

  // 1. lookup — reuse an existing liveboard by name (no rebuild).
  await emit({ stage: 'lookup', status: 'start' });
  let existing: string | undefined;
  try {
    existing = await findMetadataId(tsEnv, name, 'LIVEBOARD');
  } catch (e) {
    const detail = (e as Error).message;
    console.error(`[create-liveboard] lookup failed for "${name}":`, detail);
    await emit({ stage: 'lookup', status: 'error', detail });
    return { status: 502, body: { platform, name, reused: false, error: 'cluster_error', detail } };
  }
  if (existing) {
    await shareLiveboard(tsEnv, existing, groups);
    await emit({ stage: 'lookup', status: 'done', detail: 'reused existing', liveboardId: existing });
    return { status: 200, body: { platform, name, reused: true, liveboardId: existing, liveboardUrl: pinboardUrl(existing) } };
  }
  await emit({ stage: 'lookup', status: 'done', detail: 'not found — building' });

  // 2. load-data — load real rows into Falcon and wrap a worksheet, so the
  //    liveboard sits on populated data. Skipped when no rows were provided.
  let worksheetName = name;
  let worksheetId: string | undefined;
  const dataBacked = Boolean(rows && rows.length);
  if (dataBacked) {
    await emit({ stage: 'load-data', status: 'start', detail: `${rows!.length} rows, ${columns.length} columns` });
    let ws: LoadedDataset;
    try {
      ws = await loadDataset(tsEnv, `${name} Data`, columns, rows!);
    } catch (e) {
      const detail = (e as Error).message;
      console.error(`[create-liveboard] load-data failed for "${name}":`, detail);
      await emit({ stage: 'load-data', status: 'error', detail });
      return { status: 502, body: { platform, name, reused: false, error: 'data_load_failed', detail } };
    }
    if (!ws.worksheetId) {
      const detail = (ws.messages || []).join('; ') || 'no worksheet after load';
      console.error(`[create-liveboard] load-data produced no worksheet for "${name}":`, detail);
      await emit({ stage: 'load-data', status: 'error', detail });
      return { status: 502, body: { platform, name, reused: false, error: 'data_load_failed', detail } };
    }
    worksheetName = ws.worksheetName;
    worksheetId = ws.worksheetId;
    await emit({ stage: 'load-data', status: 'done', worksheetId, detail: `worksheet ${worksheetId}` });
  }

  // 3. generate — TML for the (tabbed or single) liveboard, plus the table +
  //    worksheet when there is no loaded data model to sit on.
  await emit({ stage: 'generate', status: 'start', detail: tabbed ? `${structure!.dashboards.length} tabs` : 'single tab' });
  const tmls: string[] = [];
  if (!dataBacked) {
    const base = generateTml(name, columns);
    worksheetName = base.worksheetName;
    tmls.push(base.tableTml, base.worksheetTml);
  }
  tmls.push(buildTml(worksheetName));
  await emit({ stage: 'generate', status: 'done' });

  // 4. import — one ALL_OR_NONE import; any invalid TML aborts the whole thing.
  await emit({ stage: 'import', status: 'start' });
  let liveboardId: string | undefined;
  try {
    const result = await importTml(tsEnv, tmls);
    liveboardId = findGuid(result, name);
    if (!liveboardId) {
      const detail = importErrors(result).join(' | ') || 'no liveboard GUID in the import response';
      console.error('[create-liveboard] import produced no liveboard:', detail);
      await emit({ stage: 'import', status: 'error', detail });
      return { status: 502, body: { platform, name, reused: false, error: 'import_failed', detail } };
    }
  } catch (e) {
    const detail = (e as Error).message;
    console.error(`[create-liveboard] import failed for "${name}":`, detail);
    await emit({ stage: 'import', status: 'error', detail });
    return { status: 502, body: { platform, name, reused: false, error: 'cluster_error', detail } };
  }
  await emit({ stage: 'import', status: 'done', liveboardId });

  // 5. share — with the Spotter group, so the embed user can open it.
  await emit({ stage: 'share', status: 'start' });
  await shareLiveboard(tsEnv, liveboardId, groups);
  await emit({ stage: 'share', status: 'done' });

  return {
    status: 201,
    body: { platform, name, reused: false, worksheetId, liveboardId, liveboardUrl: pinboardUrl(liveboardId) },
  };
}
