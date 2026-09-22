// Client for ThoughtSpot's internal CSV -> Falcon upload pipeline
// (callosum `/callosum/v1/userdata/*`). This is NOT a public REST v2 API; it is
// the same pipeline the "Upload data" UI uses. Verified reachable with a
// full-access (tsadmin) bearer token — the token authenticates these private v1
// URLs globally, and token auth bypasses XSRF (a cookie session would need
// `X-Requested-By`, which we send anyway for parity).
//
// Flow for a fresh upload is two calls (readcolumns just reads back the
// auto-detected schema so we can name the table):
//   1. cachedatafile  (multipart CSV)     -> cacheToken
//   2. readcolumns    (cacheToken)        -> auto-detected schema
//   3. createtable    (schema + forceload)-> creates AND loads the Falcon table
// `loaddata` is the separate re-sync path (append/replace into an existing
// table); `delete/{id}` removes the table.
import type { TsEnv } from './thoughtspot';
import { findMetadataId } from './thoughtspot';

const BASE = '/callosum/v1/userdata';

function endpoint(env: TsEnv, path: string): string {
  return `${env.host.replace(/\/$/, '')}${BASE}${path}`;
}

// Token auth on a private v1 path; X-Requested-By is harmless and covers the
// cookie-session case. Content-Type is set by fetch for FormData bodies.
function authHeaders(env: TsEnv): Record<string, string> {
  return { Authorization: `Bearer ${env.token}`, 'X-Requested-By': 'ThoughtSpot' };
}

async function form(env: TsEnv, path: string, fields: Record<string, string>): Promise<string> {
  const body = new URLSearchParams(fields);
  const res = await fetch(endpoint(env, path), {
    method: 'POST',
    headers: { ...authHeaders(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text;
}

export interface UploadColumn {
  logicalName?: string;
  physicalName?: string;
  dataType?: string;
  size?: number;
  dateFormatStr?: string;
}
export interface CsvSchema {
  columns?: UploadColumn[];
  cacheToken?: string;
  tableName?: string;
  userData?: unknown;
  [k: string]: unknown;
}
export interface SchemaAndErrors {
  status: boolean;
  schema: CsvSchema;
  errors?: unknown[];
}

/** Step 1: cache the CSV server-side; returns a cache token (plain text).
 *  Falcon clusters take no join_option; Embrace-mode clusters require it and
 *  reject the upload with "join desired input is required" otherwise. Try the
 *  Falcon path first, then retry with join_option=0 (JOIN_NOT_DESIRED = a new
 *  standalone table, destination auto-deduced). */
export async function cacheDataFile(env: TsEnv, csv: string, fileName: string): Promise<string> {
  const attempt = async (joinOption?: number): Promise<{ ok: boolean; status: number; text: string }> => {
    const fd = new FormData();
    fd.append('content', new Blob([csv], { type: 'text/csv' }), fileName);
    fd.append('name', fileName);
    fd.append('separator', ',');
    fd.append('hasheaderrow', 'true');
    if (joinOption !== undefined) fd.append('join_option', String(joinOption));
    const res = await fetch(endpoint(env, '/cachedatafile'), { method: 'POST', headers: authHeaders(env), body: fd });
    return { ok: res.ok, status: res.status, text: (await res.text()).trim() };
  };

  let r = await attempt();
  if (!r.ok && /join desired input is required/i.test(r.text)) {
    r = await attempt(0);
  }
  if (!r.ok) throw new Error(`cachedatafile -> HTTP ${r.status}: ${r.text.slice(0, 400)}`);
  return r.text.replace(/^"|"$/g, ''); // returned as a bare/quoted GUID string
}

/** Step 2: read back the auto-detected schema for the cached file. */
export async function readColumns(env: TsEnv, cacheToken: string): Promise<SchemaAndErrors> {
  const text = await form(env, '/readcolumns', { cacheguid: cacheToken });
  return JSON.parse(text) as SchemaAndErrors;
}

/** Step 3: create the Falcon table and load the cached rows in one call. */
export async function createTable(env: TsEnv, schema: CsvSchema, forceLoad = true): Promise<SchemaAndErrors> {
  const text = await form(env, '/createtable', { schema: JSON.stringify(schema), forceload: String(forceLoad) });
  return JSON.parse(text) as SchemaAndErrors;
}

/** Re-sync: (re)load cached rows into an existing table; dropExisting replaces. */
export async function loadData(
  env: TsEnv,
  tableId: string,
  cacheToken: string,
  dropExisting = true,
  forceLoad = true,
): Promise<unknown> {
  const text = await form(env, '/loaddata', {
    id: tableId,
    cacheguid: cacheToken,
    forceload: String(forceLoad),
    dropexistingdata: String(dropExisting),
  });
  try { return JSON.parse(text); } catch { return text; }
}

/** Delete an uploaded table by GUID. */
export async function deleteTable(env: TsEnv, tableId: string): Promise<void> {
  const res = await fetch(endpoint(env, `/delete/${encodeURIComponent(tableId)}`), {
    method: 'GET',
    headers: authHeaders(env),
  });
  if (!res.ok) throw new Error(`delete/${tableId} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

/** Pull the created table's GUID out of a createtable response (shape varies). */
export function extractTableId(result: SchemaAndErrors): string | undefined {
  let found: string | undefined;
  const walk = (v: unknown): void => {
    if (found || !v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    // LogicalTable header carries the created table's id/guid.
    const header = o.header as Record<string, unknown> | undefined;
    const id = (header?.id ?? header?.guid ?? o.id_guid) as string | undefined;
    if (typeof id === 'string' && /^[0-9a-f-]{16,}$/i.test(id)) found = id;
    Object.values(o).forEach(walk);
  };
  walk(result.schema?.userData);
  return found;
}

export interface UploadedDataset {
  cacheToken: string;
  tableId?: string;
  tableName: string;
  columns: UploadColumn[];
  loaded: boolean;
  errors?: unknown[];
}

/**
 * Orchestrate a fresh CSV upload into Falcon: cache -> read schema -> name the
 * table -> create+load. Returns the created table id + detected columns.
 */
export async function uploadCsvDataset(
  env: TsEnv,
  csv: string,
  tableName: string,
): Promise<UploadedDataset> {
  const fileName = `${tableName}.csv`;
  const cacheToken = await cacheDataFile(env, csv, fileName);

  const read = await readColumns(env, cacheToken);
  if (!read.status) {
    throw new Error(`readcolumns failed: ${JSON.stringify(read.errors ?? []).slice(0, 300)}`);
  }
  const schema: CsvSchema = { ...read.schema, cacheToken, tableName };

  // Refresh in place when this table already exists. createtable does NOT
  // replace a same-named table — it adds another one with the same name, and
  // the worksheet TML binds its table BY NAME, so it can resolve to an older
  // copy and serve stale rows. Re-syncing with dropexistingdata keeps one
  // table, one id, and guarantees the rows are the ones just extracted.
  const existingId = await findMetadataId(env, tableName);
  if (existingId) {
    // loaddata writes into the existing schema, so it fails outright when the
    // source's shape has changed (a visual gaining or losing a column). Drop
    // the table and fall through to a fresh create rather than leaving the
    // caller with yesterday's rows.
    try {
      const reloaded = (await loadData(env, existingId, cacheToken, true, true)) as SchemaAndErrors;
      if (reloaded?.status !== false) {
        return {
          cacheToken,
          tableId: existingId,
          tableName,
          columns: reloaded?.schema?.columns ?? read.schema?.columns ?? [],
          loaded: true,
          errors: reloaded?.errors,
        };
      }
    } catch (e) {
      console.warn(`[uploadCsvDataset] reload of "${tableName}" failed, recreating:`, (e as Error).message);
    }
    await deleteTable(env, existingId).catch((e: Error) => {
      console.error(`[uploadCsvDataset] could not drop "${tableName}":`, e.message);
    });
  }

  const created = await createTable(env, schema);
  return {
    cacheToken,
    tableId: extractTableId(created),
    tableName,
    columns: created.schema?.columns ?? read.schema?.columns ?? [],
    loaded: created.status,
    errors: created.errors,
  };
}
