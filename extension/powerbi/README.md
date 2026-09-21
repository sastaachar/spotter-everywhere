# Power BI Spotter extension

Chrome (MV3) extension that adds a **Spotter** button next to every report
visual title on `https://app.powerbi.com/`. Power BI sibling of the Tableau
extension in the repo root.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick **this `powerbi/` folder**, not the repo root.
4. Open a report and reload the tab.

The Tableau extension loads separately from the repo root. Both can be loaded at
the same time — they match different hosts and never run in the same page.

## How the button is placed

Verified against a live report (Regional Sales Sample) in Chrome for Testing 151.

Tableau gave us a stable XPath shape to anchor to. Power BI churns class names
between releases, so the anchor here is the title's **test id**, which is stable:

```
[data-testid="visual-title"]   title div; its `title` attribute holds the full text
  -> .visualTitleArea
    -> .visualWrapper
      -> .vcBody
        -> .visualContainer    aria-label = title, aria-roledescription = visual type
          -> transform[data-testid="visual-container"]   CSS transform = position
```

### Why the buttons live in an overlay, not in the title

Appending the button inside the title div does not work. Two things defeat it:

1. Each visual's `<transform>` host carries a CSS `transform`, which **creates a
   stacking context**. A button inside one visual can never be raised above a
   different visual, whatever its `z-index`.
2. Power BI reports overlap freely. In the sample report an Image visual sits on
   top of four KPI titles, so clicks landed on the image instead of the button.

Measured: with the button inside the title, only 3 of 9 were clickable. Raising
each visual's stacking context got that to 7 of 9 -- the rest still lost to a
sibling visual with the same `z-index` and a later DOM position.

So the buttons render into a single fixed `.ts-spotter-layer` on `<body>`
(`pointer-events: none`, max `z-index`), each absolutely positioned over its
title's `getBoundingClientRect()`. That escapes every stacking context. Positions
refresh on scroll and resize via `requestAnimationFrame`, and on each rescan.

Result: **9 of 9 clickable, 9 of 9 opening the panel.**

### Layering

A body-level layer at the maximum z-index also paints over Power BI's own
dialogs -- the licence-upgrade modal ends up with Spotter pills floating across
it. Measured values on the page:

| Element | z-index |
| --- | --- |
| report visuals (`transform` hosts) | 2000 - 33000 |
| **`.ts-spotter-layer`** | **100000** |
| Power BI dialog host (`.cdk-overlay-container`) | 10000005 |

So the layer sits above every visual and below every dialog. It is also framed
to the report canvas (`.displayAreaContainer`) with `overflow: hidden`, so a
button can never paint over the toolbar or the left nav, and it hides entirely
while a dialog is open.

The dialog check skips our own panel -- that carries `role="dialog"` too, and
matching it hid every button as soon as the panel opened.

### Other Power BI quirks handled

- Power BI's own `button` rules zero out `padding` and `border`, so those two
  declarations need `!important`.
- Only titled visuals get a button: the sample report has 33 `visual-container`
  elements but 9 visible titles.

## If no button appears

The selectors are the fragile part. The script detects this itself: if nothing
matched 8 seconds after load, it logs

```
[Power BI Spotter] no visual titles matched -- running probe
```

followed by title and transform counts and the first title's markup. Use that to
find the real anchor and update `TITLE_SELECTOR`.

To run the probe by hand, open DevTools, switch the Console's **context
dropdown** (top left, usually reading `top`) to `Power BI Spotter`, then call
`__spotterProbe()`. The context switch matters -- content scripts run in an
isolated world.

## Where the chart metadata comes from

The DOM gives a title, a visual type and geometry -- no visual id and no field
bindings. Both live in the report layout, which Power BI fetches from its
regional backend:

```
GET {wabi-host}/explore/reports/{reportKey}/exploration
Authorization: Bearer <window.powerBIAccessToken>
```

Two gotchas: the `wabi-*` host is region-specific, and `reportKey` is a numeric
id, *not* the guid in the page URL. `page.js` recovers both by reading the
request the report itself already made, out of `performance.getEntriesByType`.

### Why page.js exists

`window.powerBIAccessToken` lives in the page's JS context. Content scripts run
in an isolated world and cannot see it. So `page.js` is declared with
`"world": "MAIN"`, does the fetch under the page's own origin, and posts a
digest back over `window.postMessage`. The content script never touches the
token, and the extension needs no extra `host_permissions`.

### Matching DOM visuals to layout entries

Two passes, because neither alone is sufficient:

1. **By title**, scoped to the current section. Scoping is required -- this
   report has two different visuals both titled "Qualified Pipeline" on
   different pages, and an unscoped match returns the wrong one.
2. **By geometry**, for visuals whose title is not a literal in the layout (the
   funnel on Sales Overview). The DOM lays the canvas out at a scale factor of
   the layout coordinates, so the factor is recovered as the median `domW /
   layoutW` over the title-matched pairs, then unmatched visuals are matched to
   the nearest remaining rect within a tolerance.

Verified: 9 of 9 on Sales Overview, 6 of 6 on Pipeline Trends.

### What the panel gains

`visualId`, `visualType` (the layout's own name -- `kpi`, `funnel`, `barChart`,
`pivotTable`, `shapeMap`, `ribbonChart`), `filterCount`, and one row per field
role, e.g.

```
Visual id   90b98cca54dd8f762bb3
Visual type barChart      Filters: 1
Category    Products.Product LOB, Products.Product
Y           Opportunities.Revenue Won, Opportunities.Revenue In Pipeline
Tooltips    Opportunities.Revenue In Pipeline
```

### What is still missing

This is the query *definition*, not its results. The numbers drawn on screen
come from a separate `querydata` call. If Spotter needs actual values rather
than field names, that endpoint is the next one to reverse.

## Clicking the button

Opens a right-hand panel and dispatches a `spotter:open` `CustomEvent` on
`document` with the visual's context:

| Field | Source |
| --- | --- |
| `reportId`, `workspace`, `pageName` | URL path |
| `reportTitle` | `document.title`, with the Power BI suffix stripped |
| `visualTitle` | The title div's `title` attribute, falling back to its text |
| `visualType` | `aria-roledescription` on `.visualContainer` (KPI, Matrix, Funnel, Shape map, ...) |
| `tabOrder` | `tab-order` on `.visualContainer` -- stable per visual within a page |
| `position` | `translate(...)` from the `<transform>` host |

Power BI exposes no per-visual guid in the DOM, so `tabOrder` plus `position` is
the closest thing to a stable per-visual identifier.

Wire the real Spotter experience into `openPanel()`, or listen for the event.

## The Spotter panel

The panel's **Spotter** tab is `ui/spotter-embed`'s `PowerBiSpotterEmbed` -- the
Visual Embed SDK's `SpotterEmbed` with the Power BI theme from
`ui/configs/power-bi-config.js`. The **Data** tab keeps the query result table.

### Why it is an extension page, not injected DOM

`panel.html` is loaded in an iframe from `chrome-extension://`, not rendered
into the Power BI document, for two reasons:

- MV3 forbids remote scripts, so the SDK cannot be fetched from a CDN.
- Power BI's own CSP would block framing the ThoughtSpot host from its document.
  An extension page has its own CSP and can frame it.

`panel.html` is therefore listed in `web_accessible_resources`, scoped to
`app.powerbi.com`.

### Build step

The SDK has to ship inside the extension. There is no bundler, so
`tools/build-panel.mjs` copies the SDK's prebuilt ESM bundle and the shared
`ui/` sources into `vendor/`, rewriting the bare `@thoughtspot/visual-embed-sdk`
import to the vendored file:

```bash
node tools/build-panel.mjs      # re-run after changing ui/spotter-embed or ui/configs
```

It takes the SDK from `ui/spotter-embed/node_modules` when present, otherwise a
`visual-embed-sdk` checkout beside the repo, and warns if the version does not
match the pin in `ui/spotter-embed/package.json`. `vendor/` is gitignored, so
run this before loading the extension unpacked.

### Settings

The options page now also takes the **ThoughtSpot model id** (`worksheetId` --
the model Spotter answers from) and an optional **ThoughtSpot host** override;
without a host it uses `ui/configs/thoughtspot-config.js`.

### Auth

`initSpotter` pins `TrustedAuthTokenCookieless`, and `panel.js` fetches the
token from the backend's `/token` with the extension's API key, so no cluster
secret sits in the extension.

**That endpoint does not exist yet.** `GET /token` currently returns 404, so the
panel mounts but Spotter cannot authenticate. `backend/.env.example` already
carries `THOUGHTSPOT_HOST` and `THOUGHTSPOT_SECRET_KEY` for it.

## Getting a visual's data

Clicking Spotter loads the visual's actual rows into the panel, matching what is
drawn on screen.

### The endpoint

Not `querydata`. Power BI executes visual queries against the **capacity query
service**, whose address is `capacityUri` in the exploration payload:

```
POST {capacityUri}query
Authorization: MWCToken <exploration.mwcToken>
x-ms-workload-resource-moniker: <dataset guid>
```

The auth is the trap: this endpoint rejects the `Bearer` token the rest of the
API accepts. It wants an **MWCToken**, which the exploration payload carries.

### Why the query is replayed, not rebuilt

The first attempt built a query from the visual's `prototypeQuery`. It returned
clean data that was **wrong**: `$26.4M` for a KPI reading `$11.43M` on screen.

`prototypeQuery` carries the visual's own fields but not the filter stack.
The real request's `Where` merges report-, page- and visual-level filters with
table aliases already reconciled -- for that KPI, three conditions including a
relative-date window. Rebuilding that by hand means re-implementing Power BI's
filter merge and alias resolution.

So `bridge.js` hooks `fetch` and `XMLHttpRequest` at `document_start`, keeps each
visual's real query keyed by `ApplicationContext.Sources[0].VisualId`, and
replays it on demand. Every value then matches the report.

A visual can fire several queries -- the data query plus auxiliary lookups such
as what-if parameter bounds -- so the cache keeps the one with the most
projections rather than whichever landed last.

### Flat re-binding

Only the `Binding` is rewritten: one grouping over every projection. That makes
matrix and other hierarchical visuals return flat rows instead of nested
`DM1`/`DM2` buckets, so one parser covers every visual type. The `Query`,
including its `Where`, is reused untouched.

### Reading DSR

The response is Power BI's compressed Data Shape Result:

- the first record carries the schema `S`; later records omit it
- `R` is a bitmask of values repeated from the row above, omitted from `C`
- `Ø` is a bitmask of nulls, also omitted from `C`
- a schema entry with `DN` means its values are indexes into `ValueDicts`
- `descriptor.Select[].Value` maps `G0`/`M0` keys to display names and formats

Values are then formatted from the .NET-style format string, where `0` is a
required fraction digit and `#` an optional one -- treating them alike renders
`$23,000,000.000000000000000` instead of `$23,000,000`.

### Verified

All nine visuals on Sales Overview, against the rendered report:

| Visual | Panel | On screen |
| --- | --- | --- |
| Revenue won | $11,429,826.00 | $11.43M |
| Qualified Pipeline | $19,900,361.00 | $19.90M |
| Revenue goal | $23,000,000 | $23M |
| Forecast | 136% | 136% |
| Revenue Open by Sales Stage | 1-Qualify $7,912,020.00 | $7,912.02K |
| Forecast by Territory | 45 rows | matches drill-down |

### Scale and paging

Measured against this model's 20,000-row Opportunities table, grouped to one
output row per opportunity over six columns:

| Window requested | Rows returned | Time | Payload |
| --- | --- | --- | --- |
| 500 | 500 | 912 ms | 21 KB |
| 5,000 | 5,000 | 366 ms | 177 KB |
| **10,000** | **10,000** | **652 ms** | **344 KB** |
| 30,000 | 20,000 | 782 ms | 676 KB |
| 50,000 | 20,000 | 559 ms | 676 KB |

So **10,000 rows in a single request is comfortable**, and one window tops out
at 20,000 rows server side. Beyond that the response carries `RT`
(`RestartTokens`) and the next window resumes from it -- the full 20,000 rows
came back in 5 pages of 5,000 in 2.2 s.

**A restart token is inclusive**: each page after the first repeats the previous
page's last row. Paging without allowing for that returned 20,004 rows for a
20,000-row table. Pages after the first therefore drop their leading row.

Wide results are fine too -- the cost is columns x rows in the payload, and the
backend accepts up to 500 columns.

### Limits

- `PAGE_SIZE` 10,000 per request; `PREVIEW_ROWS` 1,000 for the panel, of which
  100 are rendered; `MAX_ROWS` 20,000 for a full pull, matching the backend's
  row ceiling.
- The panel loads the preview only. **Send to Spotter backend** pulls the full
  set first when the preview was truncated, so a large visual costs nothing
  until it is actually sent.
- A visual whose query has not been observed yet cannot be replayed -- images,
  shapes and textboxes never issue one, and the panel says so.
- Summary data only. Row-level detail would need a separate query.

## Sending a session to the backend

The panel's **Send to Spotter backend** button posts to the `backend/` service,
using the same `background.js` + options-page pattern as the Tableau extension.
Configure the backend URL and API key on the extension's options page.

The backend takes one shape for every platform, so the Power BI context is
flattened to string values, with each field role as its own key:

```json
{
  "platform": "powerbi",
  "context": {
    "reportId": "9f5b3b87-...", "reportTitle": "Regional Sales Sample",
    "pageName": "ReportSectionb621...", "workspace": "me",
    "visualId": "e9ee7b2d33b6ec76638d", "visualTitle": "Forecast by Territory",
    "visualType": "pivotTable", "tabOrder": "5000", "filterCount": 0,
    "role_Rows": "Territories.Territory, Accounts.State or Province",
    "role_Values": "Opportunities.Revenue Won, Opportunities.Revenue In Pipeline, ..."
  },
  "data": {
    "columns": [{ "name": "Territories.Territory", "type": "string" },
                { "name": "Opportunities.Revenue Won", "type": "number" }],
    "rows": [["US-WEST", "$1,220,718.00"]],
    "totalRows": 45
  }
}
```

Measure columns are typed `number` and grouping columns `string`; rows carry the
formatted strings, matching what Tableau sends as `formattedValue`.

Verified against the real `parseSessionInput` from `backend/src/session.ts`:
sessions created for a KPI (2 columns, 1 row), a funnel (2 x 4) and a matrix
(5 x 45).

## Extracting the semantic model as TMDL

`tools/fetch-tmdl.mjs` pulls a report's semantic model -- tables, columns,
relationships and DAX measures -- as **TMDL**, Power BI's text format. This is
the input for converting a Power BI model into ThoughtSpot TML.

```bash
node tools/fetch-tmdl.mjs --out ./tmdl        # report tab must be open in the CDP browser
node tools/fetch-tmdl.mjs --port 9223 --out /tmp/tmdl
```

Nothing is hardcoded -- report, dataset and workspace are all discovered from
the open tab.

### How it gets there

```
report URL           -> workspace id   (/groups/<id>/; "me" resolves via Fabric /v1/workspaces, type Personal)
/explore/.../exploration -> report.model.dbName = dataset guid
POST api.fabric.microsoft.com/v1/workspaces/{ws}/semanticModels/{dataset}/getDefinition?format=TMDL
  -> 202 + Location -> poll -> /result -> parts[] as base64
```

Two things make this practical:

- **No app registration.** The call runs in the page's context and reuses
  `window.powerBIAccessToken`. That token is accepted by `api.powerbi.com` *and*
  `api.fabric.microsoft.com`, so there is no separate OAuth flow to stand up.
- **`getDefinition` is long-running.** It answers 202 with a `Location`; the
  tool polls to `Succeeded` then fetches `/result`.

### What comes back

17 parts for the Regional Sales Sample, ~277 KB:

| Part | Use for TML |
| --- | --- |
| `definition/tables/*.tmdl` | Columns with `dataType`, `summarizeBy`, `sourceColumn`, `isHidden`; DAX `measure` bodies; the M `partition` holding the source query |
| `definition/relationships.tmdl` | `fromColumn` / `toColumn` pairs -- joins |
| `definition/model.tmdl` | Table list, culture |
| `definition/cultures/en-US.tmdl` | Q&A linguistic schema -- 240 KB of the 277, and **not** needed for TML |

Ignore the culture file and the real payload is about 37 KB.

### Caveats

- The dataset must sit on a workspace the Fabric item API serves. This was
  verified on a **personal workspace on Premium capacity**
  (`sharedFromEnterpriseCapacitySku: SharedOnPremium`). A dataset on a pure
  shared/free capacity may refuse `getDefinition`.
- DirectQuery models expose the M partition as a connection, not data.
- TMDL is the *model*, not the report. Visual-level bindings come from the
  `exploration` endpoint (see above).

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest, scoped to `app.powerbi.com`, all frames |
| `content.js` | Finds visual titles, injects the button, renders the panel |
| `content.css` | Button and panel styles, namespaced with `ts-spotter-` |

## Development loop

Content scripts are copied into a page at load time, so edits on disk do not
reach open tabs. After changing `content.js` or `content.css`, click Reload on
the extension card at `chrome://extensions`, then refresh the Power BI tab.
Manifest changes always need the extension reload.

## Notes

- No background service worker, storage, or network calls yet. The extension
  reads only DOM text and the URL.
- Scoped to `app.powerbi.com`. For another tenant host (e.g. `msit.powerbi.com`)
  add it to both `matches` and `host_permissions` in `manifest.json`.
- `content.css` is a copy of the Tableau extension's, so the two panels look
  identical. Chrome cannot load a content script file from outside the
  extension's own folder, which is why it is duplicated rather than shared.
