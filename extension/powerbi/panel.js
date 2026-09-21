// Runs as an extension page, not in the Power BI document: MV3 forbids remote
// scripts, and the host page's CSP would block framing the ThoughtSpot host.
// The content script embeds this page in an iframe.
import { initSpotter, PowerBiSpotterEmbed } from './vendor/spotter-embed.js';

const SETTINGS_KEYS = ['backendUrl', 'apiKey', 'worksheetId', 'thoughtSpotHost'];

function fail(html) {
  const el = document.getElementById('message');
  el.innerHTML = html;
  el.hidden = false;
  document.getElementById('spotter').hidden = true;
}

async function main() {
  const settings = await chrome.storage.local.get(SETTINGS_KEYS);
  if (!settings.worksheetId) {
    fail('No ThoughtSpot model configured. Set <code>Model id</code> on the extension options page.');
    return;
  }
  if (!settings.backendUrl || !settings.apiKey) {
    fail('No backend configured. Set the backend URL and API key on the extension options page.');
    return;
  }

  initSpotter({
    ...(settings.thoughtSpotHost ? { thoughtSpotHost: settings.thoughtSpotHost } : {}),
    // Cookieless trusted auth: the cluster token is minted by our backend so it
    // never sits in the extension.
    getAuthToken: async () => {
      const res = await fetch(new URL('/token', settings.backendUrl), {
        headers: { Authorization: 'Bearer ' + settings.apiKey },
      });
      if (!res.ok) throw new Error('backend /token returned ' + res.status);
      return (await res.text()).trim();
    },
  });

  const params = new URLSearchParams(location.search);
  const question = params.get('q');
  const embed = new PowerBiSpotterEmbed('#spotter', {
    worksheetId: settings.worksheetId,
    ...(question ? { searchOptions: { searchQuery: question } } : {}),
  });
  try {
    await embed.render();
  } catch (err) {
    fail('Spotter failed to load: ' + String((err && err.message) || err));
  }
}

main().catch((err) => fail('Panel failed to start: ' + String((err && err.message) || err)));
