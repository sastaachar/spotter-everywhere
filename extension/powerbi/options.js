const form = document.getElementById('form');
const backendUrl = document.getElementById('backendUrl');
const apiKey = document.getElementById('apiKey');
const worksheetId = document.getElementById('worksheetId');
const thoughtSpotHost = document.getElementById('thoughtSpotHost');
const status = document.getElementById('status');

chrome.storage.local.get(['backendUrl', 'apiKey', 'worksheetId', 'thoughtSpotHost']).then((s) => {
  backendUrl.value = s.backendUrl || '';
  apiKey.value = s.apiKey || '';
  worksheetId.value = s.worksheetId || '';
  thoughtSpotHost.value = s.thoughtSpotHost || '';
});

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  let url;
  try {
    url = new URL(backendUrl.value.trim());
  } catch {
    status.textContent = 'Enter a full URL including https://';
    return;
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    status.textContent = 'Backend must use https (http is allowed for localhost only).';
    return;
  }
  let host = thoughtSpotHost.value.trim();
  if (host) {
    try { host = new URL(host).origin; } catch { status.textContent = 'ThoughtSpot host must be a full URL.'; return; }
  }
  await chrome.storage.local.set({
    backendUrl: url.origin,
    apiKey: apiKey.value,
    worksheetId: worksheetId.value.trim(),
    thoughtSpotHost: host,
  });
  status.textContent = 'Saved';
});
