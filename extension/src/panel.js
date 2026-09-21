import {
  initSpotter,
  TableauSpotterEmbed, PowerBiSpotterEmbed,
  TableauLiveboardEmbed, PowerBiLiveboardEmbed,
  thoughtSpotConfig,
} from '../../ui/spotter-embed/index.js';

const CLOSE_EVENT = 'spotter:close';
const EMBED_TOKEN = 'spotter:embed-token';
const EMBEDS = { tableau: TableauSpotterEmbed, powerbi: PowerBiSpotterEmbed };
const LIVEBOARDS = { tableau: TableauLiveboardEmbed, powerbi: PowerBiLiveboardEmbed };
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

// The backend mints the trusted-auth token as this platform user; the panel
// never holds cluster credentials. Same userid as createDataset uses.
function requestEmbedToken(context) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: EMBED_TOKEN,
      payload: { userid: context.workspace || context.site || 'user', platform: context.platform || 'tableau' },
    }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from the extension worker.'));
      if (res.error) return reject(new Error(res.error));
      resolve(res.token);
    });
  });
}

async function main() {
  const context = readContext();
  const platform = context.platform === 'powerbi' ? 'powerbi' : 'tableau';
  const Embed = EMBEDS[platform];
  const subjectParts = SUBJECT[platform](context) || [];
  if (context.worksheetName) subjectParts.push('model: ' + context.worksheetName);
  subject.textContent = subjectParts.filter(Boolean).join(' · ');

  showStatus('Connecting to ThoughtSpot…', false);
  initSpotter({ thoughtSpotHost: thoughtSpotConfig.host, getAuthToken: () => requestEmbedToken(context) });

  // Liveboard mode: the caller built/reused a liveboard and passed its id.
  if (context.liveboardId) {
    const LbEmbed = LIVEBOARDS[platform];
    const lb = new LbEmbed('#spotter', { liveboardId: context.liveboardId, frameParams: { width: '100%', height: 'calc(100vh - 40px)' } });
    lb.on('load', () => showStatus('', false));
    lb.on('error', (payload) => {
      console.error('LiveboardEmbed error', payload);
      showStatus('The liveboard could not load. Check the host and cluster access.', true);
    });
    try {
      await lb.render();
    } catch (err) {
      console.error(err);
      showStatus('The liveboard could not load.', true);
    }
    return;
  }

  // SpotterEmbed with no model never finishes rendering and never errors, so
  // the panel would sit on "Connecting…" forever. Say so instead.
  const worksheetId = context.worksheetId || thoughtSpotConfig.defaultWorksheetId;
  if (!worksheetId) {
    showStatus('No ThoughtSpot model for this view' + (context.loadError ? ' (' + context.loadError + ')' : '') + '. Try again, or Alt+click to build one.', true);
    return;
  }
  // Give the SDK a definite iframe height (vh, minus the header) so its nested
  // iframe fills the panel. A percentage height collapses to the 150px iframe
  // default whenever the SDK's wrapper divs don't carry a resolved height.
  const viewConfig = { worksheetId, frameParams: { width: '100%', height: 'calc(100vh - 40px)' } };
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
