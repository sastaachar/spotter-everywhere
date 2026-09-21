import { config } from './src/config.js';
import { devCredentials } from './src/dev-credentials.js';

const CREATE_SESSION = 'spotter:create-session';
const CREATE_DATASET = 'spotter:create-dataset';
const CHECK_DATASET = 'spotter:check-dataset';
const CREATE_LIVEBOARD = 'spotter:create-liveboard';
const GET_LIVEBOARD = 'spotter:get-liveboard';
const EMBED_TOKEN = 'spotter:embed-token';
const CACHE_GET = 'spotter:cache-get';
const CACHE_SET = 'spotter:cache-set';

// Per-sheet resume cache (chrome.storage.local): lets a reload/reopen skip the
// slow "pull rows -> load into ThoughtSpot" pipeline and open the worksheet we
// already built. Content scripts can't touch chrome.storage, so it lives here.
async function cacheGet(key) {
  if (!key) return { entry: null };
  try {
    const all = await chrome.storage.local.get(key);
    return { entry: all[key] || null };
  } catch (err) {
    return { entry: null };
  }
}

async function cacheSet(key, entry) {
  if (!key) return { ok: false };
  try {
    await chrome.storage.local.set({ [key]: entry });
    return { ok: true };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

async function createSession(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/session', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
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
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
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

// Read-only: does the user / data model / worksheet already exist for this
// sheet? Lets the panel show what's done and skip rebuilding. Never throws — a
// backend/network failure returns { error } and the caller falls back to build.
async function checkDataset(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/dataset/check', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
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
    return { error: 'Existence check failed: ' + code };
  }
  return { check: body };
}

// Cheap existence check by (platform, guid) — no download, no build.
async function getLiveboard(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/get-liveboard', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: 'Could not reach the backend: ' + ((err && err.message) || String(err)) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body && (body.detail || body.error) ? (body.detail || body.error) : 'HTTP ' + res.status;
    return { error: 'Liveboard lookup failed: ' + detail, body };
  }
  return { body };
}

// Build-once, reuse-by-name liveboard. Returns { body, notBuilt } — notBuilt
// means the caller should fetch the platform model and resend it with the file.
async function createLiveboard(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/create-liveboard', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: 'Could not reach the backend: ' + ((err && err.message) || String(err)) };
  }
  const body = await res.json().catch(() => null);
  if (res.status === 404 && body && body.error === 'not_built') return { notBuilt: true };
  if (!res.ok) {
    const detail = body && (body.detail || body.error) ? (body.detail || body.error) : 'HTTP ' + res.status;
    return { error: 'Liveboard build failed: ' + detail, body };
  }
  return { body };
}

// Trusted-auth token for the panel, minted by the backend AS the platform user
// (JIT-provisioned there). The extension never holds cluster credentials, so
// this is the only auth path that works on a cluster we have no login for.
async function embedToken(payload) {
  if (!config.backendUrl) return { error: 'No backend configured (see extension/src/config.js).' };
  let res;
  try {
    res = await fetch(new URL('/embed-token', config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { error: 'Could not reach the backend: ' + ((err && err.message) || String(err)) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || typeof body.token !== 'string') {
    const detail = body && (body.detail || body.error) ? (body.detail || body.error) : 'HTTP ' + res.status;
    return { error: 'Embed token failed: ' + detail };
  }
  return { token: body.token, host: body.host };
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
  if (message.type === CHECK_DATASET) {
    checkDataset(message.payload).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === GET_LIVEBOARD) {
    getLiveboard(message.payload || {}).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === CREATE_LIVEBOARD) {
    createLiveboard(message.payload || {}).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === EMBED_TOKEN) {
    embedToken(message.payload || {}).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  if (message.type === CACHE_GET) {
    cacheGet(message.payload && message.payload.key).then(sendResponse, () => sendResponse({ entry: null }));
    return true;
  }
  if (message.type === CACHE_SET) {
    cacheSet(message.payload && message.payload.key, message.payload && message.payload.entry).then(sendResponse, (err) => sendResponse({ error: String((err && err.message) || err) }));
    return true;
  }
  return false;
});
