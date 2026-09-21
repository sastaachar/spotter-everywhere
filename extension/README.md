# extension

One Chrome extension (MV3) that adds a ThoughtSpot Spotter button to **Tableau**
and **Power BI**, choosing the per-site code by the host it loads on. Load this
folder unpacked; there is no per-platform extension anymore.

## Layout

| Path | What |
| --- | --- |
| `manifest.json` | One manifest, both hosts. A pinned `key` fixes the extension id to `ldkdonidkbcdeooapflpgbbicgiehnaa` regardless of path. |
| `platforms/tableau/`, `platforms/powerbi/` | `content.js` + `bridge.js` + `content.css` per site; the manifest injects the set that matches the current host. |
| `background.js` | Shared service worker (module); posts sessions to the backend from `src/config.js`. |
| `panel.html`, `src/panel.js` | Shared Spotter panel; picks `TableauSpotterEmbed` or `PowerBiSpotterEmbed` from the `platform` in the panel context. Built to `dist/panel.js`. |
| `src/config.js` | Backend URL. Committed, non-secret. |
| `src/dev-credentials.js` | Secrets: ThoughtSpot username/password and the backend API key (gitignored; created from `.example` on build). |
| `scripts/allow-embed.sh` | Fallback CSP/CORS opener; prefer the Nebula MCP (see below). |

## Build and load

```
npm install --prefix ../ui/spotter-embed   # the embed SDK the panel bundles
npm install                                # esbuild
npm run build                              # -> dist/panel.js
```

Both installs are needed: the first provides the SDK, the second the bundler.
Without them `dist/panel.js` is missing and the panel opens blank.

Then load `extension/` unpacked at `chrome://extensions`. Rebuild after editing
`src/panel.js`; the platform `content.js`/`bridge.js` are plain scripts and need
only an extension reload.

## Per cluster, once

The ThoughtSpot iframe sits inside our extension panel, which sits inside the BI
page, and `frame-ancestors` checks the whole chain — so **both** origins must be
allowed:

```
chrome-extension://ldkdonidkbcdeooapflpgbbicgiehnaa
https://app.powerbi.com          (and the Tableau host for Tableau)
```

Add them in Develop -> Customizations -> Security Settings. That field builds
`frame-ancestors` and normally validates entries as hostnames, so a
`chrome-extension://` origin may be refused there; `tscli csp add-override
--source frame-ancestors --url '<origin>'` takes it either way (see
`scripts/allow-embed.sh`). Avoid a bare `*` in that list — it would let any site
on the internet frame the cluster.

Confirm with the cluster's live header:

```
curl -s -D - -o /dev/null https://<cluster>/ | tr ';' '\n' | grep -i frame-ancestors
```

CORS needs nothing: the extension's fetches go through the service worker, which
is exempt via `host_permissions`.

## Backend, for the data path

The Spotter button opens the panel with no backend. Building a worksheet from a
visual's rows (alt+click -> *Create Spotter worksheet*) needs `backend/` running:

```
cd ../backend && cp .dev.vars.example .dev.vars   # set SPOTTER_API_KEY, TS_HOST, TS_TOKEN
npm install && npm run node:dev                   # http://localhost:8799
```

Put the same `SPOTTER_API_KEY` in `src/dev-credentials.js` as `backendApiKey`,
and keep `backendUrl` in `src/config.js` pointing at it.

`/dataset` loads the rows into the cluster via its CSV upload pipeline, so the
**cluster needs a data connection configured**. Without one it returns
`No dataSource is configured to upload a CSV file` and no worksheet is built.
