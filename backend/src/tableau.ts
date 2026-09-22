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
  /** The source tool's number format string, translated on the way into TML so
   *  a measure keeps its currency, percentage or decimals. */
  format?: string;
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

// ── Workbook structure (dashboards → worksheets → chart) ────────────────────
// The flat column parser above is enough to build a data model, but a faithful
// liveboard must mirror the workbook's tabs (dashboards) and each tab's charts
// (worksheets). This reads that structure straight from the .twb XML.

export interface WorksheetViz {
  /** Tableau mark class: Bar, Line, Area, Circle, Square, Multipolygon, Automatic… */
  mark: string;
  /** Field names referenced on the rows/cols shelves, in shelf order. */
  fields: string[];
  /** Field names used as categorical filters on this worksheet. */
  filters: string[];
}

export interface DashboardSpec {
  name: string;
  /** Worksheet names placed on this dashboard, in first-seen order. */
  worksheets: string[];
}

export interface WorkbookStructure {
  dashboards: DashboardSpec[];
  worksheets: Record<string, WorksheetViz>;
}

// Grab every <tag ... name='X'> … </tag> block. Worksheets and dashboards never
// nest inside their own kind, so a plain indexOf to the close tag is safe.
function namedBlocks(xml: string, tag: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const open = new RegExp(`<${tag}\\b[^>]*?\\bname='([^']*)'[^>]*?>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = open.exec(xml))) {
    const start = m.index + m[0].length;
    const close = xml.indexOf(`</${tag}>`, start);
    out.push({ name: m[1] ?? '', body: close === -1 ? '' : xml.slice(start, close) });
  }
  return out;
}

// Pull user-facing field names out of a rows/cols shelf string. Shelf tokens look
// like `[federated.<id>].[<agg>:<Field>:<suffix>]`, `[<Field>]`, or `[:Measure
// Names]`. Keep the human field name; drop datasource ids, internals, calcs.
function shelfFields(shelf: string): string[] {
  const out: string[] = [];
  const re = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(shelf))) {
    const inner = m[1];
    if (!inner || /^federated\./i.test(inner) || inner.startsWith('__') || inner.startsWith(':')) continue;
    const parts = inner.split(':');
    // `<agg>:<Field>:<suffix>` -> Field (second-to-last); plain `[Field]` -> Field.
    const name = ((parts.length >= 3 ? parts[parts.length - 2] : inner) ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export function parseWorkbookStructure(xml: string): WorkbookStructure {
  const worksheets: Record<string, WorksheetViz> = {};
  for (const { name, body } of namedBlocks(xml, 'worksheet')) {
    const mark = (body.match(/<mark\b[^>]*\bclass='([^']*)'/) || [])[1] || 'Automatic';
    const shelves = [
      ...body.matchAll(/<rows>([\s\S]*?)<\/rows>/g),
      ...body.matchAll(/<cols>([\s\S]*?)<\/cols>/g),
    ].map((x) => x[1] ?? '').join(' ');
    // Categorical filters the workbook author put on this worksheet.
    const filterCols = [...body.matchAll(/<filter class='categorical' column='([^']*)'/g)].map((m) => m[1] ?? '').join(' ');
    worksheets[name] = { mark, fields: shelfFields(shelves), filters: shelfFields(filterCols) };
  }

  const wsNames = new Set(Object.keys(worksheets));
  const dashboards: DashboardSpec[] = [];
  for (const { name, body } of namedBlocks(xml, 'dashboard')) {
    const seen = new Set<string>();
    const list: string[] = [];
    const zre = /\bname='([^']*)'/g;
    let z: RegExpExecArray | null;
    while ((z = zre.exec(body))) {
      const w = z[1];
      if (w && wsNames.has(w) && !seen.has(w)) { seen.add(w); list.push(w); }
    }
    dashboards.push({ name, worksheets: list });
  }
  return { dashboards, worksheets };
}
