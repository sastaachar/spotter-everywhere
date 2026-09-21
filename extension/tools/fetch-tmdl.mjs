// Extract a Power BI report's semantic model as TMDL.
//
// Drives an already-open, already-signed-in Chrome over CDP: every call runs in
// the page's own context, reusing `window.powerBIAccessToken`, so there is no
// separate Azure AD app registration or consent flow to set up.
//
//   node fetch-tmdl.mjs [--port 9223] [--out ./tmdl]
//
// Requires a Power BI report tab open in that browser.

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const PORT = arg('port', '9223');
const OUT = arg('out', './tmdl');

const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && /powerbi\.com\/.*\/reports\//.test(t.url));
if (!page) {
  console.error('No Power BI report tab found on port ' + PORT + '. Open a report first.');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const send = (method, params) => new Promise((res) => {
  const myId = ++id;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === myId) { ws.removeEventListener('message', on); res(m.result); } };
  ws.addEventListener('message', on);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

console.log('report tab:', page.url.split('?')[0]);

// The dataset guid is not in the URL; it is the model's dbName in the report's
// own exploration payload. The workspace comes from the URL, except for the
// personal workspace, which the URL spells "me".
const ids = JSON.parse(await evaluate(`(async()=>{
  const H={Authorization:'Bearer '+window.powerBIAccessToken};
  const m=(performance.getEntriesByType('resource').map(e=>e.name)
    .find(n=>/analysis\\.windows\\.net\\/explore\\/reports\\/\\d+\\//.test(n))||'')
    .match(/^(https:\\/\\/[^/]*analysis\\.windows\\.net)\\/explore\\/reports\\/(\\d+)\\//);
  if(!m) return JSON.stringify({error:'could not discover the backend host; reload the report tab'});
  const ex=await (await fetch(m[1]+'/explore/reports/'+m[2]+'/exploration',{headers:H})).json();
  const rep=ex.report||{};
  const urlWs=(location.pathname.match(/\\/groups\\/([^/]+)\\//)||[])[1]||null;
  let workspaceId=urlWs;
  if(!urlWs||urlWs==='me'){
    const wl=await (await fetch('https://api.fabric.microsoft.com/v1/workspaces',{headers:H})).json();
    const personal=(wl.value||[]).find(w=>w.type==='Personal');
    workspaceId=personal?personal.id:null;
  }
  return JSON.stringify({
    base:m[1], reportKey:m[2],
    reportName:rep.displayName||null,
    datasetId:rep.model&&rep.model.dbName||null,
    workspaceId,
  });})()`));

if (ids.error) { console.error(ids.error); process.exit(1); }
if (!ids.datasetId || !ids.workspaceId) {
  console.error('could not resolve ids:', JSON.stringify(ids));
  process.exit(1);
}
console.log('report  :', ids.reportName);
console.log('dataset :', ids.datasetId);
console.log('workspace:', ids.workspaceId);

// getDefinition is a long-running operation: 202 + Location to poll.
const raw = await evaluate(`(async()=>{
  const H={Authorization:'Bearer '+window.powerBIAccessToken};
  const url='https://api.fabric.microsoft.com/v1/workspaces/${ids.workspaceId}/semanticModels/${ids.datasetId}/getDefinition?format=TMDL';
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  let r=await fetch(url,{method:'POST',headers:H});
  if(r.status===200) return await r.text();
  if(r.status!==202) return JSON.stringify({error:r.status+' '+r.statusText,body:(await r.text()).slice(0,400)});
  const loc=r.headers.get('Location');
  for(let i=0;i<40;i++){
    await sleep(1500);
    const p=await fetch(loc,{headers:H});
    if(p.status!==200) continue;
    const st=await p.json();
    if(st.status==='Succeeded') return await (await fetch(loc+'/result',{headers:H})).text();
    if(st.status==='Failed') return JSON.stringify({error:'operation failed',body:JSON.stringify(st).slice(0,400)});
  }
  return JSON.stringify({error:'timed out waiting for getDefinition'});})()`);

const parsed = JSON.parse(raw);
if (parsed.error) { console.error('\n' + parsed.error, parsed.body || ''); process.exit(1); }

let total = 0;
for (const part of parsed.definition.parts) {
  const content = Buffer.from(part.payload, 'base64');
  const dest = `${OUT}/${part.path}`;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
  total += content.length;
  console.log(String(content.length).padStart(7), part.path);
}
console.log(`\n${parsed.definition.parts.length} parts, ${(total / 1024).toFixed(1)} KB -> ${OUT}`);
ws.close();
