// Mounts Spotter INSIDE the host BI page rather than inside panel.html.
//
// Why: the SDK sets hostAppUrl from window.location.host. Mounted in
// panel.html that is the chrome-extension id, and the cluster then 401s every
// embed API call — /conversation/v2/ included — so no conversation is created
// and Spotter's send button stays permanently disabled. Mounted in the page,
// hostAppUrl is the BI host (app.powerbi.com), which is what the working
// Tableau embed sends.
//
// Runs as a content script, so it shares the isolated world with content.js.
import { initSpotter, TableauSpotterEmbed, PowerBiSpotterEmbed, thoughtSpotConfig } from '../../ui/spotter-embed/index.js';
import { TableauLiveboardEmbed, PowerBiLiveboardEmbed } from '../../ui/spotter-embed/index.js';
import { tableauConfig, powerBiConfig } from '../../ui/spotter-embed/index.js';

const EMBED_TOKEN = 'spotter:embed-token';
const EMBEDS = { tableau: TableauSpotterEmbed, powerbi: PowerBiSpotterEmbed };
const CONFIGS = { tableau: tableauConfig, powerbi: powerBiConfig };
const LIVEBOARDS = { tableau: TableauLiveboardEmbed, powerbi: PowerBiLiveboardEmbed };
const SUBJECT = {
  tableau: (c) => [c.worksheet, c.dashboard || c.workbook],
  powerbi: (c) => [c.visualTitle, c.reportTitle],
};

// The worker holds the backend key and keeps the host_permissions CORS
// exemption; a content-script fetch would be cross-origin from the BI page.
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

let mounted = null;
let inited = false;

export function closeSpotterPanel() {
  if (mounted) mounted.remove();
  mounted = null;
}

export async function openSpotterPanel(context, hostClass) {
  closeSpotterPanel();

  const platform = context.platform === 'powerbi' ? 'powerbi' : 'tableau';
  const cfg = CONFIGS[platform];

  const host = document.createElement('aside');
  host.className = (hostClass || '') + ' ts-spotter-inpage';
  // Same palette the embed is themed with, so our chrome and Spotter's UI are
  // one surface rather than two. Single source: ui/configs/<platform>-config.js.
  const c = cfg.colors;
  host.style.setProperty('--ts-panel-bg', c.background);
  host.style.setProperty('--ts-panel-surface', c.surface);
  host.style.setProperty('--ts-panel-text', c.text);
  host.style.setProperty('--ts-panel-muted', c.textSecondary);
  host.style.setProperty('--ts-panel-accent', c.primary);
  host.style.setProperty('--ts-panel-font', c.font);
  host.innerHTML = '<header class="ts-spotter-inpage-head"><strong>Spotter</strong>'
    + '<span class="ts-spotter-inpage-subject"></span>'
    + '<button type="button" class="ts-spotter-inpage-close" aria-label="Close Spotter">&times;</button></header>'
    + '<div class="ts-spotter-inpage-status" hidden></div>'
    + '<div class="ts-spotter-embed-mount"></div>';
  document.body.appendChild(host);
  mounted = host;

  const statusEl = host.querySelector('.ts-spotter-inpage-status');
  const showStatus = (text, isError) => {
    statusEl.textContent = text || '';
    statusEl.className = 'ts-spotter-inpage-status' + (isError ? ' ts-spotter-inpage-error' : '');
    statusEl.hidden = !text;
  };
  host.querySelector('.ts-spotter-inpage-close').addEventListener('click', closeSpotterPanel);

  const bits = (SUBJECT[platform](context) || []).filter(Boolean);
  if (context.worksheetName) bits.push('model: ' + context.worksheetName);
  host.querySelector('.ts-spotter-inpage-subject').textContent = bits.join(' · ');

  showStatus('Connecting to ThoughtSpot…', false);
  // init() is global to the page, so only ever call it once.
  if (!inited) {
    initSpotter({ thoughtSpotHost: thoughtSpotConfig.host, getAuthToken: () => requestEmbedToken(context) });
    inited = true;
  }

  // Liveboard mode: the caller built or reused one and passed its id.
  if (context.liveboardId) {
    const lb = new LIVEBOARDS[platform](host.querySelector('.ts-spotter-embed-mount'), { liveboardId: context.liveboardId });
    lb.on('load', () => showStatus('', false));
    lb.on('error', (payload) => {
      console.error('LiveboardEmbed error', payload);
      showStatus('The liveboard could not load.', true);
    });
    try {
      await lb.render();
    } catch (err) {
      console.error(err);
      showStatus('The liveboard could not load: ' + ((err && err.message) || err), true);
    }
    return;
  }

  if (!context.worksheetId) {
    showStatus(context.loadError
      ? 'Could not load this view into ThoughtSpot: ' + context.loadError
      : 'No ThoughtSpot model for this view yet.', true);
    return;
  }

  const embed = new EMBEDS[platform](host.querySelector('.ts-spotter-embed-mount'), { worksheetId: context.worksheetId });
  embed.on('load', () => showStatus('', false));
  embed.on('error', (payload) => {
    console.error('SpotterEmbed error', payload);
    showStatus('Spotter could not load.', true);
  });
  try {
    await embed.render();
  } catch (err) {
    console.error(err);
    showStatus('Spotter could not load: ' + ((err && err.message) || err), true);
  }
}

// content.js shares this isolated world but is not a module.
window.__spotterPanel = { open: openSpotterPanel, close: closeSpotterPanel };
