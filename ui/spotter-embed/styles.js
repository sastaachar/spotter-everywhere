export const STYLES = `
:host {
  all: initial;
  --accent: #2770ef;
  --text: #1a1a1a;
  --muted: #666;
  --border: #e0e0e0;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.panel {
  position: fixed;
  top: 0;
  right: 0;
  width: 520px;
  max-width: 90vw;
  height: 100vh;
  box-sizing: border-box;
  padding: 16px;
  background: #fff;
  border-left: 1px solid var(--border);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.08);
  font: 14px/20px var(--font);
  color: var(--text);
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}
header .platform {
  margin-left: 8px;
  font-weight: 400;
  color: var(--muted);
  font-size: 12px;
}
.close {
  all: initial;
  cursor: pointer;
  font: 18px/1 sans-serif;
  color: var(--muted);
  padding: 4px;
}
.rows {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: 12px;
}
.rows dt { color: var(--muted); white-space: nowrap; }
.rows dd {
  margin: 0;
  color: var(--text);
  font-family: var(--mono);
  overflow-wrap: anywhere;
  user-select: text;
  white-space: pre-line;
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  font-size: 12px;
  color: #444;
}
h3 {
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 11px;
  font-family: var(--mono);
}
th, td {
  border-bottom: 1px solid #eee;
  padding: 3px 6px;
  text-align: left;
  white-space: nowrap;
  vertical-align: top;
}
th { position: sticky; top: 0; background: #f7f7f7; font-weight: 600; }
.rownum { color: #999; }
.action {
  all: initial;
  display: block;
  margin: 8px 0;
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 12px;
  background: #fff;
  color: var(--accent);
  font: 500 12px/16px var(--font);
  cursor: pointer;
}
.action:disabled { color: #999; border-color: #ccc; cursor: default; }
.note { margin: 4px 0; font-size: 11px; color: var(--muted); }
.error { color: #b3261e; }
`;
