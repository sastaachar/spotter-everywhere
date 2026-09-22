import { findMetadataId, importTml, findGuid, shareMetadata } from './thoughtspot';
import { generateWorksheetOnTable } from './tml';
import { uploadCsvDataset } from './userdata';
import type { TsAdminEnv } from './deps';

/**
 * The reuse key for a loaded dataset: (userid, platform, sheet name). /dataset
 * and /dataset/check derive the table + worksheet names from here so an
 * existence check and a build always agree on which objects to look for.
 */
export function datasetNames(userid: string, platform: string, name: string) {
  const baseName = `${userid} ${platform} ${name || 'data'}`.replace(/\s+/g, ' ').trim().slice(0, 78);
  return { baseName, worksheetName: baseName, tableName: `${baseName} Table`.slice(0, 90) };
}

interface DatasetParams { userid: string; platform: string; name: string; csv: string; }

/** Progress events for the streaming /dataset path — load / worksheet / share. */
export type ProgressEmit = (event: Record<string, unknown>) => void | Promise<void>;

/**
 * Run the dataset pipeline (load rows -> wrap in a worksheet -> share with the
 * group), reporting each stage through `emit`. Both /dataset (JSON, no-op emit)
 * and the streaming path use this, so they can never drift. Returns the response
 * body + status the JSON route would send.
 */
export async function buildDataset(
  tsEnv: TsAdminEnv,
  hostBase: string,
  groups: string[],
  { userid, platform, name, csv }: DatasetParams,
  emit: ProgressEmit,
): Promise<{ status: 201 | 502; body: Record<string, unknown> }> {
  const { worksheetName, tableName } = datasetNames(userid, platform, name);

  await emit({ stage: 'load', status: 'start', detail: tableName });
  let dataset;
  let tableId: string | undefined;
  try {
    dataset = await uploadCsvDataset(tsEnv, csv, tableName);
    tableId = dataset.tableId ?? (await findMetadataId(tsEnv, tableName));
  } catch (e) {
    const detail = (e as Error).message;
    await emit({ stage: 'load', status: 'error', detail });
    return { status: 502, body: { error: 'data_load_failed', detail } };
  }
  await emit({ stage: 'load', status: 'done', tableId, detail: `${dataset.columns.length} columns` });

  let worksheetId: string | undefined;
  let worksheetError: string | undefined;
  if (dataset.loaded && dataset.columns.length && tableId) {
    await emit({ stage: 'worksheet', status: 'start' });
    try {
      worksheetId = await findMetadataId(tsEnv, worksheetName, 'LOGICAL_TABLE');
      if (!worksheetId) {
        const imp = await importTml(tsEnv, [generateWorksheetOnTable(worksheetName, tableName, dataset.columns)]);
        worksheetId = findGuid(imp, worksheetName) ?? (await findMetadataId(tsEnv, worksheetName, 'LOGICAL_TABLE'));
        if (!worksheetId) worksheetError = `import returned no guid: ${JSON.stringify(imp).slice(0, 400)}`;
      }
      await emit({ stage: 'worksheet', status: worksheetId ? 'done' : 'error', worksheetId, detail: worksheetError });
    } catch (e) {
      worksheetError = (e as Error).message;
      console.error('worksheet wrap failed:', worksheetError);
      await emit({ stage: 'worksheet', status: 'error', detail: worksheetError });
    }
  }

  let shareError: string | undefined;
  const ids = [worksheetId, tableId].filter((x): x is string => Boolean(x));
  if (ids.length && groups.length) {
    await emit({ stage: 'share', status: 'start' });
    try {
      await shareMetadata(tsEnv, ids, groups.map((g) => ({ identifier: g, type: 'USER_GROUP' as const })), 'READ_ONLY');
      await emit({ stage: 'share', status: 'done' });
    } catch (e) {
      shareError = (e as Error).message;
      console.error('share with group failed:', shareError);
      await emit({ stage: 'share', status: 'error', detail: shareError });
    }
  }

  const dataSources = worksheetId ? [worksheetId] : tableId ? [tableId] : [];
  const searchUrl = tableId ? `${hostBase}/#/data/tables/${tableId}` : undefined;
  return {
    status: dataset.loaded ? 201 : 502,
    body: {
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
    },
  };
}
