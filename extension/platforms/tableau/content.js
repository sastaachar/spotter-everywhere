(() => {
  // Tableau regenerates the digits in title<digits>_<digits> per session.
  const TITLE_ID_PATTERN = /^title\d+_\d+$/;
  const TITLE_ROOT_SELECTOR = '[id^="title"]';
  const TITLE_TEXT_PATH = ':scope > div:nth-child(1) > div > span > div';
  const INJECTED_ATTR = 'data-ts-spotter';
  const BUTTON_CLASS = 'ts-spotter-btn';
  const PANEL_CLASS = 'ts-spotter-panel';
  const OPEN_EVENT = 'spotter:open';
  const VIZ_CONTAINER_SELECTOR = '[data-tb-test-id="VisualizationContainer"]';
  const ZONE_SELECTOR = '.tab-zone';
  const ZONE_ID_PREFIX = 'tabZoneId';
  const DASHBOARD_REGION_ID = 'tab-dashboard-region';
  const VIEW_PATH_PATTERN = /^\/t\/([^/]+)\/views\/([^/]+)\/([^/?#]+)/;
  const SESSION_PATTERN = /\/sessions\/([^/?]+)/;
  const SCAN_DEBOUNCE_MS = 100;
  const REQUEST_EVENT = 'spotter:request';
  const RESPONSE_EVENT = 'spotter:response';
  const REQUEST_TIMEOUT_MS = 30000;
  const UNDERLYING_CAP = 10000;
  const UNDERLYING_CHUNK = 500;
  const CREATE_SESSION = 'spotter:create-session';
  const CREATE_DATASET = 'spotter:create-dataset';
  const CHECK_DATASET = 'spotter:check-dataset';
  const CREATE_LIVEBOARD = 'spotter:create-liveboard';
  const GET_LIVEBOARD = 'spotter:get-liveboard';
  const CACHE_GET = 'spotter:cache-get';
  const CACHE_SET = 'spotter:cache-set';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const PLATFORM = 'tableau';
  const LB_BUTTON_CLASS = 'ts-lb-btn';
  const FRAME_CLASS = 'ts-spotter-frame';
  const CLOSE_EVENT = 'spotter:close';
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

  // Backend that turns a Tableau workbook into a Spotter-searchable worksheet.
  // Point this at the local Worker (wrangler dev) or the deployed Cloudflare URL.
  const BACKEND_URL = 'http://localhost:8799';
  // Dev only. Do NOT ship a shared key in a real extension — issue per-user
  // tokens and store them per install. Empty means the backend calls will 401.
  const BACKEND_API_KEY = '';

  const SPARKLE_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z"/>' +
    '<path d="M13 11l.7 1.8L15.5 13.5l-1.8.7L13 16l-.7-1.8-1.8-.7 1.8-.7z"/>' +
    '</svg>';

  function findTitleTargets(root) {
    const targets = [];
    root.querySelectorAll(TITLE_ROOT_SELECTOR).forEach((el) => {
      if (!TITLE_ID_PATTERN.test(el.id)) return;
      const textEl = el.querySelector(TITLE_TEXT_PATH);
      if (textEl) targets.push({ titleRoot: el, textEl });
    });
    return targets;
  }

  function vizContext(titleRoot, sheetTitle) {
    const pathMatch = location.pathname.match(VIEW_PATH_PATTERN) || [];
    const zone = titleRoot.closest(ZONE_SELECTOR);
    const viz = titleRoot.closest(VIZ_CONTAINER_SELECTOR);
    const sessionEntry = performance
      .getEntriesByType('resource')
      .map((e) => e.name.match(SESSION_PATTERN))
      .find(Boolean);
    return {
      site: pathMatch[1] || null,
      workbook: pathMatch[2] || null,
      dashboard: pathMatch[3] ? decodeURIComponent(pathMatch[3]) : null,
      isDashboard: !!document.getElementById(DASHBOARD_REGION_ID),
      worksheet: viz ? viz.getAttribute('tb-test-id') : null,
      sheetTitle,
      zoneId: zone && zone.id.startsWith(ZONE_ID_PREFIX) ? zone.id.slice(ZONE_ID_PREFIX.length) : null,
      titleElementId: titleRoot.id,
      sessionId: sessionEntry ? sessionEntry[1] : null,
      url: location.href,
    };
  }

  function buildButton(titleRoot, sheetTitle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.title = 'Ask Spotter about this sheet';
    btn.setAttribute('aria-label', 'Open Spotter');
    btn.innerHTML = SPARKLE_SVG + '<span>Spotter</span>';
    btn.title = 'Ask Spotter about this sheet (Shift+click to rebuild, Alt+click for details)';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const context = vizContext(titleRoot, sheetTitle());
      if (ev.altKey) openPanel(context);
      else openSpotter(context, { rebuild: ev.shiftKey });
    });
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    return btn;
  }

  function inject({ titleRoot, textEl }) {
    // Tableau's bootstrap replaces the inner text region after we inject,
    // so gate on the button itself rather than a marker on the outer div.
    if (textEl.querySelector(':scope > .' + BUTTON_CLASS)) return;
    titleRoot.setAttribute(INJECTED_ATTR, '1');
    const isOurBtn = (n) => n instanceof Element && (n.classList.contains(BUTTON_CLASS) || n.classList.contains(LB_BUTTON_CLASS));
    const sheetTitle = () =>
      Array.from(textEl.childNodes)
        .filter((n) => !isOurBtn(n))
        .map((n) => n.textContent || '')
        .join('')
        .trim();
    textEl.appendChild(buildButton(titleRoot, sheetTitle));
  }

  // One Liveboard button per embedded Tableau view, pinned to the top-right of
  // this embed frame (not per-viz like Spotter). Only added in a frame whose URL
  // is a Tableau view (`/t/<site>/views/<workbook>/<view>`), i.e. the embed.
  function ensureLiveboardButton() {
    if (!VIEW_PATH_PATTERN.test(location.pathname)) return;
    if (document.body.querySelector(':scope > .' + LB_BUTTON_CLASS)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = LB_BUTTON_CLASS;
    btn.title = 'Replace this Tableau view with a ThoughtSpot Liveboard';
    btn.setAttribute('aria-label', 'Open as Liveboard');
    btn.innerHTML = '<span>◧ Liveboard</span>';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const m = location.pathname.match(VIEW_PATH_PATTERN) || [];
      openLiveboard({
        site: m[1] || null,
        workbook: m[2] || null,
        dashboard: m[3] ? decodeURIComponent(m[3]) : null,
        url: location.href,
      });
    });
    document.body.appendChild(btn);
  }

  // Resolve the current view's workbook via the session (same-origin vizportal):
  // name, LUID, and the download URL for its .twb/.twbx.
  async function resolveWorkbook(context) {
    const xsrf = (document.cookie.match(/XSRF-TOKEN=([^;]+)/) || [])[1] || '';
    const call = (method, params) =>
      fetch('/vizportal/api/web/v1/' + method, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-XSRF-TOKEN': xsrf },
        body: JSON.stringify({ method, params }),
      }).then((r) => r.json());
    const path = context.workbook && context.dashboard ? context.workbook + '/' + context.dashboard : null;
    if (!path) throw new Error('could not determine the view path');
    const view = (await call('getViewByPath', { path })).result;
    const ref = view && view.workbook;
    if (!ref) throw new Error('could not resolve the workbook for this view');
    const wb = (await call('getWorkbook', { id: ref.id })).result || {};
    return { name: ref.name, luid: ref.luid, downloadUrl: wb.downloadUrl };
  }

  async function fetchWorkbookBase64(downloadUrl) {
    const res = await fetch(downloadUrl, { credentials: 'include' });
    if (!res.ok) {
      throw new Error(res.status === 403 ? 'you lack download permission on this workbook' : 'workbook download failed (' + res.status + ')');
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function workerCall(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('no response from the extension worker'));
        resolve(res);
      });
    });
  }

  async function openLiveboard(context) {
    closePanel();
    const loading = el('aside', FRAME_CLASS + ' ts-spotter-loading');
    loading.textContent = 'Preparing the liveboard…';
    document.body.appendChild(loading);
    if (!extensionAlive()) { loading.textContent = RELOAD_MSG; return; }

    const fail = (msg) => {
      loading.textContent = msg;
    };
    try {
      const wb = await resolveWorkbook(context);
      const guid = wb.luid;
      if (!guid) return fail('Could not resolve the workbook id for this view.');

      // Build once: look it up by (platform, guid) first — no download.
      let liveboardId;
      const found = await workerCall(GET_LIVEBOARD, { platform: PLATFORM, guid });
      if (found.error && !/reach the backend/i.test(found.error)) return fail(found.error);
      if (found.error) return fail(found.error);
      if (found.body && found.body.exists) {
        liveboardId = found.body.liveboardId;
      } else {
        // Build from real data: pull the dashboard's first worksheet's rows and
        // send them, so the liveboard is populated (not an empty schema).
        loading.textContent = 'Reading the dashboard data…';
        const list = await requestWorksheetData(null, 'worksheets');
        const first = list && list.worksheets && list.worksheets[0];
        if (!first) return fail('No worksheets found in this view to build a liveboard from.');
        loading.textContent = 'Loading “' + first.name + '” into ThoughtSpot…';
        const data = await requestWorksheetData(first.name, 'underlying');
        const columns = data.columns.map((col) => ({
          name: col.name,
          type: /int|float|real|number|decimal|double/i.test(col.type || '') ? 'MEASURE' : 'ATTRIBUTE',
          dataType: col.type,
        }));
        const res = await workerCall(CREATE_LIVEBOARD, { platform: PLATFORM, guid, data: { columns, rows: data.rows } });
        if (res.error) return fail(res.error);
        liveboardId = res.body && res.body.liveboardId;
      }
      if (!liveboardId) return fail('The liveboard was not created.');

      loading.remove();
      const frame = document.createElement('iframe');
      frame.className = FRAME_CLASS;
      frame.title = 'Liveboard';
      frame.src = chrome.runtime.getURL('panel.html') + '#'
        + encodeURIComponent(JSON.stringify({ ...context, platform: PLATFORM, liveboardId, workbook: wb.name }));
      document.body.appendChild(frame);
    } catch (e) {
      fail((e && e.message) || String(e));
    }
  }

  const PANEL_ROWS = [
    ['Dashboard', (c) => (c.isDashboard ? c.dashboard : c.dashboard + ' (sheet view)')],
    ['Workbook', (c) => c.workbook],
    ['Worksheet', (c) => c.worksheet],
    ['Sheet title', (c) => c.sheetTitle],
    ['Zone id', (c) => c.zoneId],
    ['Site', (c) => c.site],
    ['VizQL session', (c) => c.sessionId],
    ['Title element', (c) => c.titleElementId],
  ];

  function buildRows(context) {
    const dl = document.createElement('dl');
    dl.className = 'ts-spotter-rows';
    PANEL_ROWS.forEach(([label, pick]) => {
      const value = pick(context);
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value == null || value === '' ? '\u2014' : String(value);
      dl.append(dt, dd);
    });
    return dl;
  }

  let requestSeq = 0;
  const pendingRequests = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !ev.data || ev.data.type !== RESPONSE_EVENT) return;
    const pending = pendingRequests.get(ev.data.requestId);
    if (!pending) return;
    pendingRequests.delete(ev.data.requestId);
    clearTimeout(pending.timer);
    if (ev.data.error) pending.reject(new Error(ev.data.error));
    else pending.resolve(ev.data.result);
  });

  function requestWorksheetData(worksheet, kind) {
    if (window.parent === window) {
      return Promise.reject(new Error('Not inside the Tableau portal page; data bridge unavailable.'));
    }
    const requestId = ++requestSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error('Timed out waiting for the data bridge.'));
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { resolve, reject, timer });
      window.parent.postMessage({ type: REQUEST_EVENT, requestId, worksheet, kind }, location.origin);
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function describeFilter(f) {
    if (f.values) return f.field + ': ' + (f.exclude ? 'exclude ' : '') + f.values.join(', ');
    if (f.min != null) return f.field + ': ' + f.min + ' to ' + f.max;
    if (f.period) return f.field + ': ' + f.range + ' ' + f.period;
    return f.field + ': ' + f.type;
  }

  function buildShape(data) {
    const dl = el('dl', 'ts-spotter-rows');
    const add = (label, value) => dl.append(el('dt', null, label), el('dd', null, value));
    add('Rows', String(data.totalRows));
    add('Columns', data.columns.map((c) => c.name + ' (' + c.type + ')').join('\n'));
    add('Filters', data.filters.length ? data.filters.map(describeFilter).join('\n') : 'none');
    add('Parameters', data.parameters.length ? data.parameters.map((p) => p.name + ' = ' + p.value).join('\n') : 'none');
    add('Selected marks', String(data.selectedMarks));
    return dl;
  }

  function appendRows(tbody, rows, from, to) {
    for (let i = from; i < to; i++) {
      const tr = el('tr');
      tr.appendChild(el('td', 'ts-spotter-rownum', String(i + 1)));
      rows[i].forEach((cell) => tr.appendChild(el('td', null, cell == null ? '' : String(cell))));
      tbody.appendChild(tr);
    }
  }

  function buildTable(data, chunk) {
    const wrap = el('div');
    const table = el('table', 'ts-spotter-table');
    const headRow = el('tr');
    headRow.appendChild(el('th', null, '#'));
    data.columns.forEach((c) => headRow.appendChild(el('th', null, c.name)));
    const head = el('thead');
    head.appendChild(headRow);
    const tbody = el('tbody');
    table.append(head, tbody);
    wrap.appendChild(table);

    const size = chunk || data.rows.length;
    let shown = Math.min(size, data.rows.length);
    appendRows(tbody, data.rows, 0, shown);
    if (shown < data.rows.length) {
      const more = el('button', 'ts-spotter-more');
      more.type = 'button';
      const label = () => 'Show ' + Math.min(size, data.rows.length - shown) + ' more (' + shown + ' of ' + data.rows.length + ')';
      more.textContent = label();
      more.addEventListener('click', () => {
        const next = Math.min(shown + size, data.rows.length);
        appendRows(tbody, data.rows, shown, next);
        shown = next;
        if (shown >= data.rows.length) more.remove();
        else more.textContent = label();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function sessionPayload(context, summary, underlying) {
    const data = underlying || summary;
    return {
      platform: PLATFORM,
      context: {
        site: context.site,
        workbook: context.workbook,
        dashboard: context.dashboard,
        isDashboard: context.isDashboard,
        worksheet: context.worksheet,
        sheetTitle: context.sheetTitle,
        zoneId: context.zoneId,
        url: context.url,
        dataKind: underlying ? 'underlying' : 'summary',
        summaryRows: summary.totalRows,
        filters: JSON.stringify(summary.filters),
        parameters: JSON.stringify(summary.parameters),
      },
      data: { columns: data.columns, rows: data.rows, totalRows: data.totalRows },
    };
  }

  function sendSection(context, summary, getUnderlying) {
    const section = el('div');
    const send = el('button', 'ts-spotter-more');
    send.type = 'button';
    send.textContent = 'Send to Spotter backend';
    const result = el('div', 'ts-spotter-note');
    send.addEventListener('click', () => {
      send.disabled = true;
      send.textContent = 'Sending…';
      const payload = sessionPayload(context, summary, getUnderlying());
      chrome.runtime.sendMessage({ type: CREATE_SESSION, payload }, (res) => {
        send.disabled = false;
        send.textContent = 'Send to Spotter backend';
        if (!res || res.error) {
          result.textContent = res && res.error ? res.error : 'No response from the extension background.';
          return;
        }
        result.textContent = 'Session ' + res.session.id + ' (' + payload.context.dataKind + ', ' + payload.data.rows.length + ' rows) at ' + res.url;
      });
    });
    section.append(send, result);
    return section;
  }

  function underlyingSection(worksheet, onLoaded) {
    const section = el('div');
    const load = el('button', 'ts-spotter-more');
    load.type = 'button';
    load.textContent = 'Load underlying rows (all columns, up to ' + UNDERLYING_CAP.toLocaleString() + ')';
    load.addEventListener('click', () => {
      load.disabled = true;
      load.textContent = 'Loading underlying rows…';
      requestWorksheetData(worksheet, 'underlying').then(
        (data) => {
          load.remove();
          onLoaded(data);
          const capped = data.rows.length >= UNDERLYING_CAP;
          section.append(
            el('div', 'ts-spotter-note', data.rows.length.toLocaleString() + ' rows × ' + data.columns.length + ' columns' + (capped ? ' (API cap reached; the table may be larger)' : '')),
            buildTable(data, UNDERLYING_CHUNK)
          );
        },
        (err) => {
          load.disabled = false;
          load.textContent = 'Retry: ' + err.message;
        }
      );
    });
    section.appendChild(load);
    return section;
  }

  function fillData(body, context) {
    if (!context.worksheet) {
      body.textContent = 'No worksheet found behind this title.';
      return;
    }
    body.textContent = 'Loading data for ' + context.worksheet + '…';
    requestWorksheetData(context.worksheet, 'summary').then(
      (data) => {
        let underlying = null;
        body.textContent = '';
        body.append(
          el('h3', null, 'Shape'),
          buildShape(data),
          el('h3', null, 'Backend'),
          sendSection(context, data, () => underlying),
          el('h3', null, 'Summary data (' + data.rows.length + ' rows)'),
          buildTable(data),
          el('h3', null, 'Underlying data'),
          underlyingSection(context.worksheet, (loaded) => {
            underlying = loaded;
          })
        );
      },
      (err) => {
        body.textContent = err.message;
      }
    );
  }

  // POST a Tableau workbook (.twb/.twbx) to the backend → Spotter worksheet.
  async function createSpotterWorksheet(file, userid, platform) {
    const form = new FormData();
    form.append('userid', userid);
    form.append('platform', platform);
    form.append('file', file);
    const res = await fetch(BACKEND_URL + '/worksheet', {
      method: 'POST',
      headers: BACKEND_API_KEY ? { Authorization: 'Bearer ' + BACKEND_API_KEY } : {},
      body: form,
    });
    if (!res.ok) throw new Error('Worksheet build failed: HTTP ' + res.status);
    return res.json();
  }

  // Panel section: pick a workbook file → build a worksheet → open in Spotter.
  function worksheetBuilderSection(context) {
    const wrap = el('div', 'ts-spotter-wsbuilder');
    wrap.append(el('h3', null, 'Build Spotter worksheet from workbook'));
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.twb,.twbx,.tds,.tdsx';
    const status = el('div', 'ts-spotter-wsstatus');
    const go = el('button', 'ts-spotter-more', 'Create worksheet');
    go.type = 'button';
    go.addEventListener('click', async () => {
      const file = input.files && input.files[0];
      if (!file) { status.textContent = 'Pick a .twb / .twbx file first.'; return; }
      status.textContent = 'Uploading ' + file.name + '…';
      try {
        const userid = context.site || 'user';
        const r = await createSpotterWorksheet(file, userid, 'tableau');
        status.textContent = '';
        status.append(el('div', null, 'Worksheet: ' + r.worksheet.name));
        status.append(el('div', null, r.worksheet.columns.length + ' columns'));
        if (r.searchUrl) {
          const a = el('a', 'ts-spotter-open', 'Open in Spotter ↗');
          a.href = r.searchUrl;
          a.target = '_blank';
          a.rel = 'noopener';
          status.append(a);
        } else {
          status.append(el('div', null, 'Generated (configure TS on the backend to auto-import).'));
        }
      } catch (e) {
        status.textContent = e.message;
      }
    });
    wrap.append(input, go, status);
    return wrap;
  }

  function openPanel(context) {
    closePanel();
    const panel = document.createElement('aside');
    panel.className = PANEL_CLASS;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Spotter');

    const header = document.createElement('header');
    const heading = document.createElement('span');
    heading.textContent = 'Spotter';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ts-spotter-close';
    close.setAttribute('aria-label', 'Close Spotter');
    close.textContent = '×';
    close.addEventListener('click', closePanel);
    header.append(heading, close);

    const body = el('div', 'ts-spotter-body');
    panel.append(header, buildRows(context), body, worksheetBuilderSection(context));
    document.body.appendChild(panel);
    fillData(body, context);

    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: context }));
  }

  function closePanel() {
    document.querySelectorAll('.' + PANEL_CLASS).forEach((el) => el.remove());
    document.querySelectorAll('.' + FRAME_CLASS).forEach((el) => el.remove());
    if (window.__spotterPanel) window.__spotterPanel.close();
  }

  // Best-effort logged-in Tableau user (via the bridge); fall back to the site.
  function resolveUserId(context) {
    return requestWorksheetData(null, 'user').then(
      (u) => (u && u.username) || context.site || 'tableau_user',
      () => context.site || 'tableau_user'
    );
  }

  // Load this sheet's rows into ThoughtSpot via the backend (service worker,
  // not CORS-restricted): provision/reuse the user, load into Falcon, build a
  // worksheet. Returns the /dataset response body.
  function createDataset(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: CREATE_DATASET, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res || res.error) return reject(new Error((res && res.error) || 'dataset request failed'));
        resolve(res.dataset); // background wraps the /dataset body as { dataset }
      });
    });
  }

  // Ask the backend what already exists for this sheet (user / data model /
  // worksheet). Resolves null on any failure so the caller just builds instead.
  function checkDataset(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: CHECK_DATASET, payload }, (res) => {
          if (chrome.runtime.lastError || !res || res.error) return resolve(null);
          resolve(res.check || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Identity of the viewed sheet — stable across reloads (Tableau regenerates
  // only the title element id, not these fields). The backend refreshes the data
  // in place on rebuild; Shift+click forces that path when a filter changed.
  function datasetCacheKey(context) {
    return [
      'ds', PLATFORM, context.site, context.workbook,
      context.dashboard || '', context.worksheet || '', context.sheetTitle || '',
    ].join('|');
  }

  // The resume cache lives in the background service worker (chrome.storage);
  // both calls degrade to a miss/no-op if the worker is unreachable.
  function cacheGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: CACHE_GET, payload: { key } }, (res) => {
          if (chrome.runtime.lastError || !res) return resolve(null);
          resolve(res.entry || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function cacheSet(key, entry) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: CACHE_SET, payload: { key, entry } }, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  // Progress checklist shown in the loading overlay: each step spins while
  // active and turns into a green check when done or reused (red on failure).
  const STEP_DEFS = [
    { key: 'user', label: 'Signing in' },
    { key: 'check', label: 'Checking ThoughtSpot' },
    { key: 'data', label: 'Reading sheet data' },
    { key: 'load', label: 'Loading into ThoughtSpot' },
    { key: 'worksheet', label: 'Preparing the worksheet' },
    { key: 'open', label: 'Opening Spotter' },
  ];
  function buildChecklist(container) {
    container.textContent = '';
    const wrap = el('div', 'ts-spotter-steps');
    wrap.appendChild(el('div', 'ts-spotter-steps-title', 'Setting up Spotter'));
    const rows = {};
    STEP_DEFS.forEach((s) => {
      const row = el('div', 'ts-spotter-step');
      row.dataset.state = 'pending';
      const icon = el('span', 'ts-spotter-step-icon');
      const label = el('span', 'ts-spotter-step-label', s.label);
      const detail = el('span', 'ts-spotter-step-detail');
      row.append(icon, label, detail);
      wrap.appendChild(row);
      rows[s.key] = { row, detail };
    });
    container.appendChild(wrap);
    // state: pending | active | done | skip | error; detail is optional text.
    return function setStep(key, state, detailText) {
      const r = rows[key];
      if (!r) return;
      r.row.dataset.state = state;
      if (detailText != null) r.detail.textContent = detailText;
    };
  }

  // True while this content script still belongs to a live extension context.
  // After the extension is reloaded/updated, an already-injected content script
  // lingers but its chrome.* calls throw "Extension context invalidated" until
  // the page is reloaded — detect that and ask for a refresh instead of crashing.
  function extensionAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  const RELOAD_MSG = 'Spotter was updated — reload this page (⌘R / F5) to continue.';

  // The real pipeline: verify what already exists -> (reuse, or read rows +
  // load into Falcon + build a worksheet) -> open panel.html embedding THAT
  // worksheet, authenticated AS the user. Each step reports into the checklist;
  // a cache hit resumes instantly and a backend check lets us skip a rebuild.
  async function openSpotter(context, options = {}) {
    closePanel();
    const loading = el('aside', FRAME_CLASS + ' ts-spotter-loading');
    document.body.appendChild(loading);
    if (!extensionAlive()) { loading.textContent = RELOAD_MSG; return; }
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: context }));
    const setStep = buildChecklist(loading);

    const openPanelFrame = (extra) => {
      // Mount Spotter in the Tableau page, NOT the extension's panel.html: the
      // SDK derives hostAppUrl from window.location.host, and from a
      // chrome-extension:// origin the cluster 401s every embed call so Spotter
      // never starts a conversation. window.__spotterPanel is set by
      // dist/inpage-panel.js, loaded as a content script alongside this one.
      const panel = window.__spotterPanel;
      if (!panel) {
        loading.textContent = 'Spotter could not load — rebuild the extension (`npm run build`).';
        return;
      }
      loading.remove();
      panel.open({ ...context, platform: PLATFORM, ...extra }, FRAME_CLASS);
    };

    const cacheKey = datasetCacheKey(context);

    // Fast resume via the local cache: reopen last time's worksheet with no
    // network. Shift+click (options.rebuild) skips this to refresh the data.
    if (!options.rebuild && context.worksheet) {
      const cached = await cacheGet(cacheKey);
      if (cached && cached.worksheetId && Date.now() - (cached.ts || 0) < CACHE_TTL_MS) {
        setStep('user', 'done', cached.userid);
        setStep('check', 'done', 'cached');
        setStep('data', 'skip', 'reused');
        setStep('load', 'skip', 'reused');
        setStep('worksheet', 'skip', 'reused');
        setStep('open', 'active');
        openPanelFrame({
          worksheetId: cached.worksheetId, worksheetName: cached.worksheetName,
          userid: cached.userid, workspace: cached.userid, cached: true,
        });
        return;
      }
    }

    let userid = context.site || 'tableau_user';
    try {
      setStep('user', 'active');
      userid = await resolveUserId(context);
      setStep('user', 'done', userid);

      let worksheetId = null;
      let worksheetName = null;

      if (context.worksheet) {
        const name = context.sheetTitle || context.worksheet;

        // Verify what already exists before doing any work (the backend "cache").
        setStep('check', 'active');
        const check = await checkDataset({ userid, platform: PLATFORM, name });
        if (check) {
          setStep('user', 'done', check.user && check.user.exists ? 'existing user' : 'new user');
          setStep('check', 'done', check.ready ? 'already built' : 'needs build');
        } else {
          setStep('check', 'done', 'unavailable');
        }

        const reuse = !options.rebuild && check && check.ready && check.worksheet && check.worksheet.exists;
        if (reuse) {
          // User / data model / worksheet all exist — reuse, skip pull + upload.
          setStep('data', 'skip', 'reused');
          setStep('load', 'done', check.table && check.table.exists ? 'exists' : 'reused');
          setStep('worksheet', 'done', 'exists');
          worksheetId = check.worksheet.id;
          worksheetName = check.worksheet.name;
        } else {
          // Build (or refresh on rebuild): read rows -> load -> worksheet.
          setStep('data', 'active');
          const data = await requestWorksheetData(context.worksheet, 'underlying');
          setStep('data', 'done', data.rows.length.toLocaleString() + ' rows');

          setStep('load', 'active');
          setStep('worksheet', 'active');
          const body = await createDataset({
            userid, platform: PLATFORM, name,
            data: { columns: data.columns, rows: data.rows },
          });
          const tableId = body.dataset && body.dataset.tableId;
          worksheetId = (body.embed && body.embed.worksheetId)
            || (body.dataset && (body.dataset.worksheetId || body.dataset.tableId));
          worksheetName = body.dataset && (body.dataset.worksheetName || body.dataset.tableName);
          setStep('load', tableId ? 'done' : 'error', tableId ? '' : 'not loaded');
          setStep('worksheet', worksheetId ? 'done' : 'error', worksheetId ? '' : 'no model');
        }

        // Remember the outcome so the next open of this sheet resumes instantly.
        if (worksheetId) {
          await cacheSet(cacheKey, { worksheetId, worksheetName, userid, ts: Date.now() });
        }
      } else {
        setStep('check', 'skip');
        setStep('data', 'skip');
        setStep('load', 'skip');
        setStep('worksheet', 'skip');
      }

      // workspace is the userid the embed authenticates as — keep it equal to the
      // one /dataset provisioned/shared for, so access lines up.
      setStep('open', 'active');
      openPanelFrame({ worksheetId, worksheetName, userid, workspace: userid });
    } catch (err) {
      // A step failed — open the panel on the configured default model so the
      // user isn't stranded on the checklist; the panel shows the load error.
      openPanelFrame({ userid, workspace: userid, loadError: err.message });
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.origin === EXTENSION_ORIGIN && ev.data && ev.data.type === CLOSE_EVENT) closePanel();
  });

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      findTitleTargets(document).forEach(inject);
      ensureLiveboardButton();
    }, SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
  console.log('[Tableau Spotter] content script loaded in', location.href);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closePanel();
  });
})();
