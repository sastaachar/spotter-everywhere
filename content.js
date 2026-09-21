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
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPanel(vizContext(titleRoot, sheetTitle()));
    });
    btn.addEventListener('mousedown', (ev) => ev.stopPropagation());
    return btn;
  }

  function inject({ titleRoot, textEl }) {
    // Tableau's bootstrap replaces the inner text region after we inject,
    // so gate on the button itself rather than a marker on the outer div.
    if (textEl.querySelector(':scope > .' + BUTTON_CLASS)) return;
    titleRoot.setAttribute(INJECTED_ATTR, '1');
    const sheetTitle = () =>
      Array.from(textEl.childNodes)
        .filter((n) => !(n instanceof Element && n.classList.contains(BUTTON_CLASS)))
        .map((n) => n.textContent || '')
        .join('')
        .trim();
    textEl.appendChild(buildButton(titleRoot, sheetTitle));
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
    body.textContent = 'Spotter insights will appear here.';

    panel.append(header, buildRows(context), body);
    document.body.appendChild(panel);

    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: context }));
  }

  function closePanel() {
    document.querySelectorAll('.' + PANEL_CLASS).forEach((el) => el.remove());
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      findTitleTargets(document).forEach(inject);
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
