// Optional ThoughtSpot REST v2 calls, used only when the backend is configured
// with TS_HOST + TS_TOKEN. Standard fetch — runs on Bun and Cloudflare Workers.

export interface TsEnv { host: string; token: string; }

async function ts(env: TsEnv, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${env.host.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${env.token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    const detail = typeof json === 'string' ? json : JSON.stringify(json);
    throw new Error(`${path} -> HTTP ${res.status}: ${detail.slice(0, 400)}`);
  }
  return json;
}

/** Import table + worksheet TML; returns the raw import response (carries GUIDs). */
export function importTml(env: TsEnv, tmls: string[]): Promise<unknown> {
  return ts(env, '/api/rest/2.0/metadata/tml/import', {
    metadata_tmls: tmls,
    import_policy: 'ALL_OR_NONE',
    create_new: true,
  });
}

/** Search the worksheet — the "user searches the data" step. */
export function searchData(env: TsEnv, worksheetId: string, query: string, recordSize = 50): Promise<unknown> {
  return ts(env, '/api/rest/2.0/searchdata', {
    query_string: query,
    logical_table_identifier: worksheetId,
    data_format: 'COMPACT',
    record_offset: 0,
    record_size: recordSize,
  });
}

/** Best-effort GUID extraction from a tml/import response (shape varies by version). */
export function findGuid(result: unknown, name: string): string | undefined {
  let found: string | undefined;
  const walk = (v: unknown): void => {
    if (found || !v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    const id = (o.id_guid ?? o.guid ?? o.id) as string | undefined;
    const nm = (o.name ?? o.metadata_name) as string | undefined;
    if (typeof id === 'string' && (!nm || nm === name)) found = id;
    Object.values(o).forEach(walk);
  };
  walk(result);
  return found;
}
