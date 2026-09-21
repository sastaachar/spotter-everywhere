# backend

Hono. Runs on **Bun** (local) and **Cloudflare Workers** (deploy) from the same
app — in-memory session store.

```
# Bun (local dev)
cp .env.example .env      # set SPOTTER_API_KEY to a long random value
bun install
bun run dev               # http://localhost:8787, reloads on save
bun test                  # tests with coverage

# Cloudflare Worker (the deploy target)
cp .dev.vars.example .dev.vars   # SPOTTER_API_KEY (+ optional TS_HOST/TS_TOKEN)
npm install
npm run cf:dev            # wrangler dev, http://localhost:8787
npm run deploy            # wrangler deploy
```

### Deploy / sync with Cloudflare

The Worker entry is `src/worker.ts` + `wrangler.toml` (`nodejs_compat` on). Two
ways to run it as your Worker:

1. **CLI:** `npx wrangler secret put SPOTTER_API_KEY` (and `TS_TOKEN` if
   importing), set `TS_HOST` in `wrangler.toml [vars]`, then `npm run deploy`.
2. **Git-synced (Workers Builds):** in the Cloudflare dashboard → Workers &
   Pages → Create → **Connect to Git**, pick this repo, set **root directory**
   to `backend/`, build `npm install`, deploy `npx wrangler deploy`. Every push
   redeploys. Add `SPOTTER_API_KEY` / `TS_TOKEN` as Worker secrets in the
   dashboard.

Every route requires `Authorization: Bearer <SPOTTER_API_KEY>` and is rate
limited to 120 requests per minute per client address. Bodies are capped at
32 MB. Sessions live for one hour, at most 1000 at a time.

## Routes

### `POST /session`

Creates a session from whatever the extension collected on the current
platform. The body shape is the same for every platform; `platform` says which
one and `context` carries that platform's identifiers.

```json
{
  "platform": "tableau",
  "context": {
    "site": "acme",
    "workbook": "Superstore",
    "dashboard": "Overview",
    "worksheet": "Total Sales",
    "zoneId": 32
  },
  "data": {
    "columns": [{ "name": "Measure Names", "type": "string" }, { "name": "Measure Values", "type": "float" }],
    "rows": [["Quantity", "38,654.00"]],
    "totalRows": 1
  }
}
```

| Field | Rules |
| --- | --- |
| `platform` | lowercase identifier, e.g. `tableau`, `powerbi`, `looker` |
| `context` | flat object, up to 100 keys, values string/number/boolean/null |
| `data` | optional; `columns` 1–500, `rows` up to 20,000, every row as wide as `columns` |

Returns `201` with the session summary (no rows) and a `Location` header.

### `POST /worksheet`

Turn a Tableau workbook into a Spotter-searchable worksheet. The extension
sends the workbook file plus who/where it came from; the backend parses the
fields (dimensions → attributes, measures → measures), generates ThoughtSpot
**TML** (a table + a worksheet), and — when `TS_HOST` + `TS_TOKEN` are set —
imports it and returns the worksheet id + a search URL the extension can open.

Two body shapes:

- **multipart/form-data**: fields `userid`, `platform`, `file` (the `.twb` /
  `.twbx` / `.tds` / `.tdsx`).
- **application/json**: `{ "userid", "platform", "filename", "fileBase64" }`.

```jsonc
// 201 response
{
  "userid": "prashant",
  "platform": "tableau",
  "worksheet": {
    "name": "prashant · tableau · Superstore",
    "columns": [
      { "id": "region", "name": "Region", "type": "ATTRIBUTE", "dataType": "VARCHAR" },
      { "id": "sales",  "name": "Sales",  "type": "MEASURE",   "dataType": "DOUBLE" }
    ]
  },
  "worksheetId": "…",         // present only when imported
  "searchUrl": "https://…",   // present only when imported
  "imported": false,
  "tml": { "tableTml": "…", "worksheetTml": "…" }
}
```

`.twbx`/`.tdsx` (zips) are unpacked in-process; `.twb`/`.tds` are read as XML.
**Note:** this builds the worksheet's *semantic layer*; loading the actual data
**rows** still needs the cluster's data-upload path (see the CSV note in the
sibling `spotter-worksheet-api`).

### `GET /session/:id`

Returns the full session including rows, or `404` once it has expired.

### `DELETE /session/:id`

Removes a session. `204` on success.

## Errors

`{ "error": "<code>" }` with `invalid_json`, `invalid_request` (plus a
`detail` string), `unauthorized`, `rate_limited`, `payload_too_large`,
`not_found`, `internal_error`.
