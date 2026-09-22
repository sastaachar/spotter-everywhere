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
  const MAX_LOAD_ROWS = 20000;
  const CREATE_SESSION = 'spotter:create-session';
  const CREATE_DATASET = 'spotter:create-dataset';
  const CREATE_LIVEBOARD = 'spotter:create-liveboard';
  const LIVEBOARD_STREAM = 'spotter:liveboard-stream';
  const GET_LIVEBOARD = 'spotter:get-liveboard';
  const PLATFORM = 'powerbi';
  const FRAME_CLASS = 'ts-spotter-frame';
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

  function requestModel() {
    const requestId = 'pbi-model-' + (requestSeq += 1);
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      window.postMessage({ type: REQUEST_EVENT, requestId, kind: 'tmdl' }, location.origin);
      setTimeout(() => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error('timed out exporting the Power BI model'));
      }, 120000);
    });
  }

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

  // Embedded reports title the document "Microsoft Power BI" rather than the
  // report, which would name every worksheet after the product.
  const GENERIC_TITLE = /^(microsoft\s+)?power\s*bi$/i;
  function reportTitleFromDocument() {
    const title = document.title.replace(/\s*[-|]\s*Power BI.*$/i, '').trim();
    if (!title || GENERIC_TITLE.test(title)) return null;
    return title;
  }

  // Rendered geometry, in viewport pixels. Power BI's <transform> node is a
  // zero-sized positioning shell on some pages, so its inline style cannot be
  // trusted; the rendered container's own box always can.
  function screenRect(node) {
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  }

  /**
   * Which report, and which of its pages, this frame is showing.
   *
   * The Power BI app puts both in the path — /groups/<ws>/reports/<id>/<page> —
   * and updates it on every page switch, including the in-canvas buttons a
   * report builds its own tab strip from, so it follows the user. An embedded
   * report is served from /reportEmbed and carries the same three in the query
   * instead; without reading those, a report embedded in someone else's page
   * has no id, and the Liveboard button never appears on it.
   */
  function reportIdentity() {
    const path = location.pathname.match(REPORT_PATH_PATTERN);
    if (path) {
      return {
        workspace: path[1] ? decodeURIComponent(path[1]) : null,
        reportId: path[2] || null,
        pageName: path[3] ? decodeURIComponent(path[3]) : null,
      };
    }
    const q = new URLSearchParams(location.search);
    return {
      workspace: q.get('groupId'),
      reportId: q.get('reportId'),
      pageName: q.get('pageName'),
    };
  }

  function currentPageName() {
    return reportIdentity().pageName;
  }

  /** The open page's own display name, e.g. "Pipeline Trends". */
  function currentPageTitle() {
    const name = currentPageName();
    const hit = name && layoutVisuals.find((v) => v.section === name && v.sectionTitle);
    return hit ? hit.sectionTitle : null;
  }

  // Every visual on the canvas, titled or not. The Spotter button hangs off a
  // title, but a liveboard mirrors the whole page — and a Power BI title is
  // optional, so walking titles silently dropped this report's detail tables and
  // its Key influencers visual.
  function canvasVisuals() {
    return [...document.querySelectorAll(TRANSFORM_SELECTOR)]
      .map((el) => {
        const titleEl = el.querySelector(TITLE_SELECTOR);
        const container = el.querySelector(VISUAL_CONTAINER_SELECTOR);
        return {
          el,
          titleEl,
          container,
          title: titleEl ? titleOf(titleEl) : '',
          rect: screenRect(container) || screenRect(el),
        };
      })
      .filter((v) => v.rect);
  }

  /** The layout entry for any node inside a visual. */
  function layoutFor(node) {
    const transform = node && (node.matches(TRANSFORM_SELECTOR) ? node : node.closest(TRANSFORM_SELECTOR));
    return transform ? matched.get(transform) || null : null;
  }

  // Where the report page is drawn inside the canvas element. A page has a
  // design size (1280x720 say) and Power BI fits it into whatever room it has,
  // either to the width or to the whole box, letterboxing the remainder. Both
  // fits are offered because the report's display option is not worth trusting:
  // matchLayout keeps whichever one actually lines the visuals up.
  function pageFits(section) {
    const canvas = document.querySelector(CANVAS_SELECTOR);
    const box = canvas && canvas.getBoundingClientRect();
    if (!box || !box.width || !section.w || !section.h) return [];
    const place = (scale) => ({
      scale,
      x: box.left + Math.max(0, (box.width - section.w * scale) / 2),
      y: box.top + Math.max(0, (box.height - section.h * scale) / 2),
    });
    return [
      place(Math.min(box.width / section.w, box.height / section.h)),
      place(box.width / section.w),
    ];
  }

  function matchLayout() {
    matched = new Map();
    if (!layoutVisuals.length) return;
    const pageName = currentPageName();
    const candidates = layoutVisuals.filter((v) => !pageName || v.section === pageName);
    if (!candidates.length) return;
    const targets = canvasVisuals();
    const used = new Set();

    // A title that is a literal in the layout is an exact identification, so it
    // wins outright; geometry only settles what is left.
    targets.forEach((t) => {
      const hit = t.title && candidates.find((v) => !used.has(v) && v.title && v.title.trim() === t.title);
      if (hit) { used.add(hit); matched.set(t.el, hit); }
    });

    const section = { w: candidates[0].sectionWidth, h: candidates[0].sectionHeight };
    const remaining = targets.filter((t) => !matched.has(t.el));
    if (!remaining.length) return;

    // Score each fit by how well it places the visuals we have not identified,
    // then keep the better one. A page carries hidden visuals from its bookmark
    // states — far more than are on screen — so a tolerant threshold would hand
    // a tile the wrong source; the bar is a fraction of the visual's own size.
    let best = { pairs: [], score: Infinity };
    pageFits(section).forEach((fit) => {
      const taken = new Set(used);
      const pairs = [];
      let score = 0;
      remaining.forEach((t) => {
        let pick = null;
        let pickDist = Infinity;
        candidates.forEach((v) => {
          if (taken.has(v) || !v.rect) return;
          const dist = Math.abs(t.rect.x - (fit.x + v.rect.x * fit.scale))
            + Math.abs(t.rect.y - (fit.y + v.rect.y * fit.scale))
            + Math.abs(t.rect.w - v.rect.w * fit.scale)
            + Math.abs(t.rect.h - v.rect.h * fit.scale);
          if (dist < pickDist) { pickDist = dist; pick = v; }
        });
        if (pick && pickDist < 0.25 * (t.rect.w + t.rect.h)) {
          taken.add(pick);
          pairs.push([t.el, pick]);
          score += pickDist;
        }
      });
      // More visuals placed beats a tighter fit on fewer of them.
      const miss = remaining.length - pairs.length;
      const total = miss * 1e6 + score;
      if (total < best.score) best = { pairs, score: total };
    });
    best.pairs.forEach(([el, v]) => matched.set(el, v));
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
    const identity = reportIdentity();
    const transform = titleEl.closest(TRANSFORM_SELECTOR);
    const container = titleEl.closest(VISUAL_CONTAINER_SELECTOR);
    const translate = transform && (transform.getAttribute('style') || '').match(TRANSLATE_PATTERN);
    const layout = layoutFor(titleEl);
    return {
      workspace: identity.workspace,
      reportId: identity.reportId,
      pageName: identity.pageName,
      reportTitle: reportTitleFromDocument(),
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

  // Progress checklist shown while the liveboard builds — same shape as the
  // Tableau one: each row spins while active and turns into a green check when
  // it completes, so a 60-second build shows what it is doing.
  const SPOTTER_STEPS = [
    { key: 'read', label: 'Reading this visual' },
    { key: 'load', label: 'Loading it into ThoughtSpot' },
    { key: 'open', label: 'Opening Spotter' },
  ];

  const LIVEBOARD_STEPS = [
    { key: 'check', label: 'Checking ThoughtSpot' },
    { key: 'read', label: 'Reading the report' },
    { key: 'build', label: 'Building the liveboard' },
    { key: 'open', label: 'Opening the liveboard' },
  ];

  function buildChecklist(container, title, defs) {
    container.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'ts-spotter-steps';
    const heading = document.createElement('div');
    heading.className = 'ts-spotter-steps-title';
    heading.textContent = title;
    wrap.appendChild(heading);
    const rows = {};
    (defs || LIVEBOARD_STEPS).forEach((step) => {
      const row = document.createElement('div');
      row.className = 'ts-spotter-step';
      row.dataset.state = 'pending';
      const icon = document.createElement('span');
      icon.className = 'ts-spotter-step-icon';
      const label = document.createElement('span');
      label.className = 'ts-spotter-step-label';
      label.textContent = step.label;
      const detail = document.createElement('span');
      detail.className = 'ts-spotter-step-detail';
      row.append(icon, label, detail);
      wrap.appendChild(row);
      rows[step.key] = { row, detail };
    });
    container.appendChild(wrap);
    // state: pending | active | done | error
    return (key, state, detailText) => {
      const r = rows[key];
      if (!r) return;
      r.row.dataset.state = state;
      if (detailText != null) r.detail.textContent = detailText;
    };
  }

  // A liveboard covers the whole report, so its trigger belongs to the report
  // rather than to any one visual — a single docked button, not one per title.
  const REPORT_BUTTON_CLASS = 'ts-spotter-liveboard-btn';

  function ensureLiveboardButton() {
    if (document.querySelector('.' + REPORT_BUTTON_CLASS)) return;
    const context = reportContext();
    if (!context.reportId) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = REPORT_BUTTON_CLASS;
    btn.title = 'Build a ThoughtSpot Liveboard from every visual on this page';
    const label = document.createElement('span');
    label.textContent = 'Liveboard';
    btn.innerHTML = SPARKLE_SVG;
    btn.appendChild(label);

    btn.addEventListener('click', () => runLiveboard(btn));
    document.body.appendChild(btn);
  }

  /** Build the open page's liveboard and show it, with the checklist running. */
  async function runLiveboard(btn) {
    if (btn.disabled) return;
    btn.disabled = true;

    closePanel();
    const overlay = document.createElement('aside');
    overlay.className = FRAME_CLASS + ' ts-spotter-loading';
    document.body.appendChild(overlay);
    const setStep = buildChecklist(overlay, 'Building your Liveboard', LIVEBOARD_STEPS);

    try {
      const liveboardId = await buildLiveboard(reportContext(), setStep);
      setStep('open', 'active');
      overlay.remove();
      btn.disabled = false;
      openSpotter({ ...reportContext(), liveboardId });
    } catch (err) {
      setStep('build', 'error', err.message.slice(0, 80));
      // Leave the failure on screen long enough to read, then clear it.
      setTimeout(() => { overlay.remove(); btn.disabled = false; }, 8000);
    }
  }

  /** Report-level context: the page, not any single visual. */
  function reportContext() {
    const identity = reportIdentity();
    return {
      workspace: identity.workspace,
      reportId: identity.reportId,
      pageName: identity.pageName,
      pageTitle: currentPageTitle(),
      reportTitle: reportTitleFromDocument(),
    };
  }

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
    // Keep the button inside the visual, not on its edge. A title band often
    // starts flush with the tile's own border, so centring in it puts the button
    // half on the border; measure against the visual and inset from that.
    const EDGE = 8;
    const box = screenRect(titleEl.closest(VISUAL_CONTAINER_SELECTOR)) || r;
    const right = Math.min(r.right, box.x + box.w);
    const top = Math.max(r.top + (r.height - h) / 2, box.y + EDGE);
    btn.style.left = Math.round(right - w - EDGE - frame.left) + 'px';
    btn.style.top = Math.round(top - frame.top) + 'px';
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
    ['Page', (c) => c.pageTitle || c.pageName],
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
      liveboardSection(context),
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
  // Power BI emits INF/-INF/NaN for divide-by-zero measures (a Forecast % with
  // no denominator). ThoughtSpot rejects those as invalid DOUBLEs and drops the
  // WHOLE row, silently losing that row's other measures — that is a real
  // under-count, not a rounding difference. Send them as empty instead so the
  // row still loads and only the undefined cell is blank.
  const NON_FINITE = /^-?(INF|INFINITY|NAN)$/i;
  function loadableValue(value) {
    if (value == null) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    if (typeof value === 'string' && NON_FINITE.test(value.trim())) return '';
    return value;
  }

  // The embed authenticates as this user and /dataset shares the worksheet with
  // it, so both sides must derive it identically — an embedded report has no
  // workspace in its URL, and two different fallbacks meant the worksheet was
  // shared with one identity and read by another.
  function datasetUserId(context) {
    return context.workspace || 'powerbi_user';
  }

  /**
   * Run a build over a Port instead of a single sendMessage, resolving with the
   * final result and calling onEvent for each stage the backend streams.
   *
   * A whole-report liveboard takes minutes, and a plain sendMessage cannot
   * survive that: the MV3 service worker is torn down mid-request and the reply
   * never arrives ("the message channel closed before a response was
   * received"). Traffic on a Port keeps the worker alive, and the stages give
   * the checklist something real to show meanwhile. Same shape as the Tableau
   * side, which has always streamed.
   */
  function streamBuildPort(portName, payload, onEvent) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: portName });
      } catch (e) {
        return reject(new Error('Extension worker unavailable — reload this page.'));
      }
      let result = null;
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        try { port.disconnect(); } catch (e) { /* already gone */ }
        fn(arg);
      };
      port.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.error) return finish(reject, new Error(msg.error));
        if (msg.stage === 'result') { result = msg; return; }
        if (msg.done) {
          if (result && (result.error || (typeof result.status === 'number' && result.status >= 400))) {
            return finish(reject, new Error(result.detail || result.error || ('HTTP ' + result.status)));
          }
          return finish(resolve, result);
        }
        try { onEvent(msg); } catch (e) { /* a reporting slip must not fail the build */ }
      });
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        if (settled) return;
        if (result) return finish(resolve, result);
        finish(reject, new Error((err && err.message) || 'stream disconnected'));
      });
      try { port.postMessage({ payload }); } catch (e) { finish(reject, new Error('could not start the stream')); }
    });
  }

  function ask(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('No response from the extension worker.'));
        if (res.error) return reject(new Error(res.error));
        resolve(res);
      });
    });
  }

  // Report furniture: navigation buttons, decorative shapes and images, and
  // slicers (a filter control, not a chart). None of these carries anything a
  // liveboard can show, so they never become a tile. Text boxes are NOT here —
  // their words are content, and they cross over as note tiles.
  const CHROME_VISUALS = new Set([
    'actionButton', 'basicShape', 'shape', 'image', 'slicer', 'advancedSlicerVisual',
  ]);



  // A note tile is a paragraph, not a caption. Below this a text box is a
  // heading ("REGIONAL SALES"), a control's label ("WHAT IF the forecast was
  // adjusted by 0%?") or an instruction about the report's own interactions —
  // none of which mean anything once the data is in a liveboard. A narrative
  // worth carrying runs well past this.
  const TEXT_TILE_MIN_CHARS = 120;

  /**
   * Power BI's "Blank" placeholder, taken off a result.
   *
   * Power BI names a placeholder field `<table>.Blank`, and it turns up two ways
   * that have to be told apart. As a category it means "this visual has no
   * breakdown" — every card carries one, holding nothing but nulls — so the
   * column goes and the visual stays, becoming the single figure it always was.
   * Aggregated into a measure, as `Sum(Forecast Adjustment.Blank)`, it is a
   * what-if parameter's own readout, with no report data behind it at all, and
   * the visual goes with it.
   *
   * Returns the result without its placeholder columns, or null to drop it.
   */
  function stripPlaceholders(columns, rows) {
    const isBlank = (name) => /\.Blank\b/i.test(name || '');
    if (columns.some((c) => isBlank(c.name) && c.name.includes('('))) return null;
    const empty = (v) => v === null || v === undefined || v === '';
    const keep = columns.map((c, i) => !(isBlank(c.name) && rows.every((row) => empty(row[i]))));
    if (!keep.some(Boolean)) return null;
    return {
      columns: columns.filter((_, i) => keep[i]),
      rows: rows.map((row) => row.filter((_, i) => keep[i])),
    };
  }

  /** Visual types that show one headline figure. */
  const SINGLE_VALUE_VISUALS = new Set(['card', 'kpi', 'multiRowCard', 'gauge']);

  /**
   * A card's number, without the cents.
   *
   * Power BI's format string asks money for two decimals, but its card visual
   * never shows them — it abbreviates to $11.43M — because display units are a
   * separate setting we cannot read. Rendered in full, "US$27,812,381.00" is
   * wider than a quarter-width tile and truncates mid-number. Cents on a figure
   * that size say nothing, so they go.
   *
   * Only money loses them. A percentage's one decimal is the difference between
   * 54.2% and 54%, and it costs no width worth having.
   */
  const MONEY = /[$£€¥₹₩₽₺]/;
  function headlineFormat(format) {
    if (!format || !MONEY.test(format)) return format;
    return format.replace(/\.[0#]+/g, '');
  }

  /** Visual types that are a grid of rows rather than a drawn chart. */
  const GRID_VISUALS = new Set(['tableEx', 'pivotTable', 'matrix']);

  /** A name for a visual Power BI left untitled, from the data it is showing. */
  function nameFromColumns(columns, visualType, fallback) {
    const names = (columns || []).map((c) => c.name).filter(Boolean);
    if (!names.length) return fallback;
    if (names.length === 1) return names[0];
    // A wide grid is a listing: calling an eleven-column detail table "Discount
    // by Account Name" describes two of its columns and hides the other nine.
    if (names.length > 3 && (!visualType || GRID_VISUALS.has(visualType))) return names[0] + ' details';
    // Everything else is drawn against an axis, and Power BI names those
    // "<measure> by <category>" — the last column is the measure, the first the
    // category — so a chart reads the way its source did.
    return names[names.length - 1] + ' by ' + names[0];
  }

  /** The report's pages, in the order the report lays them out. */
  function reportPages() {
    const pages = [];
    layoutVisuals.forEach((v) => {
      let page = pages.find((p) => p.section === v.section);
      if (!page) {
        page = { section: v.section, title: (v.sectionTitle || v.section), visuals: [] };
        pages.push(page);
      }
      page.visuals.push(v);
    });
    return pages;
  }

  /** What each visual on the open page is currently showing, by visual id. */
  function renderedText() {
    const byId = new Map();
    canvasVisuals().forEach((cv) => {
      const layout = matched.get(cv.el);
      if (layout && layout.visualId && cv.container) {
        byId.set(layout.visualId, (cv.container.innerText || '').trim());
      }
    });
    return byId;
  }

  /**
   * Every visual in the report, page by page, with the rows it is showing.
   *
   * Power BI renders one page at a time, so only the open page has issued its
   * queries — the rest are read by replaying the query each visual definition
   * carries. A visual that answers no query but holds words becomes a note tile
   * instead of being dropped.
   */
  async function reportDatasets(note, onlySection) {
    const pages = reportPages().filter((p) => !onlySection || p.section === onlySection);
    if (!pages.length) throw new Error('the report layout has not loaded yet');
    const rendered = renderedText();
    const wanted = [];
    pages.forEach((page) => {
      const seen = new Set();
      page.visuals.forEach((v) => {
        if (!v.visualId || seen.has(v.visualId)) return;
        if (CHROME_VISUALS.has(v.visualType)) return;
        seen.add(v.visualId);
        // A visual that is on screen shows its own text — which is the only way
        // to read a narrative, whose words are generated rather than authored.
        const shown = rendered.get(v.visualId) || '';
        const authored = (v.text || '').trim();
        wanted.push({
          page: page.title,
          visualId: v.visualId,
          title: (v.title || '').trim(),
          visualType: v.visualType,
          roles: v.roles ? Object.keys(v.roles) : null,
          hasQuery: Boolean(v.prototypeQuery),
          text: shown.length > authored.length ? shown : authored,
        });
      });
    });
    if (!wanted.length) throw new Error('this page has no visuals to build from');

    const datasets = [];
    const skipped = [];
    // Titles are not unique. A page can hold several untitled visuals that
    // describe themselves the same way, and two tiles with one name is confusing
    // to read even once they no longer collide underneath.
    const usedTitles = new Map();
    const distinct = (title) => {
      const seenBefore = usedTitles.get(title) || 0;
      usedTitles.set(title, seenBefore + 1);
      return seenBefore ? title + ' (' + (seenBefore + 1) + ')' : title;
    };
    for (let i = 0; i < wanted.length; i += 1) {
      const v = wanted[i];
      const label = v.title || v.visualType || 'visual ' + (i + 1);
      note((i + 1) + ' of ' + wanted.length + ' · ' + v.page + ' · ' + label);

      const asNote = () => {
        if (v.text.length < TEXT_TILE_MIN_CHARS) return false;
        datasets.push({ page: v.page, title: distinct(v.title || 'Note'), text: v.text });
        return true;
      };

      // No query at all: it is a text box or a caption, so take the words.
      if (!v.hasQuery) {
        if (!asNote()) skipped.push(label);
        continue;
      }

      let result;
      try {
        result = await requestData(v.visualId, 'summary', MAX_LOAD_ROWS);
      } catch (err) {
        console.warn('[Power BI Spotter] no data for "' + label + '":', err.message);
        if (!asNote()) skipped.push(label);
        continue;
      }
      const rows = result.rawRows || result.rows || [];
      if (!result.columns || !result.columns.length || !rows.length) {
        if (!asNote()) skipped.push(label);
        continue;
      }
      // A card carries a placeholder category and a what-if readout is nothing
      // but a placeholder — see stripPlaceholders.
      const clean = stripPlaceholders(result.columns, rows);
      if (!clean) { skipped.push(label); continue; }
      datasets.push({
        page: v.page,
        title: distinct(v.title || nameFromColumns(clean.columns, v.visualType, label)),
        // Lets the liveboard draw each tile the way the source visual is drawn.
        visualType: v.visualType || undefined,
        // Visuals that share a type can still draw differently — a scatter with
        // a Size role is a bubble chart — so the roles travel with the type.
        roles: v.roles || undefined,
        // Power BI's format string travels with the column so the tile shows
        // dollars as dollars and a ratio as a percentage, not a bare number.
        columns: clean.columns.map((c) => ({
          name: c.name,
          format: (SINGLE_VALUE_VISUALS.has(v.visualType) ? headlineFormat(c.format) : c.format) || undefined,
        })),
        rows: clean.rows.map((row) => row.map(loadableValue)),
      });
    }
    if (!datasets.length) throw new Error('nothing on this page returned any data');
    // Surfaced by the caller, so a report that could not be mirrored in full
    // says which visuals are missing instead of quietly building a shorter board.
    datasets.skipped = skipped;
    return datasets;
  }

  async function buildLiveboard(context, setStep) {
    if (!context.reportId) throw new Error('no report id for this view');
    // One liveboard per page, built when that page is asked for. Building the
    // whole report in one go meant dozens of uploads and a wait of minutes
    // before anything was visible; a page is seconds and is what the user is
    // looking at. Each page keeps its own board, so the wait is never repeated.
    const section = context.pageName || '';
    const guid = section ? context.reportId + ':' + section : context.reportId;

    setStep('check', 'active');
    const found = await ask(GET_LIVEBOARD, { platform: PLATFORM, guid });
    if (found.body && found.body.exists && found.body.liveboardId) {
      setStep('check', 'done', 'already built');
      setStep('read', 'done', 'reused');
      setStep('build', 'done', 'reused');
      return found.body.liveboardId;
    }
    setStep('check', 'done', 'not built yet');

    // The liveboard mirrors this page — every visual on it, drawn as it is drawn
    // there — from real rows. The semantic model alone would describe the
    // columns but carry no data, and every tile would read "No data found".
    setStep('read', 'active');
    const datasets = await reportDatasets((detail) => setStep('read', 'active', detail), section);
    const missed = datasets.skipped || [];
    setStep('read', 'done', datasets.length + ' visuals'
      + (missed.length ? ' (' + missed.length + ' with nothing to show)' : ''));
    if (missed.length) console.warn('[Power BI Spotter] not on the liveboard:', missed.join(', '));

    setStep('build', 'active', 'loading ' + datasets.length + ' datasets');
    // No `name`: the route keys on it when present, while /get-liveboard keys on
    // the guid, so passing a title made the two disagree and the reuse check
    // never matched what had been built.
    let loadedCount = 0;
    const body = await streamBuildPort(LIVEBOARD_STREAM,
      { platform: PLATFORM, guid, datasets },
      (event) => {
        // load-data[N] fires per source; the rest are one-off pipeline stages.
        if (/^load-data\[/.test(event.stage || '') && event.status === 'ok') {
          loadedCount += 1;
          setStep('build', 'active', loadedCount + ' of ' + datasets.length + ' loaded');
        } else if (event.stage === 'generate' || event.stage === 'import') {
          setStep('build', 'active', 'assembling the liveboard');
        }
      });
    if (body.liveboardId) setStep('build', 'done');
    if (!body.liveboardId) {
      const failed = (body.stages || []).find((st) => st.status === 'failed');
      throw new Error(failed ? failed.stage + ': ' + (failed.detail || 'failed') : 'no liveboard id returned');
    }
    return body.liveboardId;
  }

  function createDataset(context, result) {
    // Through the service worker so extension/src/config.js stays the only
    // place the backend URL and key are configured.
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: CREATE_DATASET,
        payload: {
          userid: datasetUserId(context),
          platform: PLATFORM,
          name: [context.reportTitle, context.visualTitle].filter(Boolean).join(' - ') || 'Power BI visual',
          data: {
            columns: result.columns.map((c) => ({ name: c.name })),
            // Raw values, not the formatted strings the table shows, or every
            // measure loads as text.
            rows: (result.rawRows || result.rows).map((row) => row.map(loadableValue)),
          },
        },
      }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('No response from the extension worker.'));
        if (res.error) return reject(new Error(res.error));
        resolve(res.dataset);
      });
    });
  }

  // A liveboard spans the whole report, so it does not depend on the visual's
  // rows — it is built from the report's semantic model.
  function liveboardSection(context) {
    const wrap = document.createElement('div');
    wrap.className = 'ts-spotter-actions';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ts-spotter-more';
    go.textContent = 'Create Liveboard';
    const note = document.createElement('span');
    note.className = 'ts-spotter-note';
    const say = (text) => { note.textContent = text; };
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        const liveboardId = await buildLiveboard(context, (key, state, detail) => {
          say(detail ? key + ': ' + detail : key);
        });
        say('Liveboard ready');
        openSpotter({ ...context, liveboardId });
      } catch (err) {
        say(err.message);
        go.disabled = false;
      }
    });
    wrap.append(go, note);
    return wrap;
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
    if (window.__spotterPanel) window.__spotterPanel.close();
  }

  // Same pipeline as Tableau's openSpotter: read this visual's rows -> load them
  // into ThoughtSpot and build a worksheet -> mount Spotter on THAT worksheet,
  // authenticated as the same user it was shared with. A plain click does the
  // whole thing; the details panel's button is the manual equivalent.
  async function openSpotter(context) {
    closePanel();
    const loading = document.createElement('aside');
    loading.className = FRAME_CLASS + ' ts-spotter-loading';
    const setStep = buildChecklist(loading, 'Setting up Spotter', SPOTTER_STEPS);
    setStep('read', 'active');
    document.body.appendChild(loading);
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: context }));

    // Mounted in this page, not in panel.html: the SDK derives hostAppUrl from
    // window.location.host, and from the extension origin the cluster 401s
    // every embed call so Spotter never starts a conversation.
    const openPanelFrame = (extra) => {
      loading.remove();
      const panel = window.__spotterPanel;
      if (!panel) {
        console.error('[Power BI Spotter] dist/inpage-panel.js did not load — run `npm run build` in extension/.');
        return;
      }
      panel.open({ ...context, platform: PLATFORM, ...extra }, FRAME_CLASS);
    };

    const userid = datasetUserId(context);
    try {
      // Already built (details panel route) — just embed it.
      if (context.worksheetId) return openPanelFrame({ userid, workspace: userid });
      if (!context.visualId) throw new Error('no visual id for this view');
      setStep('read', 'done', context.visualTitle || 'this visual');
      setStep('load', 'active');
      const result = await requestData(context.visualId, 'summary', MAX_LOAD_ROWS);
      const body = await createDataset(context, result);
      const worksheetId = (body.embed && body.embed.worksheetId)
        || (body.dataset && (body.dataset.worksheetId || body.dataset.tableId));
      const worksheetName = body.dataset && (body.dataset.worksheetName || body.dataset.tableName);
      // workspace is the userid the embed authenticates as — keep it equal to
      // the one /dataset provisioned and shared for, or the model is invisible
      // and Spotter sits on a disabled send button.
      setStep('load', 'done');
      setStep('open', 'active');
      openPanelFrame({ worksheetId, worksheetName, userid, workspace: userid });
    } catch (err) {
      setStep('load', 'error', err.message.slice(0, 60));
      openPanelFrame({ userid, workspace: userid, loadError: err.message });
    }
  }

  // Selectors are the part most likely to drift on a Power BI release, so
  // report what was actually on the page when nothing matched.
  function probe() {
    const page = currentPageName();
    const onPage = layoutVisuals.filter((v) => !page || v.section === page);
    console.log('[Power BI Spotter] titles:', document.querySelectorAll(TITLE_SELECTOR).length,
      '| transforms:', document.querySelectorAll(TRANSFORM_SELECTOR).length,
      '| buttons:', document.querySelectorAll('.' + BUTTON_CLASS).length);
    // Whether the canvas matched the report layout is what decides if a
    // liveboard can be built at all, so it is the first thing to look at.
    console.log('  page:', currentPageTitle() || page,
      '| layout visuals here:', onPage.length,
      '| matched:', matched.size, 'of', canvasVisuals().length, 'on canvas');
    canvasVisuals().forEach((cv) => {
      const hit = matched.get(cv.el);
      console.log('   ', hit ? '✓' : '✗', JSON.stringify(cv.title || '(untitled)'),
        hit ? hit.visualType : '—');
    });
    return { page, matched: matched.size, canvas: canvasVisuals().length, layout: onPage.length };
  }
  // A host page that wants this report as a ThoughtSpot Liveboard loads the
  // report in a hidden frame and asks here, because the data has to be read
  // from Power BI with the signed-in session and that only exists in this
  // frame. The answer is a liveboard id the host can embed; the frame is then
  // thrown away, so the report itself is never shown.
  const BUILD_REQUEST = 'spotter:build-liveboard';
  const BUILD_RESULT = 'spotter:liveboard-built';

  addEventListener('message', async (ev) => {
    if (!ev.data || ev.data.type !== BUILD_REQUEST) return;
    const reply = (payload) => {
      try { (ev.source || parent).postMessage({ type: BUILD_RESULT, ...payload }, '*'); } catch (e) { /* gone */ }
    };
    try {
      // Wait for the layout: a frame that has only just loaded has no visuals
      // to read yet, and the host cannot know when that changes.
      for (let i = 0; i < 90 && !layoutVisuals.length; i += 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      const context = reportContext();
      const liveboardId = await buildLiveboard(context, (key, state, detail) => {
        reply({ progress: { key, state, detail } });
      });
      reply({ liveboardId, userid: datasetUserId(context), pageTitle: context.pageTitle });
    } catch (err) {
      reply({ error: String((err && err.message) || err) });
    }
  });

  window.__spotterProbe = probe;

  let scanTimer = null;
  let everInjected = false;
  let lastMatchKey = null;
  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      sync();
      ensureLiveboardButton();
      // Re-match whenever what is on screen changes. Keying on the count of
      // buttons alone missed two things: a page switch between two pages holding
      // the same number of visuals, which left every tile pointing at the old
      // page; and the moment a visual gains its geometry, since Power BI lays
      // the canvas out at zero size until the tab is actually visible, and a
      // match attempted before that has nothing to line up against.
      const onCanvas = canvasVisuals();
      const key = currentPageName() + '|' + onCanvas.length + '|'
        + onCanvas.map((v) => v.title).join('\u0001');
      if (key !== lastMatchKey) { lastMatchKey = key; matchLayout(); }
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
