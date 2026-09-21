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

export interface TsUser { id: string; name: string; display_name?: string; }
export interface EnsuredUser extends TsUser { created: boolean; }

export interface EnsureUserOptions {
  /** The platform-side identity, e.g. the Tableau username. */
  userid: string;
  /** e.g. "tableau" — recorded in the display name for readability. */
  platform: string;
  /** Optional namespace prepended to the username to avoid clobbering real users. */
  prefix?: string;
  /** LOCAL_USER (default), SAML_USER, OIDC_USER, ... */
  accountType?: string;
  email?: string;
}

// A strong random password, so LOCAL_USER creation doesn't trigger an
// activation email on IAMv2. Web Crypto — portable across Bun + Workers.
// Never logged and never returned to the client.
function randomPassword(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const rand = btoa(bin).replace(/[^a-zA-Z0-9]/g, '');
  // Prefix guarantees the usual upper/lower/digit/special complexity classes.
  return `Aa1!${rand}`;
}

// ThoughtSpot usernames are case-insensitive and limited in charset; make a
// deterministic, safe name so provisioning is idempotent across calls.
export function sanitizeUsername(raw: string): string {
  return (
    raw.trim().toLowerCase().replace(/[^a-z0-9._@-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'user'
  );
}

/** Look up a user by exact (sanitized) name; undefined when absent. */
async function searchUser(env: TsEnv, username: string): Promise<TsUser | undefined> {
  const res = await ts(env, '/api/rest/2.0/users/search', { user_identifier: username });
  const list = Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
  const match = list.find((u) => u && typeof u === 'object' && u.name === username);
  if (!match) return undefined;
  return { id: String(match.id), name: String(match.name), display_name: match.display_name as string | undefined };
}

/**
 * Idempotently provision a ThoughtSpot user for a platform identity, using the
 * configured (tsadmin) token. Searches first, creates only when absent, and
 * falls back to search on a create race / "already exists". The generated
 * password is never returned or logged.
 */
export async function ensureUser(env: TsEnv, opts: EnsureUserOptions): Promise<EnsuredUser> {
  const username = sanitizeUsername(`${opts.prefix ?? ''}${opts.userid}`);
  const existing = await searchUser(env, username);
  if (existing) return { ...existing, created: false };

  const displayName = `${opts.userid} (${opts.platform})`.slice(0, 128);
  try {
    const created = (await ts(env, '/api/rest/2.0/users/create', {
      name: username,
      display_name: displayName,
      password: randomPassword(),
      account_type: opts.accountType ?? 'LOCAL_USER',
      ...(opts.email ? { email: opts.email } : {}),
    })) as Record<string, unknown>;
    return {
      id: String(created.id),
      name: String(created.name),
      display_name: created.display_name as string | undefined,
      created: true,
    };
  } catch (e) {
    // Lost a create race, or the name already existed — re-search and reuse.
    const again = await searchUser(env, username);
    if (again) return { ...again, created: false };
    throw e;
  }
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
