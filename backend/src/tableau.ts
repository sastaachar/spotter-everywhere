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

const NUMERIC = new Set(['integer', 'real']);
// A name that is safe as a ThoughtSpot `[token]`: no brackets/parens/colons that
// would break the search query. Formula and calc/param names fail this.
const SAFE_NAME = /^[^[\]()::%]+$/;
const looksLikeId = (n: string): boolean => /(^|[\s_])id$/i.test(n) || /postal\s*code/i.test(n);

/**
 * Pull the real, user-facing physical fields out of a Tableau XML doc. Drops
 * calculated fields, parameters, hidden and Tableau-internal columns, and
 * anything whose name would not survive a ThoughtSpot search query. Numeric
 * fields become measures (unless they look like ids), everything else an
 * attribute — the `role` flag alone is unreliable in real workbooks.
 */
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
          if (!raw || typeof raw !== 'object') continue;
          const c = raw as Record<string, unknown>;
          const rawName = String(c['@_name'] ?? '');
          if (rawName.startsWith('[:')) continue; // Tableau-internal
          if ('calculation' in c) continue; // calculated field
          if (c['@_param-domain-type'] != null) continue; // parameter
          if (String(c['@_hidden']).toLowerCase() === 'true') continue;
          if (/^Calculation_/.test(rawName)) continue;

          const name = String(c['@_caption'] ?? '') || (rawName ? clean(rawName) : '');
          if (!name || seen.has(name)) continue;
          if (!SAFE_NAME.test(name)) continue; // formula/label/derived name
          if (/\slabel$/i.test(name)) continue;
          seen.add(name);

          const dt = String(c['@_datatype'] ?? '').toLowerCase();
          const role = String(c['@_role'] ?? '').toLowerCase();
          const numeric = NUMERIC.has(dt);
          const type: Column['type'] = (numeric && !looksLikeId(name)) || role === 'measure' ? 'MEASURE' : 'ATTRIBUTE';
          out.push({ id: idOf(name, out.length), name, type, dataType: DATATYPE[dt] ?? 'VARCHAR' });
        }
      } else if (typeof value === 'object') {
        visit(value);
      }
    }
  };
  visit(doc);
  return out;
}
