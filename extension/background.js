import { config } from './src/config.js';

const CREATE_SESSION = 'spotter:create-session';
const CREATE_DATASET = 'spotter:create-dataset';

async function createSession(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/session', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.backendApiKey ? { Authorization: 'Bearer ' + config.backendApiKey } : {}),
      },
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
  return { session: body, url: new URL('/session/' + body.id, config.backendUrl).toString() };
}

// Load a platform's rows into ThoughtSpot and wrap them in a worksheet.
async function createDataset(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/dataset', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.backendApiKey ? { Authorization: 'Bearer ' + config.backendApiKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: 'Could not reach the backend: ' + (err && err.message ? err.message : String(err)) };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const code = body && (body.detail || body.error) ? (body.detail || body.error) : 'HTTP ' + res.status;
    return { error: 'Worksheet build failed: ' + code };
  }
  return { dataset: body };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === CREATE_SESSION) {
    createSession(message.payload).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === CREATE_DATASET) {
    createDataset(message.payload).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  return false;
});
