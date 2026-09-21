# spotter-everywhere

ThoughtSpot Spotter layered onto other BI tools via browser extensions.

| Path | What |
| --- | --- |
| `extension/tableau/` | Chrome extension for Tableau Cloud: Spotter button on every sheet title, panel with viz identity, shape and data. See its README. |
| `extension/powerbi/` | Chrome extension for Power BI reports: Spotter button, visual context and data, TMDL export. See its README. |
| `backend/` | Hono on Bun. `POST /session` stores the platform, context and data an extension collected; see its README. |
| `ui/spotter-embed/` | The shared extension UI: `SpotterEmbed` panel plus `TableauSpotterEmbed` / `PowerBiSpotterEmbed` presets. Plain ES modules. |
| `ui/configs/` | Per-platform configs (`tableau-config.js`, `power-bi-config.js`) the presets apply. |

Load an extension unpacked from its folder at `chrome://extensions`.
