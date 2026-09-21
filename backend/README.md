# backend

Hono on Bun. One runtime dependency, no build step, in-memory session store.

```
cp .env.example .env      # set SPOTTER_API_KEY to a long random value
bun install
bun run dev               # http://localhost:8787, reloads on save
bun test                  # tests with coverage
bun run typecheck
```

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

### `GET /session/:id`

Returns the full session including rows, or `404` once it has expired.

### `DELETE /session/:id`

Removes a session. `204` on success.

### `GET /token`

Exchanges the ThoughtSpot username and password from the environment for a
cookieless trusted-auth token via `POST /api/rest/2.0/auth/token/full` on
`THOUGHTSPOT_HOST`, valid for five minutes. Returns
`{ "token", "expiresAt", "host" }`. This is what the SDK's `getAuthToken` calls.
`503 thoughtspot_not_configured` when the env vars are missing,
`502 thoughtspot_auth_failed` when the cluster refuses; the cluster's own error
text is logged server-side only.

The username/password exchange is a development shortcut. Production should
mint with the cluster's trusted-auth secret key instead.

## Errors

`{ "error": "<code>" }` with `invalid_json`, `invalid_request` (plus a
`detail` string), `unauthorized`, `rate_limited`, `payload_too_large`,
`not_found`, `internal_error`.
