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
const DATASET_STREAM = 'spotter:dataset-stream';
const LIVEBOARD_STREAM = 'spotter:liveboard-stream';

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

// Streaming variant of /dataset: POST ?stream=1 and forward each NDJSON line to
// the content script over `port`. The final line is the {stage:'result',...}
// body; we send {done:true} when the stream ends, {error} on any failure.
async function streamBuild(path, failLabel, payload, port) {
  const safePost = (m) => { try { port.postMessage(m); } catch (e) { /* port closed */ } };
  if (!config.backendUrl) { safePost({ error: 'No backend configured (see extension/src/config.js).' }); return; }
  let res;
  try {
    res = await fetch(new URL(path, config.backendUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
        ...(devCredentials.backendApiKey ? { Authorization: 'Bearer ' + devCredentials.backendApiKey } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    safePost({ error: 'Could not reach the backend: ' + ((err && err.message) || String(err)) });
    return;
  }
  if (!res.ok || !res.body) {
    // A pre-stream failure (401/503/400) comes back as JSON, not a stream.
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const detail = (body && (body.detail || body.error)) || ('HTTP ' + res.status);
    safePost({ error: failLabel + ': ' + detail });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const flush = (line) => {
    const s = line.trim();
    if (!s) return;
    try { safePost(JSON.parse(s)); } catch (e) { /* skip a malformed line */ }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        flush(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    flush(buf);
    safePost({ done: true });
  } catch (err) {
    safePost({ error: 'Stream read failed: ' + ((err && err.message) || String(err)) });
  }
}

// Streaming /dataset (worksheet build) and /create-liveboard, each over its own
// Port. Same NDJSON transport; only the path and error label differ.
const streamDataset = (payload, port) => streamBuild('/dataset?stream=1', 'Worksheet build failed', payload, port);
const streamLiveboard = (payload, port) => streamBuild('/create-liveboard?stream=1', 'Liveboard build failed', payload, port);

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

// Streaming needs more than one message back, which onMessage can't do, so the
// content script opens a Port: it sends one { payload }, we stream events back.
chrome.runtime.onConnect.addListener((port) => {
  const run = port.name === DATASET_STREAM ? streamDataset
    : port.name === LIVEBOARD_STREAM ? streamLiveboard
    : null;
  if (!run) return;
  port.onMessage.addListener(async (msg) => {
    const payload = msg && msg.payload;
    if (!payload) { try { port.postMessage({ error: 'no payload' }); } catch (e) {} return; }
    try { await run(payload, port); } finally { try { port.disconnect(); } catch (e) {} }
  });
});
