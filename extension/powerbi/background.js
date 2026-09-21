const CREATE_SESSION = 'spotter:create-session';
const GET_SETTINGS = 'spotter:get-settings';
const SETTINGS_KEYS = ['backendUrl', 'apiKey'];

function getSettings() {
  return chrome.storage.local.get(SETTINGS_KEYS);
}

async function createSession(payload) {
  const { backendUrl, apiKey } = await getSettings();
  if (!backendUrl || !apiKey) {
    return { error: 'Backend URL and API key are not set. Open the extension options to configure them.' };
  }
  let res;
  try {
    res = await fetch(new URL('/session', backendUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: 'Could not reach the backend: ' + (err && err.message ? err.message : String(err)) };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const code = body && body.error ? body.error : 'http_' + res.status;
    const detail = body && body.detail ? ': ' + body.detail : '';
    return { error: 'Backend rejected the session (' + code + ')' + detail };
  }
  return { session: body, url: new URL('/session/' + body.id, backendUrl).toString() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === CREATE_SESSION) {
    createSession(message.payload).then(sendResponse, (err) => sendResponse({ error: String(err && err.message || err) }));
    return true;
  }
  if (message.type === GET_SETTINGS) {
    getSettings().then((s) => sendResponse({ configured: !!(s.backendUrl && s.apiKey), backendUrl: s.backendUrl || '' }));
    return true;
  }
  return false;
});
