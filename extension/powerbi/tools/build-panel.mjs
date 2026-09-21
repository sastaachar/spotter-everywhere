// Vendors the Spotter panel's dependencies into the extension.
//
// MV3 forbids remote scripts, so the Visual Embed SDK and the shared
// ui/spotter-embed sources are copied in and the bare SDK import is rewritten
// to the vendored file. No bundler, so there is nothing to install.
//
//   node tools/build-panel.mjs
//
// Re-run after changing ui/spotter-embed or ui/configs.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const extension = resolve(here, '..');
const repo = resolve(extension, '../..');
const vendor = resolve(extension, 'vendor');

const SDK_BUNDLE = 'tsembed.es.js';
const SDK_CANDIDATES = [
  resolve(repo, 'ui/spotter-embed/node_modules/@thoughtspot/visual-embed-sdk/dist', SDK_BUNDLE),
  resolve(repo, '../visual-embed-sdk/dist', SDK_BUNDLE),
];

const sdk = SDK_CANDIDATES.find((p) => existsSync(p));
if (!sdk) {
  console.error('Could not find the Visual Embed SDK bundle. Looked in:');
  SDK_CANDIDATES.forEach((p) => console.error('  ' + p));
  console.error('\nRun `bun install` in ui/spotter-embed, or keep a visual-embed-sdk checkout beside the repo.');
  process.exit(1);
}

const pinned = JSON.parse(readFileSync(resolve(repo, 'ui/spotter-embed/package.json'), 'utf8'))
  .dependencies['@thoughtspot/visual-embed-sdk'];
const sdkVersion = (() => {
  const pkg = resolve(sdk, '../../package.json');
  return existsSync(pkg) ? JSON.parse(readFileSync(pkg, 'utf8')).version : 'unknown';
})();
if (sdkVersion !== pinned) {
  console.warn(`warning: SDK is ${sdkVersion} but ui/spotter-embed pins ${pinned}`);
}

mkdirSync(vendor, { recursive: true });
copyFileSync(sdk, resolve(vendor, SDK_BUNDLE));

// The shared sources import the SDK by package name; point them at the copy.
const sources = [
  ['ui/spotter-embed/index.js', 'spotter-embed.js'],
  ['ui/configs/tableau-config.js', 'tableau-config.js'],
  ['ui/configs/power-bi-config.js', 'power-bi-config.js'],
  ['ui/configs/thoughtspot-config.js', 'thoughtspot-config.js'],
];
for (const [from, to] of sources) {
  const text = readFileSync(resolve(repo, from), 'utf8')
    .replace(/from '@thoughtspot\/visual-embed-sdk'/g, `from './${SDK_BUNDLE}'`)
    .replace(/from '\.\.\/configs\/([^']+)'/g, "from './$1'");
  writeFileSync(resolve(vendor, to), text);
}

console.log(`vendored SDK ${sdkVersion} and ${sources.length} shared sources into extension/powerbi/vendor/`);
