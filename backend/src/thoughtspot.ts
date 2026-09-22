// Optional ThoughtSpot REST v2 calls, used only when the backend is configured
// with TS_HOST + TS_TOKEN. Standard fetch — runs on Bun and Cloudflare Workers.

export interface TsEnv { host: string; token: string; }

// ── Shared REST request helper ─────────────────────────────────────────────
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
  /** Real email if known; otherwise one is synthesized from the username. */
  email?: string;
  /** Domain for the synthesized email when `email` is absent. */
  emailDomain?: string;
  /** Groups (GUIDs or names) to add the user to — these carry the privileges
   *  (e.g. Spotter/analysis) the user needs to run search. */
  groups?: string[];
}

// ── Users & groups ─────────────────────────────────────────────────────────

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

/** Look up a user by exact (sanitized) name; undefined when absent. Read-only,
 *  so existence checks can reuse it without risking a create. */
export async function searchUser(env: TsEnv, username: string): Promise<TsUser | undefined> {
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
  const groups = opts.groups?.filter(Boolean) ?? [];

  let user: EnsuredUser;
  const existing = await searchUser(env, username);
  if (existing) {
    user = { ...existing, created: false };
  } else {
    const displayName = `${opts.userid} (${opts.platform})`.slice(0, 128);
    // This cluster's create-user mutation requires an email (String!), so always
    // send one — the caller's if known, else a deterministic synthetic address.
    // The cluster enforces an email-domain allowlist (error 12714,
    // NON_WHITE_LISTED_DOMAIN). Default to the cluster's own domain; override
    // with TS_EMAIL_DOMAIN, or add a domain to the allowlist via tscli.
    const email = opts.email || `${username}@${opts.emailDomain ?? 'thoughtspot.com'}`;
    try {
      const created = (await ts(env, '/api/rest/2.0/users/create', {
        name: username,
        display_name: displayName,
        password: randomPassword(),
        account_type: opts.accountType ?? 'LOCAL_USER',
        email,
        ...(groups.length ? { group_identifiers: groups } : {}),
      })) as Record<string, unknown>;
      user = {
        id: String(created.id),
        name: String(created.name),
        display_name: created.display_name as string | undefined,
        created: true,
      };
    } catch (e) {
      // Lost a create race, or the name already existed — re-search and reuse.
      const again = await searchUser(env, username);
      if (!again) throw e;
      user = { ...again, created: false };
    }
  }

  // Ensure group membership (idempotent ADD) so the user has the privileges to
  // use search/Spotter — needed for existing users too, and for new users whose
  // create didn't take the groups. Best-effort: don't fail provisioning on it.
  if (groups.length) {
    try {
      await addUserToGroups(env, user.id, groups);
    } catch (e) {
      console.error(`addUserToGroups(${user.name}) failed:`, (e as Error).message);
    }
  }
  return user;
}

/** Add a user to groups (idempotent). Groups carry the privileges (e.g. the
 *  Spotter/analysis privilege) the user needs to actually run search. */
export function addUserToGroups(env: TsEnv, userId: string, groups: string[]): Promise<unknown> {
  return ts(env, `/api/rest/2.0/users/${encodeURIComponent(userId)}/update`, {
    group_identifiers: groups,
    operation: 'ADD',
  });
}

// ── Sharing ────────────────────────────────────────────────────────────────

export interface SharePrincipal { identifier: string; type: 'USER' | 'USER_GROUP'; }

/** Share metadata (worksheet/table = LOGICAL_TABLE) with users/groups so they
 *  can see and search it. tsadmin owns the imported objects; sharing with the
 *  group means every JIT-provisioned member gets access without a per-user call. */
export function shareMetadata(
  env: TsEnv,
  metadataIds: string[],
  principals: SharePrincipal[],
  shareMode: 'READ_ONLY' | 'MODIFY' = 'READ_ONLY',
  metadataType = 'LOGICAL_TABLE',
): Promise<unknown> {
  return ts(env, '/api/rest/2.0/security/metadata/share', {
    metadata_type: metadataType,
    metadata_identifiers: metadataIds,
    permissions: principals.map((principal) => ({ principal, share_mode: shareMode })),
    // Required by the cluster's share mutation (String!); empty = no notification.
    message: '',
    notify_on_share: false,
  });
}

// ── Auth & tokens ──────────────────────────────────────────────────────────

export interface MintTokenOptions {
  validitySec?: number;
  /** JIT-provision the user if absent (created with the groups below). */
  autoCreate?: boolean;
  /** Groups the JIT-created user joins — carry the Spotter/search privileges. */
  groups?: string[];
  email?: string;
  displayName?: string;
}

/**
 * Mint a cookieless login token FOR a given user via trusted auth (secret_key),
 * without their password — this is how the embed runs *as that user* instead of
 * as the admin. With `autoCreate`, /auth/token/full also JIT-provisions the user
 * (with `group_identifiers`) in the same call — create + assign groups + mint,
 * at embed time. Requires trusted authentication enabled on the cluster
 * (Develop → Security → Trusted authentication) and its secret key.
 */
export async function mintUserToken(
  host: string,
  username: string,
  secretKey: string,
  opts: MintTokenOptions = {},
): Promise<string> {
  const body: Record<string, unknown> = {
    username,
    secret_key: secretKey,
    validity_time_in_sec: opts.validitySec ?? 300,
  };
  if (opts.autoCreate) body.auto_create = true;
  if (opts.groups?.length) body.group_identifiers = opts.groups;
  if (opts.email) body.email = opts.email;
  if (opts.displayName) body.display_name = opts.displayName;

  const res = await fetch(`${host.replace(/\/$/, '')}/api/rest/2.0/auth/token/full`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`auth/token/full -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new Error('auth/token/full returned non-JSON'); }
  const token = (json as Record<string, unknown>)?.token;
  if (typeof token !== 'string') throw new Error('auth/token/full response had no token');
  return token;
}

// ── Metadata, TML & search ─────────────────────────────────────────────────

/** Export an object's TML (YAML edoc). Read-only; used to learn a table's exact
 *  column identifiers before generating a worksheet on top of it. */
export function exportTml(env: TsEnv, guids: string[]): Promise<unknown> {
  return ts(env, '/api/rest/2.0/metadata/tml/export', {
    metadata: guids.map((id) => ({ identifier: id })),
    edoc_format: 'YAML',
    export_fqn: true,
  });
}

/** Import table + worksheet TML; returns the raw import response (carries GUIDs). */
export function importTml(env: TsEnv, tmls: string[]): Promise<unknown> {
  return ts(env, '/api/rest/2.0/metadata/tml/import', {
    metadata_tmls: tmls,
    import_policy: 'ALL_OR_NONE',
    create_new: true,
  });
}

/** Resolve a metadata object's GUID by name via v2 search (reliable, unlike
 *  parsing internal upload responses). Defaults to LOGICAL_TABLE. */
export async function findMetadataId(env: TsEnv, name: string, type = 'LOGICAL_TABLE'): Promise<string | undefined> {
  const res = await ts(env, '/api/rest/2.0/metadata/search', {
    metadata: [{ type, name_pattern: name }],
    record_size: 10,
  });
  const list = Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
  // Exact-name only: name_pattern matches substrings, so a loose fallback would
  // return a different object (e.g. the "<name> Table" for a "<name>" worksheet).
  const pick = list.find((r) => (r.metadata_name ?? r.name) === name);
  if (!pick) return undefined;
  const id = pick.metadata_id ?? pick.id ?? (pick.metadata_header as Record<string, unknown> | undefined)?.id;
  return id ? String(id) : undefined;
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
// Collect any error/validation messages from a tml/import response (shape
// varies by version), so an ALL_OR_NONE failure reports WHY nothing imported.
export function importErrors(result: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    for (const key of ['error_message', 'error', 'message']) {
      const val = o[key];
      if (typeof val === 'string' && val && !out.includes(val)) out.push(val);
    }
    Object.values(o).forEach(walk);
  };
  walk(result);
  return out;
}

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
