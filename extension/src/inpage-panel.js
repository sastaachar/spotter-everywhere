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
const LIVEBOARDS = { tableau: TableauLiveboardEmbed, powerbi: PowerBiLiveboardEmbed };
const CONFIGS = { tableau: tableauConfig, powerbi: powerBiConfig };
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

/** Progress checklist, same shape the platform content scripts use. */
function buildChecklist(container, title, defs) {
  container.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'ts-spotter-steps ts-spotter-steps-panel';
  const heading = document.createElement('div');
  heading.className = 'ts-spotter-steps-title';
  heading.textContent = title;
  wrap.appendChild(heading);
  const rows = {};
  defs.forEach((step) => {
    const row = document.createElement('div');
    row.className = 'ts-spotter-step';
    row.dataset.state = 'pending';
    const icon = document.createElement('span');
    icon.className = 'ts-spotter-step-icon';
    const label = document.createElement('span');
    label.className = 'ts-spotter-step-label';
    label.textContent = step.label;
    row.append(icon, label);
    wrap.appendChild(row);
    rows[step.key] = row;
  });
  container.appendChild(wrap);
  return (key, state) => {
    // Finishing a step implies the ones before it finished too.
    const order = defs.map((d) => d.key);
    const at = order.indexOf(key);
    order.forEach((k, i) => {
      if (i < at) rows[k].dataset.state = 'done';
    });
    if (rows[key]) rows[key].dataset.state = state;
    if (state === 'active' && at + 1 < order.length) rows[order[at + 1]].dataset.state = 'pending';
  };
}

function clearChecklist(host) {
  const progress = host.querySelector('.ts-spotter-inpage-progress');
  if (progress) progress.remove();
}

let mounted = null;

// The auth-token callback reads whatever view is open now; openSpotterPanel keeps
// this pointed at the latest context right before it renders.
let currentContext = { platform: location.host.includes('powerbi') ? 'powerbi' : 'tableau' };

// init() is global to the page and only needs to run once. Do it as soon as the
// content script loads — not on the first panel open — so opening Spotter is
// instant and we never re-init per view.
initSpotter({ thoughtSpotHost: thoughtSpotConfig.host, getAuthToken: () => requestEmbedToken(currentContext) });

export function closeSpotterPanel() {
  if (mounted) mounted.remove();
  mounted = null;
}

export async function openSpotterPanel(context, hostClass) {
  closeSpotterPanel();

  const platform = context.platform === 'powerbi' ? 'powerbi' : 'tableau';
  const isLiveboard = Boolean(context.liveboardId);
  const noun = isLiveboard ? 'Liveboard' : 'Spotter';
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
  host.innerHTML = '<div class="ts-spotter-inpage-grip" role="separator" aria-orientation="vertical"'
    + ' aria-label="Resize panel" tabindex="0"></div>'
    + '<header class="ts-spotter-inpage-head">'
    + '<div class="ts-spotter-inpage-titles">'
    + '<strong class="ts-spotter-inpage-title">' + noun + '</strong>'
    + '<span class="ts-spotter-inpage-subject"></span>'
    + '</div>'
    + '<div class="ts-spotter-inpage-actions">'
    + '<button type="button" class="ts-spotter-inpage-btn ts-spotter-inpage-widen" aria-label="Toggle panel width" title="Toggle width"></button>'
    + '<button type="button" class="ts-spotter-inpage-btn ts-spotter-inpage-close" aria-label="Close ' + noun + '" title="Close">&times;</button>'
    + '</div></header>'
    + '<div class="ts-spotter-inpage-status" hidden></div>'
    + '<div class="ts-spotter-inpage-progress"></div>'
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

  // The panel covers the report, so it has to be adjustable: drag the left edge,
  // or toggle between a reading width and a wide one. The choice is remembered
  // per platform so it survives reopening.
  const WIDTH_KEY = 'ts-spotter-panel-width-' + platform;
  const MIN_WIDTH = 380;
  const applyWidth = (px) => {
    const max = Math.round(window.innerWidth * 0.96);
    const width = Math.min(Math.max(Math.round(px), MIN_WIDTH), max);
    host.style.width = width + 'px';
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* private window */ }
    return width;
  };

  let stored = null;
  try { stored = Number(localStorage.getItem(WIDTH_KEY)) || null; } catch { stored = null; }
  applyWidth(stored || (isLiveboard ? 1180 : 760));

  const grip = host.querySelector('.ts-spotter-inpage-grip');
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    host.classList.add('ts-spotter-inpage-dragging');
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    // The panel is docked right, so its width is whatever is left of the pointer.
    if (dragging) applyWidth(window.innerWidth - e.clientX);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    host.classList.remove('ts-spotter-inpage-dragging');
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  // Keyboard equivalent, since a drag handle alone is not reachable.
  grip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') applyWidth(host.getBoundingClientRect().width + 60);
    else if (e.key === 'ArrowRight') applyWidth(host.getBoundingClientRect().width - 60);
    else return;
    e.preventDefault();
  });

  host.querySelector('.ts-spotter-inpage-widen').addEventListener('click', () => {
    const wide = Math.round(window.innerWidth * 0.96);
    const current = host.getBoundingClientRect().width;
    applyWidth(current > wide - 40 ? 760 : wide);
  });

  const bits = (SUBJECT[platform](context) || []).filter(Boolean);
  if (context.worksheetName) bits.push('model: ' + context.worksheetName);
  host.querySelector('.ts-spotter-inpage-subject').textContent = bits.join(' · ');

  currentContext = context;
  // A checklist rather than a bare "Connecting…" line, so the wait says what is
  // happening. It lives in the embed mount and is replaced by the embed itself.
  const steps = buildChecklist(host.querySelector('.ts-spotter-inpage-progress'),
    isLiveboard ? 'Opening your Liveboard' : 'Setting up Spotter',
    isLiveboard
      ? [{ key: 'auth', label: 'Signing in to ThoughtSpot' }, { key: 'open', label: 'Loading the liveboard' }]
      : [{ key: 'auth', label: 'Signing in to ThoughtSpot' },
         { key: 'model', label: 'Attaching your data model' },
         { key: 'open', label: 'Starting Spotter' }]);
  steps('auth', 'active');

  // Liveboard mode: the caller built or reused one and passed its id.
  if (context.liveboardId) {
    const lb = new LIVEBOARDS[platform](host.querySelector('.ts-spotter-embed-mount'), { liveboardId: context.liveboardId });
    lb.on('load', () => { steps('open', 'done'); clearChecklist(host); });
    lb.on('error', (payload) => {
      console.error('LiveboardEmbed error', payload);
      showStatus('The liveboard could not load.', true);
    });
    steps('open', 'active');
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

  steps('model', 'active');
  const embed = new EMBEDS[platform](host.querySelector('.ts-spotter-embed-mount'), { worksheetId: context.worksheetId });
  embed.on('load', () => { steps('open', 'done'); clearChecklist(host); });
  embed.on('error', (payload) => {
    console.error(noun + ' embed error', payload);
    showStatus(noun + ' could not load.', true);
  });
  try {
    await embed.render();
  } catch (err) {
    console.error(err);
    showStatus(noun + ' could not load: ' + ((err && err.message) || err), true);
  }
}

// content.js shares this isolated world but is not a module.
window.__spotterPanel = { open: openSpotterPanel, close: closeSpotterPanel };
