#!/usr/bin/env node
// Rebuild the panel bundle, reload the unpacked extension, and refresh the host
// tabs — over the DevTools protocol. Needs the dev browser started with
// --remote-debugging-port (see `npm start`). Usage: npm run reload [-- --watch]
import { execSync } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.CDP_PORT || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const EXT_NAME = 'Spotter Everywhere';
const HOST_MATCH = /prod-in-a\.online\.tableau\.com|app\.powerbi\.com/;
const EXTENSIONS_URL = 'chrome://extensions/';

const targets = async () => (await fetch(`${BASE}/json`)).json();

function evaluate(target, expression) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onerror = rej;
    ws.onopen = () =>
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== 1) return;
      ws.close();
      m.result?.exceptionDetails ? rej(new Error(m.result.exceptionDetails.text)) : res(m.result?.result?.value);
    };
  });
}

function command(target, method, params = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onerror = rej;
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (e) => {
      if (JSON.parse(e.data).id === 1) {
        ws.close();
        res();
      }
    };
  });
}

async function extensionsPage() {
  let page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith(EXTENSIONS_URL));
  if (!page) {
    await fetch(`${BASE}/json/new?${EXTENSIONS_URL}`, { method: 'PUT' });
    await new Promise((r) => setTimeout(r, 500));
    page = (await targets()).find((t) => t.type === 'page' && t.url.startsWith(EXTENSIONS_URL));
  }
  if (!page) throw new Error('could not open chrome://extensions');
  return page;
}

async function reloadOnce() {
  execSync('npm run build', { cwd: EXT_DIR, stdio: 'inherit' });
  const page = await extensionsPage();
  const result = await evaluate(
    page,
    `chrome.developerPrivate.getExtensionsInfo().then(async (l) => {
       const ext = l.find((e) => e.name === ${JSON.stringify(EXT_NAME)});
       if (!ext) return { error: 'extension not loaded' };
       await chrome.developerPrivate.reload(ext.id, { failQuietly: false });
       let after;
       for (let i = 0; i < 20; i++) {
         after = (await chrome.developerPrivate.getExtensionsInfo()).find((e) => e.id === ext.id);
         if (after && after.state === 'ENABLED') break;
         await new Promise((r) => setTimeout(r, 100));
       }
       return { state: after.state, errors: after.manifestErrors.concat(after.runtimeErrors).map((x) => x.message) };
     })`
  );
  if (result.error) throw new Error(result.error);
  if (result.errors?.length) console.error('extension errors:', result.errors);
  await new Promise((r) => setTimeout(r, 500));
  const tabs = (await targets()).filter((t) => t.type === 'page' && HOST_MATCH.test(t.url));
  for (const t of tabs) await command(t, 'Page.reload', { ignoreCache: true });
  console.log(`[${new Date().toLocaleTimeString()}] extension ${result.state.toLowerCase()}, reloaded ${tabs.length} tab(s)`);
}

async function main() {
  await reloadOnce();
  if (!process.argv.includes('--watch')) return;
  console.log(`watching ${EXT_DIR} for changes...`);
  let timer = null;
  watch(EXT_DIR, { recursive: true }, (_e, file) => {
    if (!file || file.startsWith('.git') || file.startsWith('dist')) return;
    clearTimeout(timer);
    timer = setTimeout(() => reloadOnce().catch((e) => console.error('reload failed:', e.message)), 300);
  });
}

main().catch((e) => {
  console.error(e.message.includes('fetch failed') ? `no dev browser on port ${PORT}; run \`npm start\` first` : e.message);
  process.exit(1);
});
