# ui/spotter-embed

The shared extension UI: the Spotter panel every extension opens on top of the
host BI tool. Plain ES modules, no framework, no build step. Renders into a
shadow root so host CSS and panel CSS never touch.

```js
import { TableauSpotterEmbed } from '../../ui/spotter-embed/index.js';

const embed = new TableauSpotterEmbed({
  loadData: (kind, context) => requestWorksheetData(context.worksheet, kind), // 'summary' | 'underlying'
  sendSession: (payload) => postToBackend(payload),                            // -> { id, url? }
});
embed.open(context);   // context: the identifiers the extension collected
embed.close();
```

`TableauSpotterEmbed` and `PowerBiSpotterEmbed` are `SpotterEmbed` with the
matching config from `../configs` applied. Use `new SpotterEmbed(config, hooks)`
directly for a new platform.

## Config (`../configs/*-config.js`)

| Key | Purpose |
| --- | --- |
| `platform` | id sent to the backend, e.g. `tableau` |
| `label` | shown in the panel header |
| `accent` | button and border colour |
| `subject(context)` | what the data is about, used in loading text |
| `contextRows` | `[label, key or fn(context)]` pairs shown at the top |
| `dataKinds` | `['summary']` or `['summary', 'underlying']` |
| `underlyingCap` | row cap the host API imposes, flagged in the note |

## Hooks

| Hook | Called | Returns |
| --- | --- | --- |
| `loadData(kind, context)` | on open (`summary`) and on the underlying button | `{ columns:[{name,type}], rows, totalRows?, filters?, parameters?, selectedMarks? }` |
| `sendSession(payload)` | on the send button | `{ id, url? }` or throws |
| `buildPayload(context, summary, underlying)` | optional override of the default backend payload | `{ platform, context, data }` |
| `mount` | optional element to append the host to, default `document.body` | |

Loading it from a content script: MV3 content scripts are classic scripts, so
either bundle this folder into the extension or expose it via
`web_accessible_resources` and `import(chrome.runtime.getURL(...))`.
