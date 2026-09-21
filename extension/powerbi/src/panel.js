// No bundler here, so the shared sources are vendored by tools/build-panel.mjs
// rather than imported from ui/ directly (the Tableau extension uses `bun build`).
import { initSpotter, PowerBiSpotterEmbed, thoughtSpotConfig } from '../vendor/spotter-embed.js';
import { devCredentials } from './dev-credentials.js';

const SETTINGS_KEYS = ['tsHost', 'tsUsername', 'tsPassword', 'worksheetId'];
const CLOSE_EVENT = 'spotter:close';

const status = document.getElementById('status');
const subject = document.getElementById('subject');

function readContext() {
  try {
    return JSON.parse(decodeURIComponent(location.hash.slice(1))) || {};
  } catch {
    return {};
  }
}

function showStatus(text, isError) {
  status.textContent = text;
  status.className = isError ? 'status error' : 'status';
  status.hidden = !text;
}

document.getElementById('close').addEventListener('click', () => {
  window.parent.postMessage({ type: CLOSE_EVENT }, '*');
});

document.getElementById('open-options').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

async function main() {
  const context = readContext();
  subject.textContent = [context.visualTitle, context.reportTitle].filter(Boolean).join(' · ');

  const settings = await chrome.storage.local.get(SETTINGS_KEYS);
  const username = settings.tsUsername || devCredentials.username;
  const password = settings.tsPassword || devCredentials.password;
  if (!username || !password) {
    showStatus('Set the ThoughtSpot username and password in the extension options, or in src/dev-credentials.js, to start Spotter.', true);
    return;
  }

  showStatus('Connecting to ThoughtSpot…', false);
  initSpotter({ thoughtSpotHost: settings.tsHost || thoughtSpotConfig.host, username, password });

  // A worksheet built from this visual wins over the configured default.
  const worksheetId = context.worksheetId || settings.worksheetId;
  const viewConfig = {};
  if (worksheetId) viewConfig.worksheetId = worksheetId;
  const embed = new PowerBiSpotterEmbed('#spotter', viewConfig);
  embed.on('load', () => showStatus('', false));
  embed.on('error', (payload) => {
    console.error('SpotterEmbed error', payload);
    showStatus('Spotter could not load. Check the credentials and host in the extension options.', true);
  });
  try {
    await embed.render();
  } catch (err) {
    console.error(err);
    showStatus('Spotter could not load. Check the credentials and host in the extension options.', true);
  }
}

main();
