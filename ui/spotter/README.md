# ui/spotter

The extension UI. The Spotter panel that opens on top of the host BI tool
(Tableau, Power BI, ...) is built here as one shared front end, and each
extension in `../../extension/*` loads it instead of rendering its own panel.
It reads sessions from `../../backend`. Stack not chosen yet; the current
panel in `extension/tableau/content.js` is the placeholder it replaces.
