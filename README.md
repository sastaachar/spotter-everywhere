# spotter-everywhere

ThoughtSpot Spotter layered onto other BI tools via browser extensions.

| Path | What |
| --- | --- |
| `extension/tableau/` | Chrome extension for Tableau Cloud: Spotter button on every sheet title, panel with viz identity, shape and data. See its README. |
| `backend/` | Hono on Bun. `POST /session` stores the platform, context and data an extension collected; see its README. |
| `ui/spotter/` | Spotter UI rendered on top of the host tool, fed by backend sessions. Stack TBD. |

Load an extension unpacked from its folder at `chrome://extensions`.
