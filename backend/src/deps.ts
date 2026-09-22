import { SessionStore } from './session';
import { mintUserToken, findMetadataId, importTml, findGuid, shareMetadata, deleteMetadata } from './thoughtspot';
import { generateWorksheetOnTable } from './tml';
import { rowsToCsv } from './csv';
import { uploadCsvDataset } from './userdata';

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

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export interface TsAdminEnv { host: string; token: string; }

export interface LoadedDataset {
  tableId?: string;
  worksheetId?: string;
  worksheetName: string;
  loaded: boolean;
  messages?: unknown[];
}

/** Shared state + capabilities passed to every route module. */
export interface Deps {
  options: AppOptions;
  store: SessionStore;
  maxBody: number;
  canAdmin(): boolean;
  adminEnv(): Promise<TsAdminEnv | null>;
  loadDataset(env: TsAdminEnv, wsName: string, columns: { name: string; format?: string }[], rows: unknown[][]): Promise<LoadedDataset>;
}

/**
 * Build the shared deps for one app instance: the session store, whether admin
 * REST calls are possible, and an admin env that prefers a static tsToken but
 * otherwise mints (and caches) a token AS the admin user from the secret key.
 */
export function makeDeps(options: AppOptions): Deps {
  const store = options.store ?? new SessionStore();
  const adminUser = options.tsAdminUser ?? 'tsadmin';
  const canAdmin = () => Boolean(options.tsHost && (options.tsToken || options.tsSecretKey));

  let adminCache = { token: '', exp: 0 };
  async function adminEnv(): Promise<TsAdminEnv | null> {
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

  /**
   * Load rows into a real Falcon table (same CSV pipeline as /dataset) and wrap
   * a worksheet on it, so a liveboard built on top has actual data. Idempotent:
   * reuses an existing worksheet of the same name.
   */
  async function loadDataset(env: TsAdminEnv, wsName: string, columns: { name: string; format?: string }[], rows: unknown[][]): Promise<LoadedDataset> {
    const tableName = `${wsName} Table`.slice(0, 90);
    const dataset = await uploadCsvDataset(env, rowsToCsv(columns, rows), tableName);
    const tableId = dataset.tableId ?? (await findMetadataId(env, tableName));
    let worksheetId = await findMetadataId(env, wsName, 'LOGICAL_TABLE');
    // A rebuilt table leaves its worksheet pointing at the dropped one, and the
    // tiles then fail with "the visualisation data could not be retrieved".
    // Drop the stale worksheet so it is regenerated over the new table.
    if (worksheetId && dataset.recreated) {
      try {
        await deleteMetadata(env, worksheetId, 'LOGICAL_TABLE');
        worksheetId = undefined;
      } catch (e) {
        console.error('[loadDataset] could not drop the stale worksheet:', (e as Error).message);
      }
    }
    if (!worksheetId && dataset.loaded && dataset.columns.length && tableId) {
      // Falcon reports the columns it created; the caller knows how the source
      // formatted them. Carry the format across by name so a measure keeps its
      // currency or percentage on the worksheet.
      const formatByName = new Map(columns.filter((c) => c.format).map((c) => [c.name, c.format!]));
      const withFormat = dataset.columns.map((c) => {
        const name = c.logicalName ?? c.physicalName ?? '';
        return formatByName.has(name) ? { ...c, format: formatByName.get(name) } : c;
      });
      const imp = await importTml(env, [generateWorksheetOnTable(wsName, tableName, withFormat)]);
      worksheetId = findGuid(imp, wsName) ?? (await findMetadataId(env, wsName, 'LOGICAL_TABLE'));
    }
    const groups = options.tsUserGroups ?? [];
    const ids = [worksheetId, tableId].filter((x): x is string => Boolean(x));
    if (ids.length && groups.length) {
      try {
        await shareMetadata(env, ids, groups.map((g) => ({ identifier: g, type: 'USER_GROUP' as const })), 'MODIFY');
      } catch (e) {
        console.error('[loadDataset] share failed:', (e as Error).message);
      }
    }
    return { tableId, worksheetId, worksheetName: wsName, loaded: dataset.loaded, messages: dataset.errors };
  }

  return {
    options,
    store,
    maxBody: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    canAdmin,
    adminEnv,
    loadDataset,
  };
}
