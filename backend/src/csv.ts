// Build RFC-4180 CSV from columns + rows. Portable across Bun + Cloudflare
// Workers (no Node APIs). Used to hand the viz's actual rows to ThoughtSpot's
// CSV upload pipeline so Spotter can answer over real data.

export interface DataColumn {
  name: string;
  type?: string;
}

function escapeCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** header row + data rows, CRLF-safe. Empty rows still emit the header line. */
export function rowsToCsv(columns: DataColumn[], rows: unknown[][]): string {
  const header = columns.map((c) => escapeCell(c.name)).join(',');
  const body = rows.map((r) => r.map(escapeCell).join(',')).join('\n');
  return body ? `${header}\n${body}` : header;
}
