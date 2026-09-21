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

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, scoped to the one Tableau host, all frames |
| `content.js` | Finds title elements, injects the button, renders the panel |
| `content.css` | Button and panel styles, namespaced with `ts-spotter-` |

## Notes

- No background service worker, storage, or network calls yet. The extension
  reads only the sheet title text from the DOM.
- If the title path changes in a Tableau release, update `TITLE_TEXT_PATH` in
  `content.js`.
