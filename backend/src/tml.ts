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

  const tableTml = ['table:', `  name: "${q(tableName)}"`, '  columns:', tableCols, ''].join('\n');

  const wsCols = columns.map((c) => [
    `    - name: "${q(c.name)}"`,
    `      column_id: "${q(tableName)}::${c.id}"`,
    '      properties:',
    `        column_type: ${c.type}`,
  ].join('\n')).join('\n');

  const worksheetTml = [
    'worksheet:',
    `  name: "${q(name)}"`,
    '  tables:',
    `    - name: "${q(tableName)}"`,
    '  worksheet_columns:',
    wsCols,
    '',
  ].join('\n');

  return { tableName, worksheetName: name, tableTml, worksheetTml };
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
