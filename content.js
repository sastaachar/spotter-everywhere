(() => {
  // Tableau regenerates the digits in title<digits>_<digits> per session.
  const TITLE_ID_PATTERN = /^title\d+_\d+$/;
  const TITLE_ROOT_SELECTOR = '[id^="title"]';
  const TITLE_TEXT_PATH = ':scope > div:nth-child(1) > div > span > div';
  const INJECTED_ATTR = 'data-ts-spotter';
  const BUTTON_CLASS = 'ts-spotter-btn';
  const PANEL_CLASS = 'ts-spotter-panel';
  const OPEN_EVENT = 'spotter:open';
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

  function buildButton(sheetTitle) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.title = 'Ask Spotter about this sheet';
    btn.setAttribute('aria-label', 'Open Spotter');
    btn.innerHTML = SPARKLE_SVG + '<span>Spotter</span>';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openPanel(sheetTitle());
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
    textEl.appendChild(buildButton(sheetTitle));
  }

  function openPanel(sheetTitle) {
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

    const sheet = document.createElement('div');
    sheet.className = 'ts-spotter-sheet';
    sheet.textContent = sheetTitle ? 'Sheet: ' + sheetTitle : 'Sheet: (untitled)';

    const body = document.createElement('div');
    body.className = 'ts-spotter-body';
    body.textContent = 'Spotter insights will appear here.';

    panel.append(header, sheet, body);
    document.body.appendChild(panel);

    document.dispatchEvent(
      new CustomEvent(OPEN_EVENT, { detail: { sheetTitle, url: location.href } })
    );
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
