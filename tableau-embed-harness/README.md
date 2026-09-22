# Tableau embed harness

A standalone HTML page for testing Tableau's [Embedding API v3](https://help.tableau.com/current/api/embedding_api/en-us/index.html)
(`<tableau-viz>`) outside of the browser extension. It renders a fake customer-portal
shell ("Northgate Office Supply · Insights Hub", all names/numbers synthetic) around a
live embedded view, so the viz can be exercised in isolation while debugging embedding,
auth, or CSP/framing issues.

Currently points at `Superstore/Customers` on
`https://prod-in-a.online.tableau.com/t/prinostaged-886a46416e`.

## Serve it

```sh
cd tableau-embed-harness
python3 -m http.server 8123
```

Then open `http://localhost:8123/tableau-embed.html`.

No build step — it's a single static HTML file with an inline `<script type="module">`
that loads Tableau's embedding script directly from `prod-in-a.online.tableau.com`.

## Using it

- The status pill above the viz reflects the `firstinteractive` / `vizloaderror` events
  fired by `<tableau-viz>`. After a 6s grace period with no event, it drops to a
  non-blocking "Waiting for Tableau sign-in" state so a Tableau sign-in page rendered
  inside the frame isn't hidden under the loading skeleton forever.
- Refresh / Revert / Full screen buttons call the Embedding API directly on the
  `<tableau-viz>` element.
- `window.viz` is exposed in the console for poking at the element directly
  (e.g. `viz.getWorkbook()`).

## Auth (known issue)

Loading the page hits a 401 on the VizQL `startSession` request unless the browser
already has a usable Tableau Cloud session cookie for that site:

- **Dev workaround**: sign in to the site (`prod-in-a.online.tableau.com`) in the same
  browser profile, and make sure third-party cookies aren't blocked for
  `[*.]online.tableau.com` — the viz iframe is a third-party context relative to
  `localhost:8123`, so Incognito / Chrome for Testing / strict cookie settings will
  drop the session cookie and loop back to the sign-in page.
- **Proper fix** (no sign-in required, works for a real customer portal): set up a
  [Connected App (Direct Trust)](https://help.tableau.com/current/online/en-us/connected_apps_direct.htm)
  on the Tableau site with `http://localhost:8123` (or the real portal origin) in its
  domain allowlist, mint a JWT server-side (HS256, `kid` = secret id, `iss` = client id,
  `sub` = Tableau username, `aud` = `"tableau"`, `exp` ≤ 10 min, `jti`,
  `scp: ["tableau:views:embed"]`), and pass it as the `token` attribute on
  `<tableau-viz>`. Not built yet — needs a site admin to create the connected app and
  share the client id / secret id / secret.

This is a Tableau-side harness only — it has no dependency on the ThoughtSpot Spotter
extension or backend in this repo.
