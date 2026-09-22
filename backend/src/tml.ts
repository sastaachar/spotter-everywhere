// Generate ThoughtSpot TML (a table + a worksheet on top) from a column schema.
// NOTE: TML shape varies by cluster version — validate against the target
// cluster's tml/export output before relying on import.
import type { Column } from './tableau';

export interface GeneratedTml {
  tableName: string;
  worksheetName: string;
  tableTml: string;
  worksheetTml: string;
}

const q = (s: string): string => s.replace(/"/g, '\\"');

const DB_NAME = 'spotter_everywhere';
const SCHEMA_NAME = 'falcon_default_schema';

export function generateTml(name: string, columns: Column[]): GeneratedTml {
  const tableName = `${name} Table`;

  const tableCols = columns.map((c) => [
    `    - name: "${q(c.name)}"`,
    `      db_column_name: ${c.id}`,
    '      properties:',
    `        column_type: ${c.type}`,
    '      db_column_properties:',
    `        data_type: ${c.dataType}`,
  ].join('\n')).join('\n');

  // Falcon tables require db + schema; without them import fails with
  // "db cannot be left empty for falcon table".
  const tableTml = [
    'table:',
    `  name: "${q(tableName)}"`,
    `  db: ${DB_NAME}`,
    `  schema: ${SCHEMA_NAME}`,
    `  db_table: ${slugId(tableName)}`,
    '  columns:',
    tableCols,
    '',
  ].join('\n');

  // A worksheet column references a TABLE PATH alias (<ALIAS>::<Column Name>),
  // never the table name — that is what a real tml/export emits, and without
  // the table_paths block every column fails with "Model/Worksheet columns use
  // invalid table columns". Same shape as generateWorksheetOnTable below.
  const alias = `${tableName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'T'}_1`;

  const wsCols = columns.map((c) => [
    `    - name: "${q(c.name)}"`,
    `      column_id: "${q(alias)}::${q(c.name)}"`,
    '      properties:',
    `        column_type: ${c.type}`,
  ].join('\n')).join('\n');

  const worksheetTml = [
    'worksheet:',
    `  name: "${q(name)}"`,
    '  tables:',
    `    - name: "${q(tableName)}"`,
    '  table_paths:',
    `    - id: "${q(alias)}"`,
    `      table: "${q(tableName)}"`,
    '      join_path:',
    '      - {}',
    '  worksheet_columns:',
    wsCols,
    '',
  ].join('\n');

  return { tableName, worksheetName: name, tableTml, worksheetTml };
}

const slugId = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table';

// Build a Liveboard TML on top of a worksheet: a table viz of everything, plus
// one column-chart per measure broken down by the first attribute. TML shape is
// version-sensitive — validate against the target cluster's tml/export.
const MAX_CHART_VIZ = 6;

export function generateLiveboardTml(name: string, worksheetName: string, columns: Column[]): string {
  const attrs = columns.filter((c) => c.type === 'ATTRIBUTE');
  const measures = columns.filter((c) => c.type === 'MEASURE');
  const dim = attrs[0];

  const answerCols = (names: string[]): string[] => ['      answer_columns:', ...names.map((n) => `      - name: "${q(n)}"`)];

  const viz = (id: string, title: string, query: string, colNames: string[], chart?: string): string[] => {
    const block = [
      `  - id: ${id}`,
      '    answer:',
      `      name: "${q(title)}"`,
      '      tables:',
      `      - name: "${q(worksheetName)}"`,
      `      search_query: "${q(query)}"`,
      ...answerCols(colNames),
    ];
    if (chart) {
      block.push('      chart:', `        type: ${chart}`);
    } else {
      block.push('      display_mode: TABLE_MODE');
    }
    return block;
  };

  const vizzes: string[][] = [];
  const allNames = columns.map((c) => c.name);
  vizzes.push(viz('Viz_1', `${name} — all data`, allNames.map((n) => `[${n}]`).join(' '), allNames));

  if (dim) {
    for (const m of measures.slice(0, MAX_CHART_VIZ)) {
      vizzes.push(
        viz(`Viz_${vizzes.length + 1}`, `${m.name} by ${dim.name}`, `[${dim.name}] [${m.name}]`, [dim.name, m.name], 'COLUMN')
      );
    }
  }

  const tiles = vizzes.map((_, i) => [`    - visualization_id: Viz_${i + 1}`, '      size: MEDIUM']).flat();

  return [
    'liveboard:',
    `  name: "${q(name)}"`,
    '  visualizations:',
    ...vizzes.flat(),
    '  layout:',
    '    tiles:',
    ...tiles,
    '',
  ].join('\n');
}

/** One loaded source behind a liveboard tile: a worksheet plus its columns. */
export interface LiveboardSource {
  /** Title to show on the tile — the source visual's own name. */
  title: string;
  /** Worksheet the tile answers from. */
  worksheetName: string;
  columns: Column[];
}

/**
 * Build a Liveboard TML spanning several worksheets — one tile per source, so a
 * report's liveboard mirrors the report: each visual becomes a visualization
 * answering from the worksheet loaded with that visual's own rows.
 *
 * A source with both a dimension and measures renders as a column chart, the
 * way the visual it came from does; anything else falls back to a table. TML
 * shape is version-sensitive — validate against the target cluster's
 * tml/export.
 */
export function generateLiveboardOverSources(name: string, sources: LiveboardSource[]): string {
  const vizzes: string[][] = [];

  sources.forEach((source, index) => {
    const id = `Viz_${index + 1}`;
    const attrs = source.columns.filter((c) => c.type === 'ATTRIBUTE');
    const measures = source.columns.filter((c) => c.type === 'MEASURE');
    const dim = attrs[0];
    // Keep a tile readable: one dimension and a few measures, not every column.
    const charted = dim ? measures.slice(0, 3) : [];
    const names = dim && charted.length
      ? [dim.name, ...charted.map((m) => m.name)]
      : source.columns.map((c) => c.name);

    const block = [
      `  - id: ${id}`,
      '    answer:',
      `      name: "${q(source.title)}"`,
      '      tables:',
      `      - name: "${q(source.worksheetName)}"`,
      `      search_query: "${q(names.map((n) => `[${n}]`).join(' '))}"`,
      '      answer_columns:',
      ...names.map((n) => `      - name: "${q(n)}"`),
    ];
    if (dim && charted.length) block.push('      chart:', '        type: COLUMN');
    else block.push('      display_mode: TABLE_MODE');
    vizzes.push(block);
  });

  const tiles = vizzes.map((_, i) => [`    - visualization_id: Viz_${i + 1}`, '      size: MEDIUM']).flat();

  return [
    'liveboard:',
    `  name: "${q(name)}"`,
    '  visualizations:',
    ...vizzes.flat(),
    '  layout:',
    '    tiles:',
    ...tiles,
    '',
  ].join('\n');
}

// Falcon numeric types default to measures; everything else to attributes.
const MEASURE_TYPES = new Set(['INT64', 'INT32', 'DOUBLE', 'FLOAT', 'DECIMAL']);
function columnTypeFor(dataType?: string): 'MEASURE' | 'ATTRIBUTE' {
  return dataType && MEASURE_TYPES.has(dataType.toUpperCase()) ? 'MEASURE' : 'ATTRIBUTE';
}

export interface UploadedColumn {
  logicalName?: string;
  physicalName?: string;
  name?: string;
  dataType?: string;
}

/**
 * Generate a worksheet TML that sits on top of an already-uploaded table.
 * A worksheet over an EXISTING table needs a `table_paths` alias, and the
 * worksheet columns reference that alias (`<ALIAS>::<COLUMN>`), not the table
 * name — matching a real `tml/export` of a worksheet.
 */
export function generateWorksheetOnTable(
  worksheetName: string,
  tableName: string,
  columns: UploadedColumn[],
): string {
  const alias = `${tableName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'T'}_1`;

  const cols = columns
    .map((c) => ({
      name: c.logicalName ?? c.name ?? '',
      dbName: c.physicalName ?? c.logicalName ?? c.name ?? '',
      dataType: c.dataType,
    }))
    .filter((c) => c.name);

  const wsCols = cols
    .map((c) => [
      `  - name: "${q(c.name)}"`,
      `    column_id: "${q(alias)}::${q(c.dbName)}"`,
      '    properties:',
      `      column_type: ${columnTypeFor(c.dataType)}`,
    ].join('\n'))
    .join('\n');

  return [
    'worksheet:',
    `  name: "${q(worksheetName)}"`,
    '  tables:',
    `  - name: "${q(tableName)}"`,
    '  table_paths:',
    `  - id: "${q(alias)}"`,
    `    table: "${q(tableName)}"`,
    '    join_path:',
    '    - {}',
    '  worksheet_columns:',
    wsCols,
    '',
  ].join('\n');
}
