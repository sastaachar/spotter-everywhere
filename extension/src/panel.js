import { initSpotter, TableauSpotterEmbed, PowerBiSpotterEmbed, thoughtSpotConfig } from '../../ui/spotter-embed/index.js';
import { devCredentials } from './dev-credentials.js';

const CLOSE_EVENT = 'spotter:close';
const EMBEDS = { tableau: TableauSpotterEmbed, powerbi: PowerBiSpotterEmbed };
const SUBJECT = {
  tableau: (c) => [c.worksheet, c.dashboard || c.workbook],
  powerbi: (c) => [c.visualTitle, c.reportTitle],
};

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

async function main() {
  const context = readContext();
  const platform = context.platform === 'powerbi' ? 'powerbi' : 'tableau';
  const Embed = EMBEDS[platform];
  subject.textContent = (SUBJECT[platform](context) || []).filter(Boolean).join(' · ');

  const { username, password } = devCredentials;
  if (!username || !password) {
    showStatus('Set the ThoughtSpot username and password in extension/src/dev-credentials.js to start Spotter.', true);
    return;
  }

  showStatus('Connecting to ThoughtSpot…', false);
  initSpotter({ thoughtSpotHost: thoughtSpotConfig.host, username, password });

  // SpotterEmbed with no model never finishes rendering and never errors, so
  // the panel would sit on "Connecting…" forever. Say so instead.
  const worksheetId = context.worksheetId || thoughtSpotConfig.defaultWorksheetId;
  if (!worksheetId) {
    showStatus('No ThoughtSpot model for this view yet. Alt+click the Spotter button and use "Create Spotter worksheet" first.', true);
    return;
  }
  const viewConfig = { worksheetId };
  const embed = new Embed('#spotter', viewConfig);
  embed.on('load', () => showStatus('', false));
  embed.on('error', (payload) => {
    console.error('SpotterEmbed error', payload);
    showStatus('Spotter could not load. Check the credentials and host in extension/src/config.js.', true);
  });
  try {
    await embed.render();
  } catch (err) {
    console.error(err);
    showStatus('Spotter could not load. Check the credentials and host in extension/src/config.js.', true);
  }
}

main();
