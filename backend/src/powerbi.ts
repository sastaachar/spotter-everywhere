// Parse a Power BI TMDL semantic model into the same Column schema the Tableau
// parser produces, so both feed one TML generator. TMDL is the text modeling
// language Power BI exports (table/column/measure blocks).
import type { Column } from './tableau';

const MAP: Record<string, Column['dataType']> = {
  int64: 'INT64', double: 'DOUBLE', decimal: 'DOUBLE',
  string: 'VARCHAR', datetime: 'DATE', date: 'DATE', boolean: 'BOOL',
};
const NUMERIC = new Set(['int64', 'double', 'decimal']);
const SAFE_NAME = /^[^[\]()::%]+$/;
const DECL = /^\s*(column|measure)\s+(?:'([^']+)'|"([^"]+)"|([^\s=]+))/;

const slug = (name: string, i: number): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col_${i}`;

export function parseTmdlColumns(tmdl: string): Column[] {
  const lines = tmdl.split(/\r?\n/);
  const out: Column[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i] ?? '');
    if (!m) continue;
    const kind = m[1];
    const name = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!name || seen.has(name) || /^RowNumber/i.test(name)) continue;
    if (!SAFE_NAME.test(name) || /\slabel$/i.test(name)) continue;

    let dt = '';
    let isCalculated = false;
    for (let j = i + 1; j < Math.min(lines.length, i + 25); j++) {
      const ln = lines[j] ?? '';
      if (DECL.test(ln)) break; // next column/measure
      const d = /^\s*dataType:\s*(\w+)/i.exec(ln);
      if (d) dt = (d[1] ?? '').toLowerCase();
      if (/^\s*(type:\s*calculated|expression:|source(Column)?:\s*=)/i.test(ln) && kind === 'column') isCalculated = true;
    }
    if (isCalculated) continue; // calculated column — skip like Tableau calc fields

    seen.add(name);
    const numeric = NUMERIC.has(dt);
    const type: Column['type'] = kind === 'measure' || numeric ? 'MEASURE' : 'ATTRIBUTE';
    out.push({ id: slug(name, out.length), name, type, dataType: MAP[dt] ?? 'VARCHAR' });
  }
  return out;
}
