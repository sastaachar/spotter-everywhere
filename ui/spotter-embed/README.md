# ui/spotter-embed

ThoughtSpot's `SpotterEmbed` from `@thoughtspot/visual-embed-sdk`, themed per
host platform. `TableauSpotterEmbed` is the SDK class with the Tableau config
applied, `PowerBiSpotterEmbed` the same with the Power BI config. Nothing else
changes: constructor, `render()`, events and view config are the SDK's.

```js
import { initSpotter, TableauSpotterEmbed } from '@spotter-everywhere/spotter-embed';

initSpotter({
  thoughtSpotHost: 'https://your-cluster.thoughtspot.cloud',
  getAuthToken: () => fetch(backend + '/token', { headers }).then((r) => r.text()),
});

const embed = new TableauSpotterEmbed('#spotter', { worksheetId: '<thoughtspot model id>' });
await embed.render();
```

`initSpotter` is the SDK's `init` with `authType` fixed to
`TrustedAuthTokenCookieless`; the token is minted by our backend, never by the
browser. Extra view config passed to a preset wins over the platform defaults,
and any `customizations` you pass are merged on top of the theme.

## Configs (`../configs/*-config.js`)

Each config is platform level only: colours, CSS variables and default view
config. No selectors, no data logic.

| Key | Purpose |
| --- | --- |
| `platform`, `label` | id sent to the backend and shown in UI |
| `colors` | primary/hover/active, secondary, background, surface, text, font. Mapped to `--ts-var-*` by `cssVariablesFor` |
| `cssVariables` | raw `--ts-var-*` overrides that win over the mapped colours |
| `viewConfig` | `SpotterEmbedViewConfig` defaults for that platform |

## Develop

```
bun install
bun test
```

The extension panel page is where this gets mounted. MV3 forbids remote
scripts, so the SDK is bundled into the extension; the extension page's own
CSP allows framing the ThoughtSpot host.
