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
| `src/config.js` | Backend URL and API key. No options page. |
| `src/dev-credentials.js` | ThoughtSpot username/password for dev (gitignored; created from `.example` on build). |
| `scripts/allow-embed.sh` | Fallback CSP/CORS opener; prefer the Nebula MCP (see below). |

## Build and load

```
cd extension && bun install --cwd ../ui/spotter-embed   # SDK for the panel bundle
bun run build                                            # -> dist/panel.js
```

Then load `extension/` unpacked at `chrome://extensions`. Rebuild after editing
`src/panel.js`; the platform `content.js`/`bridge.js` are plain scripts and need
only an extension reload.

## Per cluster, once

Allow the extension and the host BI origins to frame the cluster, via the Nebula
MCP (it holds the cluster admin SSH key; a laptop does not):

```
cluster_embed_allow(host="10.79.138.0", origin="chrome-extension://ldkdonidkbcdeooapflpgbbicgiehnaa", port=443)
cluster_embed_allow(host="10.79.138.0", origin="https://prod-in-a.online.tableau.com", port=443)
cluster_embed_allow(host="10.79.138.0", origin="https://app.powerbi.com", port=443)
```

Its self-signed-cert verification error is cosmetic; the change still applies.
Confirm by reading the cluster's live CSP `frame-ancestors`.
