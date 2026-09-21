(() => {
  // Anchors verified against a live Power BI report (Chrome for Testing 151).
  // Power BI churns class names between releases but keeps data-testid stable,
  // so anchor on the title's testid and walk up for the container.
  const TITLE_SELECTOR = '[data-testid="visual-title"], .visualTitle';
  const TITLE_TEXT_SELECTOR = 'h3, .preTextWithEllipsis';
  const TRANSFORM_SELECTOR = 'transform[data-testid="visual-container"]';
  const VISUAL_CONTAINER_SELECTOR = '.visualContainer';
  const INJECTED_ATTR = 'data-ts-spotter';
  const BUTTON_CLASS = 'ts-spotter-btn';
  const LAYER_CLASS = 'ts-spotter-layer';
  const PANEL_CLASS = 'ts-spotter-panel';
  const OPEN_EVENT = 'spotter:open';
  // /groups/<workspace>/reports/<reportId>/<pageName>, workspace segment optional.
  const REPORT_PATH_PATTERN = /\/(?:groups\/([^/]+)\/)?reports\/([^/]+)(?:\/([^/?#]+))?/;
  const TRANSLATE_PATTERN = /translate\(([^)]+)\)/;
  const SCAN_DEBOUNCE_MS = 100;
  const REQUEST_EVENT = 'spotter:request';
  const RESPONSE_EVENT = 'spotter:response';
  const LAYOUT_EVENT = 'spotter:layout';
  const PREVIEW_ROWS = 100;
  const CREATE_SESSION = 'spotter:create-session';
  const PLATFORM = 'powerbi';
  const FRAME_CLASS = 'ts-spotter-frame';
  const CLOSE_EVENT = 'spotter:close';
  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  // Backend that loads a visual's rows into ThoughtSpot and wraps them in a
  // worksheet. Point at the local Worker (wrangler dev) or the deployed URL.
  const BACKEND_URL = 'http://localhost:8799';
  // Dev only. Do NOT ship a shared key in a real extension.
  const BACKEND_API_KEY = '';
  const CANVAS_SELECTOR = '.displayAreaContainer, .displayArea';
  // Power BI's dialogs live in a cdk overlay host at z-index 10000005, and the
  // report's own visuals top out around 33000. Sit between the two so the
  // buttons clear the chart but never cover a dialog.
  const MODAL_SELECTOR = '.cdk-overlay-backdrop, [aria-modal="true"], [role="dialog"], [role="alertdialog"]';

  // Filled in from page.js, which fetches the report layout in the MAIN world.
  let layoutVisuals = [];
  let layoutError = null;
  let matched = new Map();

  const pending = new Map();
  let requestSeq = 0;

  addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data) return;
    if (ev.data.type === LAYOUT_EVENT) {
      if (ev.data.error) { layoutError = ev.data.error; return; }
      layoutVisuals = ev.data.visuals || [];
      console.log('[Power BI Spotter] layout loaded:', layoutVisuals.length, 'visuals');
      matchLayout();
      return;
    }
    if (ev.data.type === RESPONSE_EVENT) {
      const settle = pending.get(ev.data.requestId);
      if (!settle) return;
      pending.delete(ev.data.requestId);
      if (ev.data.error) settle.reject(new Error(ev.data.error));
      else settle.resolve(ev.data.result);
    }
  });

  function requestData(visualId, kind, maxRows) {
    const requestId = 'pbi-' + (requestSeq += 1);
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      window.postMessage({ type: REQUEST_EVENT, requestId, visualId, kind: kind || 'summary', maxRows },
        location.origin);
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error('timed out waiting for the report backend'));
      }, 30000);
    });
  }

  function domRect(titleEl) {
    const transform = titleEl.closest(TRANSFORM_SELECTOR);
    const style = transform ? transform.getAttribute('style') || '' : '';
    const tr = style.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
    const w = style.match(/width:\s*([\d.]+)px/);
    const h = style.match(/height:\s*([\d.]+)px/);
    if (!tr || !w || !h) return null;
    return { x: +tr[1], y: +tr[2], w: +w[1], h: +h[1] };
  }

  // The DOM lays the canvas out at a scale factor of the layout's coordinates,
  // so titles match directly but geometry needs that factor recovered first.
  function matchLayout() {
    matched = new Map();
    if (!layoutVisuals.length) return;
    const pageName = (location.pathname.match(REPORT_PATH_PATTERN) || [])[3] || null;
    const candidates = layoutVisuals.filter((v) => !pageName || v.section === pageName);
    const targets = findTitleTargets(document).map((el) => ({ el, title: titleOf(el), rect: domRect(el) }));
    const used = new Set();

    targets.forEach((t) => {
      const hit = candidates.find((v) => !used.has(v) && v.title && v.title.trim() === t.title);
      if (hit) { used.add(hit); matched.set(t.el, hit); }
    });

    const ratios = [];
    matched.forEach((v, el) => {
      const r = domRect(el);
      if (r && v.rect && v.rect.w) ratios.push(r.w / v.rect.w);
    });
    if (!ratios.length) return;
    ratios.sort((a, b) => a - b);
    const scale = ratios[Math.floor(ratios.length / 2)];

    // Whatever is left over -- visuals whose title is not a literal in the
    // layout -- is matched on geometry instead.
    targets.filter((t) => !matched.has(t.el) && t.rect).forEach((t) => {
      let best = null;
      let bestDist = Infinity;
      candidates.forEach((v) => {
        if (used.has(v) || !v.rect) return;
        const dist = Math.abs(t.rect.x - v.rect.x * scale) + Math.abs(t.rect.y - v.rect.y * scale)
          + Math.abs(t.rect.w - v.rect.w * scale) + Math.abs(t.rect.h - v.rect.h * scale);
        if (dist < bestDist) { bestDist = dist; best = v; }
      });
      if (best && bestDist < 40) { used.add(best); matched.set(t.el, best); }
    });
  }

  const SPARKLE_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z"/>' +
    '<path d="M13 11l.7 1.8L15.5 13.5l-1.8.7L13 16l-.7-1.8-1.8-.7 1.8-.7z"/>' +
    '</svg>';

  function findTitleTargets(root) {
    return [...root.querySelectorAll(TITLE_SELECTOR)];
  }

  function titleOf(titleEl) {
    const attr = titleEl.getAttribute('title');
    if (attr) return attr.trim();
    const textEl = titleEl.querySelector(TITLE_TEXT_SELECTOR);
    return ((textEl || titleEl).textContent || '').trim();
  }

  function vizContext(titleEl, visualTitle) {
    const pathMatch = location.pathname.match(REPORT_PATH_PATTERN) || [];
    const transform = titleEl.closest(TRANSFORM_SELECTOR);
    const container = titleEl.closest(VISUAL_CONTAINER_SELECTOR);
    const translate = transform && (transform.getAttribute('style') || '').match(TRANSLATE_PATTERN);
    const layout = matched.get(titleEl) || null;
    return {
      workspace: pathMatch[1] ? decodeURIComponent(pathMatch[1]) : null,
      reportId: pathMatch[2] || null,
      pageName: pathMatch[3] ? decodeURIComponent(pathMatch[3]) : null,
      reportTitle: document.title.replace(/\s*[-|]\s*Power BI.*$/i, '').trim() || null,
      visualTitle,
      // From the report layout when available: the DOM exposes no visual guid.
      visualId: layout ? layout.visualId : null,
      visualType: layout ? layout.visualType
        : (container ? container.getAttribute('aria-roledescription') : null),
      roles: layout ? layout.roles : null,
      filterCount: layout ? layout.filterCount : null,
      layoutError,
      tabOrder: container ? container.getAttribute('tab-order') : null,
      position: translate ? translate[1] : null,
      url: location.href,
    };
  }

  function buildButton(titleEl, visualTitle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.title = 'Ask Spotter about this visual (Alt+click for visual details)';
    btn.setAttribute('aria-label', 'Open Spotter');
    btn.innerHTML = SPARKLE_SVG + '<span>Spotter</span>';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const context = vizContext(titleEl, visualTitle());
      if (ev.altKey) openPanel(context);
      else openSpotter(context);
    });
    // The title is a sub-selectable, direct-edit region in Power BI; swallow the
    // events it uses to enter selection/edit mode.
    ['mousedown', 'pointerdown', 'dblclick'].forEach((type) =>
      btn.addEventListener(type, (ev) => ev.stopPropagation())
    );
    return btn;
  }

  // Power BI gives each visual its own stacking context (the <transform> host
  // carries a CSS transform), and visuals overlap. A button placed inside the
  // title can therefore never be raised above a neighbouring visual. Render the
  // buttons in one fixed layer on <body> instead and track the titles' rects.
  const placed = new Map();

  function ensureLayer() {
    let layer = document.querySelector('.' + LAYER_CLASS);
    if (!layer) {
      layer = document.createElement('div');
      layer.className = LAYER_CLASS;
      document.body.appendChild(layer);
    }
    return layer;
  }

  function modalOpen() {
    return [...document.querySelectorAll(MODAL_SELECTOR)].some((el) => {
      // Our own panel is a dialog too; it must not hide the buttons.
      if (el.closest('.' + PANEL_CLASS)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  // Clip the layer to the report canvas so a button can never paint over the
  // chrome around it, and hide the lot while a dialog is up.
  function frameLayer(layer) {
    const canvas = document.querySelector(CANVAS_SELECTOR);
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    layer.style.left = r.left + 'px';
    layer.style.top = r.top + 'px';
    layer.style.width = r.width + 'px';
    layer.style.height = r.height + 'px';
    layer.style.display = modalOpen() ? 'none' : 'block';
    return r;
  }

  function position(btn, titleEl, frame) {
    const r = titleEl.getBoundingClientRect();
    const onCanvas = frame
      && r.width > 0 && r.height > 0
      && r.bottom > frame.top && r.top < frame.bottom
      && r.right > frame.left && r.left < frame.right;
    btn.style.display = onCanvas ? 'inline-flex' : 'none';
    if (!onCanvas) return;
    const w = btn.offsetWidth || 52;
    const h = btn.offsetHeight || 16;
    btn.style.left = Math.round(r.right - w - frame.left) + 'px';
    btn.style.top = Math.round(r.top + (r.height - h) / 2 - frame.top) + 'px';
  }

  function sync() {
    const layer = ensureLayer();
    const frame = frameLayer(layer);
    const seen = new Set();
    findTitleTargets(document).forEach((titleEl) => {
      seen.add(titleEl);
      let btn = placed.get(titleEl);
      if (!btn) {
        btn = buildButton(titleEl, () => titleOf(titleEl));
        titleEl.setAttribute(INJECTED_ATTR, '1');
        layer.appendChild(btn);
        placed.set(titleEl, btn);
      }
      position(btn, titleEl, frame);
    });
    placed.forEach((btn, titleEl) => {
      if (seen.has(titleEl) && titleEl.isConnected) return;
      btn.remove();
      placed.delete(titleEl);
    });
  }

  function reposition() {
    const frame = frameLayer(ensureLayer());
    placed.forEach((btn, titleEl) => {
      if (titleEl.isConnected) position(btn, titleEl, frame);
    });
  }

  const PANEL_ROWS = [
    ['Report', (c) => c.reportTitle],
    ['Report id', (c) => c.reportId],
    ['Page', (c) => c.pageName],
    ['Visual title', (c) => c.visualTitle],
    ['Visual id', (c) => c.visualId || (c.layoutError ? 'layout error: ' + c.layoutError : null)],
    ['Visual type', (c) => c.visualType],
    ['Filters', (c) => c.filterCount],
    ['Tab order', (c) => c.tabOrder],
    ['Position', (c) => c.position],
    ['Workspace', (c) => c.workspace],
  ];

  function buildRows(context) {
    const dl = document.createElement('dl');
    dl.className = 'ts-spotter-rows';
    PANEL_ROWS.forEach(([label, pick]) => {
      const value = pick(context);
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value == null || value === '' ? '—' : String(value);
      dl.append(dt, dd);
    });
    if (context.roles) {
      Object.entries(context.roles).forEach(([role, refs]) => {
        if (!refs.length) return;
        const dt = document.createElement('dt');
        dt.textContent = role;
        const dd = document.createElement('dd');
        dd.textContent = refs.join(', ');
        dl.append(dt, dd);
      });
    }
    return dl;
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

    const body = document.createElement('div');
    body.className = 'ts-spotter-body';
    body.textContent = context.visualId ? 'Loading data\u2026' : 'No visual id \u2014 cannot query this visual.';

    let lastResult = null;
    panel.append(
      header,
      buildRows(context),
      body,
      worksheetBuilderSection(context, () => lastResult),
      buildSendButton(context, () => lastResult)
    );
    if (context.visualId) loadData(body, context.visualId, (r) => { lastResult = r; });
    document.body.appendChild(panel);

    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: context }));
  }

  function renderTable(body, result) {
    body.textContent = '';
    if (!result.columns.length || !result.rows.length) {
      body.textContent = 'The query returned no rows.';
      return;
    }
    const caption = document.createElement('div');
    caption.className = 'ts-spotter-caption';
    caption.textContent = result.rowCount + (result.truncated ? '+ rows (capped)' : ' rows')
      + ' \u00b7 ' + result.columns.length + ' columns';
    const wrap = document.createElement('div');
    wrap.className = 'ts-spotter-tablewrap';
    const table = document.createElement('table');
    table.className = 'ts-spotter-table';

    const thead = document.createElement('thead');
    const hrow = document.createElement('tr');
    result.columns.forEach((c) => {
      const th = document.createElement('th');
      th.textContent = c.name;
      if (c.kind === 'measure') th.className = 'num';
      hrow.appendChild(th);
    });
    thead.appendChild(hrow);

    const tbody = document.createElement('tbody');
    result.rows.slice(0, PREVIEW_ROWS).forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((cell, i) => {
        const td = document.createElement('td');
        td.textContent = cell == null || cell === '' ? '\u2014' : String(cell);
        if (result.columns[i] && result.columns[i].kind === 'measure') td.className = 'num';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    wrap.appendChild(table);
    body.append(caption, wrap);
    if (result.rows.length > PREVIEW_ROWS) {
      const more = document.createElement('div');
      more.className = 'ts-spotter-caption';
      more.textContent = 'showing first ' + PREVIEW_ROWS;
      body.appendChild(more);
    }
  }

  // The backend takes a flat context, so roles collapse into one key each.
  function sessionPayload(context, result) {
    const flat = {
      reportId: context.reportId,
      reportTitle: context.reportTitle,
      pageName: context.pageName,
      workspace: context.workspace,
      visualId: context.visualId,
      visualTitle: context.visualTitle,
      visualType: context.visualType,
      tabOrder: context.tabOrder,
      position: context.position,
      filterCount: context.filterCount,
      url: context.url,
    };
    Object.entries(context.roles || {}).forEach(([role, refs]) => {
      if (refs && refs.length) flat['role_' + role] = refs.join(', ');
    });
    Object.keys(flat).forEach((k) => { if (flat[k] == null) delete flat[k]; });
    return {
      platform: 'powerbi',
      context: flat,
      data: result ? {
        columns: result.columns.map((c) => ({
          name: c.name,
          type: c.kind === 'measure' ? 'number' : 'string',
        })),
        rows: result.rows,
        totalRows: result.rowCount,
      } : undefined,
    };
  }

  // Power BI has no workbook file to upload, so the equivalent of Tableau's
  // worksheet builder is the visual's own rows: POST them to /dataset, which
  // loads them into ThoughtSpot and wraps them in a worksheet Spotter can
  // answer from.
  async function createDataset(context, result) {
    const res = await fetch(BACKEND_URL + '/dataset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BACKEND_API_KEY ? { Authorization: 'Bearer ' + BACKEND_API_KEY } : {}),
      },
      body: JSON.stringify({
        userid: context.workspace || 'user',
        platform: PLATFORM,
        name: [context.reportTitle, context.visualTitle].filter(Boolean).join(' - ') || 'Power BI visual',
        data: {
          columns: result.columns.map((c) => ({ name: c.name })),
          // Raw values, not the formatted strings the table shows, or every
          // measure loads as text.
          rows: result.rawRows || result.rows,
        },
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body && (body.detail || body.error);
      throw new Error('Worksheet build failed: ' + (detail || 'HTTP ' + res.status));
    }
    return body;
  }

  function worksheetBuilderSection(context, getResult) {
    const wrap = document.createElement('div');
    wrap.className = 'ts-spotter-actions';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ts-spotter-more';
    go.textContent = 'Create Spotter worksheet';
    const note = document.createElement('span');
    note.className = 'ts-spotter-note';
    go.addEventListener('click', async () => {
      const result = getResult();
      if (!result || !result.columns.length) { note.textContent = 'No data loaded yet.'; return; }
      go.disabled = true;
      note.textContent = 'Loading ' + result.rowCount + ' rows into ThoughtSpot\u2026';
      try {
        const built = await createDataset(context, result);
        const worksheetId = (built.embed && built.embed.worksheetId)
          || (built.dataset && built.dataset.worksheetId);
        note.textContent = worksheetId ? 'Worksheet ready' : 'Built, but no worksheet id returned';
        if (worksheetId) openSpotter({ ...context, worksheetId });
      } catch (err) {
        note.textContent = err.message;
      } finally {
        go.disabled = false;
      }
    });
    wrap.append(go, note);
    return wrap;
  }

  function buildSendButton(context, getResult) {
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'ts-spotter-more';
    send.textContent = 'Send to Spotter backend';
    const note = document.createElement('span');
    note.className = 'ts-spotter-note';
    send.addEventListener('click', () => {
      send.disabled = true;
      send.textContent = 'Sending\u2026';
      note.textContent = '';
      const post = (result) => chrome.runtime.sendMessage(
        { type: CREATE_SESSION, payload: sessionPayload(context, result) },
        (res) => {
          send.disabled = false;
          send.textContent = 'Send to Spotter backend';
          if (chrome.runtime.lastError) { note.textContent = chrome.runtime.lastError.message; return; }
          if (!res) { note.textContent = 'No response from the extension worker.'; return; }
          note.textContent = res.error ? res.error : 'Session ' + res.session.id
            + ' (' + (result && result.rowCount != null ? result.rowCount : 0) + ' rows)';
        }
      );
      // The panel preview is capped; pull the full set before handing it on.
      const preview = getResult();
      if (!preview || !preview.truncated) { post(preview); return; }
      note.textContent = 'Fetching all rows\u2026';
      requestData(context.visualId, 'summary', 20000).then(post, (err) => {
        send.disabled = false;
        send.textContent = 'Send to Spotter backend';
        note.textContent = 'Could not fetch all rows: ' + err.message;
      });
    });
    const wrap = document.createElement('div');
    wrap.className = 'ts-spotter-actions';
    wrap.append(send, note);
    return wrap;
  }

  function loadData(body, visualId, keep) {
    requestData(visualId).then(
      (result) => { if (keep) keep(result); if (body.isConnected) renderTable(body, result); },
      (err) => { if (body.isConnected) body.textContent = 'Could not load data: ' + err.message; }
    );
  }

  function closePanel() {
    document.querySelectorAll('.' + PANEL_CLASS).forEach((el) => el.remove());
    document.querySelectorAll('.' + FRAME_CLASS).forEach((el) => el.remove());
  }

  function openSpotter(context) {
    closePanel();
    const frame = document.createElement('iframe');
    frame.className = FRAME_CLASS;
    frame.title = 'Spotter';
    frame.src = chrome.runtime.getURL('panel.html') + '#' + encodeURIComponent(JSON.stringify({ ...context, platform: PLATFORM }));
    document.body.appendChild(frame);
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: context }));
  }

  addEventListener('message', (ev) => {
    if (ev.origin === EXTENSION_ORIGIN && ev.data && ev.data.type === CLOSE_EVENT) closePanel();
  });

  // Selectors are the part most likely to drift on a Power BI release, so
  // report what was actually on the page when nothing matched.
  function probe() {
    console.log('[Power BI Spotter] titles:', document.querySelectorAll(TITLE_SELECTOR).length,
      '| transforms:', document.querySelectorAll(TRANSFORM_SELECTOR).length,
      '| buttons:', document.querySelectorAll('.' + BUTTON_CLASS).length);
    const first = document.querySelector(TITLE_SELECTOR);
    if (first) console.log('  first title markup:', first.outerHTML.slice(0, 400));
  }
  window.__spotterProbe = probe;

  let scanTimer = null;
  let everInjected = false;
  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const before = placed.size;
      sync();
      if (placed.size !== before) matchLayout();
      if (placed.size) everInjected = true;
    }, SCAN_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(() => { reposition(); scheduleScan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();
  console.log('[Power BI Spotter] content script loaded in', location.href);
  // Reports render well after document_idle; probe once the page has settled.
  setTimeout(() => {
    if (!everInjected) {
      console.warn('[Power BI Spotter] no visual titles matched — running probe');
      probe();
    }
  }, 8000);

  // The layer is detached from the report, so it has to follow the titles.
  let rafPending = false;
  const onViewportChange = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; reposition(); });
  };
  addEventListener('scroll', onViewportChange, true);
  addEventListener('resize', onViewportChange);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closePanel();
  });
})();
