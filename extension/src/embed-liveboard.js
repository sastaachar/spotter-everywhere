// Mounts a ThoughtSpot Liveboard on a customer's own page.
//
// The rest of the extension mounts Spotter inside a BI tool. This one has no BI
// tool to sit in: the host is the customer's application, and what goes into it
// is the finished Liveboard — the report as ThoughtSpot renders it, not the
// report itself.
//
// Runs as a content script, so it shares the isolated world with the embed
// content script that drives it.
import { initSpotter, PowerBiLiveboardEmbed, thoughtSpotConfig, powerBiConfig } from '../../ui/spotter-embed/index.js';

const EMBED_TOKEN = 'spotter:embed-token';

// The worker holds the backend key and the host_permissions CORS exemption; a
// fetch from the customer's page would be cross-origin.
function requestEmbedToken(userid) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: EMBED_TOKEN, payload: { userid, platform: 'powerbi' } }, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from the extension worker.'));
      if (res.error) return reject(new Error(res.error));
      resolve(res.token);
    });
  });
}

// The liveboard is shared with the user the build ran as, so the embed has to
// authenticate as that same one or the cluster answers with "request access".
let currentUser = 'powerbi_user';

// Global to the page and only needed once, so do it on load rather than on the
// first embed — opening a liveboard is then immediate.
initSpotter({
  thoughtSpotHost: thoughtSpotConfig.host,
  getAuthToken: () => requestEmbedToken(currentUser),
});

/**
 * Put a liveboard into `container`. Resolves once it has rendered, rejects if it
 * cannot — the caller decides what to show in its place.
 */
/**
 * Whether the cluster will talk to this page at all.
 *
 * ThoughtSpot only answers a browser whose origin it has been told to expect,
 * so an embed from a page the cluster does not list fails as "Not logged in" —
 * which reads like a sign-in problem and is really a one-line setting. Asking
 * first turns that into something the person can act on.
 */
async function clusterAllowsThisOrigin() {
  try {
    await fetch(`${thoughtSpotConfig.host.replace(/\/$/, '')}/callosum/v1/session/info`, {
      credentials: 'include',
    });
    return true;
  } catch {
    return false;
  }
}

class OriginNotAllowed extends Error {
  constructor() {
    super(`This page's origin (${location.origin}) is not on the ThoughtSpot cluster's `
      + 'allowlist, so the browser will not let it load a Liveboard. Add it under '
      + 'Develop \u2192 Customizations \u2192 Security Settings, to both "CORS whitelisted '
      + 'domains" and "CSP visual embed hosts".');
    this.name = 'OriginNotAllowed';
  }
}

async function mount(container, liveboardId, userid) {
  if (userid) currentUser = userid;
  if (!(await clusterAllowsThisOrigin())) throw new OriginNotAllowed();
  container.textContent = '';
  const embed = new PowerBiLiveboardEmbed(container, { liveboardId });
  const rendered = new Promise((resolve, reject) => {
    embed.on('load', resolve);
    embed.on('error', (payload) => {
      console.error('[Spotter Embed] liveboard error', payload);
      reject(new Error('The liveboard could not be displayed.'));
    });
    // A liveboard that never answers is a failure the host should be told about
    // rather than a spinner that runs for ever.
    setTimeout(() => reject(new Error('The liveboard took too long to load.')), 60000);
  });
  await embed.render();
  await rendered;
  return embed;
}

window.__spotterLiveboard = { mount, colors: powerBiConfig.colors };
