# spotter-everywhere

ThoughtSpot Spotter layered onto other BI tools via browser extensions.

| Path | What |
| --- | --- |
| `extension/` | One Chrome extension for Tableau and Power BI; site-dispatched, shared panel and backend client. See its README. |
| `backend/` | Hono on Bun. `POST /session` stores the platform, context and data an extension collected; see its README. |
| `ui/spotter-embed/` | ThoughtSpot Visual Embed SDK `SpotterEmbed` themed per platform: `TableauSpotterEmbed`, `PowerBiSpotterEmbed`, `initSpotter` (cookieless trusted auth). |
| `ui/configs/` | Platform-level configs (`tableau-config.js`, `power-bi-config.js`): colours, CSS variables, default view config. |

Load an extension unpacked from its folder at `chrome://extensions`. Packages
that install dependencies carry a `.npmrc` pinning the public npm registry, since
Bun cannot resolve through the corporate registry.
