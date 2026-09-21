# backend

Hono. One app, three runtimes: **Bun**, **Node**, and **Cloudflare Workers**.

```
# Bun (local dev)
cp .env.example .env      # set SPOTTER_API_KEY to a long random value
bun install
bun run dev               # http://localhost:8787, reloads on save
bun test                  # tests with coverage

# Cloudflare Worker
cp .dev.vars.example .dev.vars   # SPOTTER_API_KEY (+ optional TS_HOST/TS_TOKEN)
npm install
npm run cf:dev            # wrangler dev, http://localhost:8787
npm run deploy            # wrangler deploy

# Node (required for a SELF-SIGNED ThoughtSpot cluster — see below)
npm install
NODE_EXTRA_CA_CERTS=./cluster-ca.pem npm run node:dev   # http://localhost:8799
```

### Which runtime — the self-signed-cluster caveat

Cloudflare's `workerd` **cannot be given a custom CA for outbound `fetch`**, so
it can't call a ThoughtSpot cluster that serves a self-signed cert (both
`wrangler dev` and a deployed Worker fail with an opaque
`internal error; remote: true`). The data-load and provisioning calls go to the
cluster, so:

- **Self-signed / internal cluster** → run on **Node** with the cluster's cert
  pinned via `NODE_EXTRA_CA_CERTS`. This keeps full TLS verification on (no code
  disables it) — it just trusts that one cert. Grab the cert with:
  `echo | openssl s_client -connect <host>:<port> -showcerts 2>/dev/null | \`
  `awk '/BEGIN CERT/,/END CERT/' > cluster-ca.pem`
- **CA-signed cluster (e.g. ThoughtSpot Cloud)** → any runtime works; the
  Cloudflare Worker is fine and needs no extra CA.

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

### `POST /provision`

Idempotently create (or find) a ThoughtSpot user for a platform identity, using
the **server-held tsadmin token** — the extension never sees a TS token. Searches
by name first and only creates when absent; a generated strong password is used
so IAMv2 doesn't send an activation email, and it is never logged or returned.

Requires `TS_HOST` + `TS_TOKEN`; returns `503 not_configured` otherwise.

```jsonc
// request
{ "userid": "prashant", "platform": "tableau", "email": "…optional…" }

// 201 (created) or 200 (already existed)
{ "userid": "prashant", "platform": "tableau",
  "user": { "id": "…guid…", "name": "prashant", "display_name": "prashant (tableau)", "created": true } }
```

The username is sanitized (lowercased, safe charset) and optionally namespaced by
`TS_USER_PREFIX` (e.g. `tableau_`) to avoid clobbering real users. `/worksheet`
provisions the same way before importing, and echoes the `user` in its response.

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

### `POST /dataset`

Load real data **rows** into Falcon so Spotter can answer, then wrap the loaded
table in a worksheet. This is the searchable-data path (`/worksheet` only builds
the schema/semantic layer). Uses ThoughtSpot's internal CSV upload pipeline
(`/callosum/v1/userdata/*`) with the server-held tsadmin token, so it requires
`TS_HOST` + `TS_TOKEN` (`503 not_configured` otherwise). Provisions the user
first.

Body — JSON with one of `data` / `csv` / `csvBase64`, or multipart with a CSV
`file`:

```jsonc
{ "userid": "prashant", "platform": "tableau", "name": "Superstore",
  "data": { "columns": [{"name":"Region"},{"name":"Sales"}],
            "rows": [["East", 100], ["West", 200]] } }

// 201 response
{ "userid": "prashant", "platform": "tableau",
  "user": { "id": "…", "name": "prashant", "created": false },
  "dataset": { "tableId": "…", "tableName": "…", "worksheetId": "…",
               "columns": [ … ], "loaded": true },
  "embed": { "dataSources": ["…worksheetId or tableId…"], "worksheetId": "…" },
  "searchUrl": "https://…" }
```

The extension points `SpotterEmbed({ worksheetId })` (or `dataSources`) at
`embed`. `loaded: false` returns `502` with the load `errors`.

### `DELETE /dataset/:tableId`

Delete an uploaded dataset (Falcon table) by GUID — the "delete the spreadsheet"
action. `204` on success, `503` if TS isn't configured.

### `GET /session/:id`

Returns the full session including rows, or `404` once it has expired.

### `DELETE /session/:id`

Removes a session. `204` on success.

## Errors

`{ "error": "<code>" }` with `invalid_json`, `invalid_request` (plus a
`detail` string), `unauthorized`, `rate_limited`, `payload_too_large`,
`not_found`, `internal_error`.
