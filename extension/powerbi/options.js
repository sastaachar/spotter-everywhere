const form = document.getElementById('form');
const backendUrl = document.getElementById('backendUrl');
const apiKey = document.getElementById('apiKey');
const status = document.getElementById('status');

chrome.storage.local.get(['backendUrl', 'apiKey']).then((s) => {
  backendUrl.value = s.backendUrl || '';
  apiKey.value = s.apiKey || '';
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
  await chrome.storage.local.set({ backendUrl: url.origin, apiKey: apiKey.value });
  status.textContent = 'Saved';
});
