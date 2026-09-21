# Tableau Spotter extension

Chrome (MV3) extension that adds a **Spotter** button next to every sheet title on
`https://prod-in-a.online.tableau.com/`.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Reload any open Tableau tab.

## How the button is placed

The requested location was the XPath

```
//*[@id="title17304515934672478925_10296963834907466154"]/div[1]/div/span/div
```

Tableau regenerates the numeric part of that id on every load, so the content
script matches `id^="title"` plus the shape `title\d+_\d+`, then walks the same
`div[1]/div/span/div` path and appends the button inside the title text
container. A `MutationObserver` re-runs the scan whenever Tableau re-renders,
so the button survives sheet switches and dashboard interactions.

## Clicking the button

Opens a right-hand panel stub showing the sheet title, and dispatches a
`spotter:open` `CustomEvent` on `document` with `{ sheetTitle, url }`. Wire the
real Spotter experience into `openPanel()` in `content.js`, or listen for the
event from another script.

## Data bridge

Tableau's portal page loads its own JavaScript API and keeps a live viz object
in the page's main world. `bridge.js` runs there (`world: "MAIN"`, top frame
only) and answers `spotter:request` messages from the viz iframe with the
worksheet's summary data, columns, filters, parameters and selection count via
`getSummaryDataAsync` and friends. The panel renders the shape and the full row
table. No network interception, no extra authentication: it rides the session
the portal already has. Outside the portal page (a bare `:embed=y` view) the
bridge is absent and the panel says so.

## Sending to the backend

The panel's "Send to Spotter backend" button posts the viz context plus the
loaded data (underlying rows if you loaded them, otherwise summary rows) to
`POST /session` on the backend in `../../backend`. Content scripts cannot make
cross-origin requests, so the post goes through `background.js`, the service
worker, which reads the backend URL and API key from `chrome.storage.local`.
Set both on the extension's options page (`chrome://extensions` → Details →
Extension options). The URL must be https, except `localhost` for development.
`host_permissions` lists `http://localhost:8787/*` for that; add your deployed
backend origin there when you have one.

Nothing from Tableau's session (cookies, XSRF token, auth headers) is included
in the payload.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, scoped to the one Tableau host, all frames |
| `content.js` | Finds title elements, injects the button, renders the panel, asks the bridge for data |
| `bridge.js` | MAIN-world script in the portal page; reads worksheet data through Tableau's JS API |
| `background.js` | Service worker; posts sessions to the backend with the stored API key |
| `options.html`, `options.js` | Settings page for backend URL and API key |
| `content.css` | Button and panel styles, namespaced with `ts-spotter-` |

## Development loop

Content scripts are copied into a page at load time, so edits on disk do not
reach open tabs. After changing `content.js` or `content.css`, click Reload on
the extension card at `chrome://extensions`, then refresh the Tableau tab.
Manifest changes always need the extension reload.

The button is injected into the `:embed=y` viz iframe (same host as the portal
page), which `all_frames: true` covers. Tableau rewrites the title's inner text
region during bootstrap, after `document_idle`, so injection is gated on the
button actually being present rather than on a one-time marker. The script logs
`[Tableau Spotter] content script loaded in <url>` in the frame's console
context so you can confirm it ran.

## Notes

- No background service worker, storage, or network calls yet. The extension
  reads only the sheet title text from the DOM.
- If the title path changes in a Tableau release, update `TITLE_TEXT_PATH` in
  `content.js`.
