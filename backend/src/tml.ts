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
