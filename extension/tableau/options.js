const FIELDS = ['tsHost', 'tsUsername', 'tsPassword', 'worksheetId', 'backendUrl', 'apiKey'];
const form = document.getElementById('form');
const status = document.getElementById('status');
const inputs = Object.fromEntries(FIELDS.map((k) => [k, document.getElementById(k)]));

chrome.storage.local.get(FIELDS).then((s) => {
  for (const k of FIELDS) inputs[k].value = s[k] || '';
});

function checkOrigin(value, allowLocalhost) {
  if (!value) return { origin: '' };
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'Enter a full URL including https://' };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(allowLocalhost && local)) {
    return { error: 'URL must use https' + (allowLocalhost ? ' (http is allowed for localhost only)' : '') + '.' };
  }
  return { origin: url.origin };
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ts = checkOrigin(inputs.tsHost.value, false);
  if (ts.error) return (status.textContent = 'ThoughtSpot host: ' + ts.error);
  const backend = checkOrigin(inputs.backendUrl.value, true);
  if (backend.error) return (status.textContent = 'Backend URL: ' + backend.error);
  await chrome.storage.local.set({
    tsHost: ts.origin,
    tsUsername: inputs.tsUsername.value.trim(),
    tsPassword: inputs.tsPassword.value,
    worksheetId: inputs.worksheetId.value.trim(),
    backendUrl: backend.origin,
    apiKey: inputs.apiKey.value,
  });
  status.textContent = 'Saved';
});
