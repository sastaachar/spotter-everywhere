// Parse a Tableau workbook/datasource into a ThoughtSpot-style column schema.
// Accepts raw .twb/.tds XML, or packaged .twbx/.tdsx (a zip containing one).
// Pure JS (fflate + fast-xml-parser) so it runs on both Bun and Cloudflare Workers.
import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

export interface Column {
  id: string;
  name: string;
  type: 'ATTRIBUTE' | 'MEASURE';
  dataType: 'VARCHAR' | 'INT64' | 'DOUBLE' | 'DATE' | 'BOOL';
}

const DATATYPE: Record<string, Column['dataType']> = {
  string: 'VARCHAR', integer: 'INT64', real: 'DOUBLE',
  date: 'DATE', datetime: 'DATE', boolean: 'BOOL',
};

/** Return the .twb/.tds XML text from raw XML bytes or a packaged zip. */
export function extractTwbXml(bytes: Uint8Array): string {
  const isZip = bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
  if (!isZip) return strFromU8(bytes);
  const files = unzipSync(bytes);
  const key = Object.keys(files).find((k) => /\.(twb|tds)$/i.test(k));
  const entry = key ? files[key] : undefined;
  if (!entry) throw new Error('No .twb/.tds found inside the packaged file.');
  return strFromU8(entry);
}

const clean = (s: string): string => s.replace(/^\[|\]$/g, '').trim();
const idOf = (name: string, i: number): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `col_${i}`;

/** Pull the user-facing fields (dimensions/measures) out of a Tableau XML doc. */
export function parseTableauColumns(xml: string): Column[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(xml);

  const out: Column[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'column') {
        const cols = Array.isArray(value) ? value : [value];
        for (const raw of cols) {
          const c = raw as Record<string, string>;
          const rawName = String(c['@_name'] ?? '');
          if (rawName.startsWith('[:')) continue; // Tableau-internal
          const name = c['@_caption'] || (rawName ? clean(rawName) : '');
          if (!name || seen.has(name)) continue;
          seen.add(name);
          const role = (c['@_role'] ?? '').toLowerCase();
          const dt = (c['@_datatype'] ?? '').toLowerCase();
          out.push({
            id: idOf(name, out.length),
            name,
            type: role === 'measure' ? 'MEASURE' : 'ATTRIBUTE',
            dataType: DATATYPE[dt] ?? 'VARCHAR',
          });
        }
      } else if (typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(doc);
  return out;
}
