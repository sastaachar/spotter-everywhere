// Embed host: a customer's own application.
//
// The button here does not put a Power BI report on the page — it puts the
// ThoughtSpot Liveboard for that report on the page. The report is read once,
// out of sight, and what the customer sees is the finished liveboard.
//
// Reading it has to happen inside Power BI: the data comes from Power BI's own
// query service, authenticated by the signed-in session, which only exists in a
// frame on app.powerbi.com. So a hidden frame loads the report, the Power BI
// content script in it builds the liveboard, and the frame is then discarded.
(() => {
  const BUTTON_CLASS = 'ts-embed-btn';
  const SETTINGS_CLASS = 'ts-embed-settings';
  const PANEL_CLASS = 'ts-embed-panel';
  const EMBED_BASE = 'https://app.powerbi.com/reportEmbed';
  const REPORT_URL = /\/(?:groups\/([^/]+)\/)?reports\/([0-9a-f-]{36})(?:\/([^/?#]+))?/i;
  const STORE_KEY = 'spotter-embed-report';
  const BUILD_REQUEST = 'spotter:build-liveboard';
  const BUILD_RESULT = 'spotter:liveboard-built';

  const DEMO_REPORT = 'https://app.powerbi.com/groups/me/reports/'
    + '9f5b3b87-8700-45f3-8cb4-4fe65e59a38d/ReportSectionb621f12070647be09138';

  /** The report the page named, or the one the customer last set here. */
  function declaredReport() {
    const meta = document.querySelector('meta[name="spotter-powerbi-report"]');
    const marked = document.querySelector('[data-spotter-powerbi-report]');
    const declared = (meta && meta.content)
      || (marked && marked.getAttribute('data-spotter-powerbi-report'));
    if (declared && declared.trim()) return declared.trim();
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
      || location.protocol === 'file:';
    return local ? DEMO_REPORT : null;
  }

  function storedReport() {
    try { return localStorage.getItem(STORE_KEY) || null; } catch { return null; }
  }
  function storeReport(url) {
    try { localStorage.setItem(STORE_KEY, url); } catch { /* private window */ }
  }

  /** The reportEmbed address, used only for the frame the report is read from. */
  function embedUrl(report) {
    const m = report.match(REPORT_URL);
    if (!m) return null;
    const url = new URL(EMBED_BASE);
    url.searchParams.set('reportId', m[2]);
    if (m[1] && m[1] !== 'me') url.searchParams.set('groupId', m[1]);
    if (m[3]) url.searchParams.set('pageName', m[3]);
    url.searchParams.set('autoAuth', 'true');
    return url.toString();
  }

  const SPARKLE_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z"/>'
    + '<path d="M13 11l.7 1.8L15.5 13.5l-1.8.7L13 16l-.7-1.8-1.8-.7 1.8-.7z"/></svg>';

  function mountPoint() {
    const slot = document.querySelector('[data-spotter-embed-here]');
    if (slot) return slot;
    return document.querySelector('main') || document.body;
  }

  /**
   * Ask the report that is already on the page for its Liveboard.
   *
   * The data has to be read inside Power BI — it comes from Power BI's own
   * query service, authenticated by the signed-in session, which exists only in
   * a frame on app.powerbi.com. The report is already in such a frame, so it
   * does the work and hands back a liveboard id.
   */
  function harvest(frame, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        removeEventListener('message', onMessage);
        fn(arg);
      };
      function onMessage(ev) {
        if (ev.source !== frame.contentWindow || !ev.data || ev.data.type !== BUILD_RESULT) return;
        if (ev.data.progress) return onProgress(ev.data.progress);
        if (ev.data.error) return finish(reject, new Error(ev.data.error));
        finish(resolve, { liveboardId: ev.data.liveboardId, userid: ev.data.userid, pageTitle: ev.data.pageTitle });
      }
      addEventListener('message', onMessage);
      try { frame.contentWindow.postMessage({ type: BUILD_REQUEST }, '*'); }
      catch (e) { finish(reject, new Error('Could not reach the report frame.')); }
      setTimeout(() => finish(reject, new Error('Timed out reading the report.')), 15 * 60 * 1000);
    });
  }

  /** Steps, so a build that takes a minute says what it is doing. */
  const STEPS = [
    { key: 'check', label: 'Looking for an existing Liveboard' },
    { key: 'read', label: 'Reading the report' },
    { key: 'build', label: 'Building the Liveboard' },
    { key: 'open', label: 'Opening it here' },
  ];

  function progressCard(container, title) {
    container.textContent = '';
    const card = document.createElement('div');
    card.className = 'ts-embed-progress';
    const head = document.createElement('div');
    head.className = 'ts-embed-progress-head';
    const mark = document.createElement('span');
    mark.className = 'ts-embed-progress-mark';
    mark.innerHTML = SPARKLE_SVG;
    const titles = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = title;
    const sub = document.createElement('span');
    sub.textContent = 'Powered by ThoughtSpot';
    titles.append(strong, sub);
    head.append(mark, titles);
    const track = document.createElement('div');
    track.className = 'ts-embed-progress-track';
    const fill = document.createElement('span');
    track.appendChild(fill);
    const rows = {};
    const list = document.createElement('div');
    list.className = 'ts-embed-steps';
    STEPS.forEach((step) => {
      const row = document.createElement('div');
      row.className = 'ts-embed-step';
      row.dataset.state = 'pending';
      const icon = document.createElement('span');
      icon.className = 'ts-embed-step-icon';
      const label = document.createElement('span');
      label.className = 'ts-embed-step-label';
      label.textContent = step.label;
      const detail = document.createElement('span');
      detail.className = 'ts-embed-step-detail';
      row.append(icon, label, detail);
      list.appendChild(row);
      rows[step.key] = row;
    });
    card.append(head, track, list);
    container.appendChild(card);
    const order = STEPS.map((s) => s.key);
    return (key, state, detail) => {
      const at = order.indexOf(key);
      order.forEach((k, i) => { if (i < at) rows[k].dataset.state = 'done'; });
      const row = rows[key];
      if (row) {
        row.dataset.state = state;
        row.querySelector('.ts-embed-step-detail').textContent = detail || '';
      }
      const done = order.filter((k) => rows[k].dataset.state === 'done').length;
      fill.style.width = Math.round(((done + (state === 'active' ? 0.5 : 0)) / order.length) * 100) + '%';
    };
  }

  function failure(container, message, onRetry) {
    container.textContent = '';
    const box = document.createElement('div');
    box.className = 'ts-embed-failed';
    const line = document.createElement('p');
    line.textContent = message;
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'ts-embed-retry';
    again.textContent = 'Try again';
    again.addEventListener('click', onRetry);
    box.append(line, again);
    container.appendChild(box);
  }

  function frame(host, heading, subtitle) {
    const panel = document.createElement('section');
    panel.className = PANEL_CLASS;
    const head = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = heading;
    const note = document.createElement('span');
    note.textContent = subtitle;
    head.append(title, note);
    const body = document.createElement('div');
    body.className = 'ts-embed-body';
    panel.append(head, body);
    host.textContent = '';
    host.appendChild(panel);
    return { panel, head, body };
  }

  /** The Power BI report itself, in the page — the "before". */
  function showReport(report, host) {
    const src = embedUrl(report);
    if (!src) throw new Error('That is not a Power BI report URL.');
    const { head, body } = frame(host, 'Power BI', 'The report as Power BI renders it');
    head.dataset.tool = 'powerbi';
    const iframe = document.createElement('iframe');
    iframe.title = 'Embedded Power BI report';
    iframe.src = src;
    iframe.setAttribute('allowfullscreen', '');
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    body.appendChild(iframe);
    return iframe;
  }

  /** The same report as a ThoughtSpot Liveboard — the "after". */
  async function showLiveboard(reportFrame, host, onDone) {
    const panel = host.querySelector('.' + PANEL_CLASS);
    const head = panel.querySelector('header');
    const body = panel.querySelector('.ts-embed-body');
    // The report frame stays exactly where it is. Moving an iframe in the DOM
    // reloads it, and the frame is the only thing that can read the report —
    // re-parenting it restarted the content script and the build request went
    // to a frame that no longer existed. So cover it instead of moving it.
    const cover = document.createElement('div');
    cover.className = 'ts-embed-cover';
    body.appendChild(cover);
    const step = progressCard(cover, 'Building your Liveboard');
    try {
      step('check', 'active');
      const built = await harvest(reportFrame, (p) => step(p.key, p.state, p.detail));
      step('build', 'done');
      step('open', 'active');
      if (!window.__spotterLiveboard) throw new Error('The Liveboard embed did not load — reload the page.');
      // Only now is the report replaced: up to here it has been doing the work.
      reportFrame.remove();
      cover.remove();
      await window.__spotterLiveboard.mount(body, built.liveboardId, built.userid);
      head.dataset.tool = 'thoughtspot';
      head.querySelector('strong').textContent = 'ThoughtSpot Liveboard';
      head.querySelector('span').textContent = built.pageTitle
        ? built.pageTitle + ' · the same report, in ThoughtSpot'
        : 'The same report, in ThoughtSpot';
      onDone(true);
    } catch (err) {
      console.error('[Spotter Embed]', err);
      failure(cover, err.message, () => { cover.remove(); onDone(false); });
      onDone(false);
    }
  }

  function settingsPanel(current, onSave) {
    const box = document.createElement('div');
    box.className = SETTINGS_CLASS;
    const label = document.createElement('label');
    label.textContent = 'Power BI report URL';
    const row = document.createElement('div');
    row.className = 'ts-embed-settings-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = current;
    input.placeholder = 'https://app.powerbi.com/groups/…/reports/…';
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Build Liveboard';
    const hint = document.createElement('p');
    hint.className = 'ts-embed-settings-hint';
    hint.textContent = 'Any report you can open in Power BI. Changing it builds that '
      + "report's Liveboard and shows it here.";
    save.addEventListener('click', () => {
      const value = input.value.trim();
      if (!REPORT_URL.test(value)) {
        input.setCustomValidity('Not a Power BI report URL');
        input.reportValidity();
        return;
      }
      box.hidden = true;
      onSave(value);
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    row.append(input, save);
    box.append(label, row, hint);
    box.hidden = true;
    return { box, input };
  }

  function topOffset() {
    let bottom = 0;
    document.querySelectorAll('header, [role="banner"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top <= 8) bottom = Math.max(bottom, r.bottom);
    });
    return Math.round(bottom) + 12;
  }

  const declared = declaredReport();
  if (!declared) return;
  if (document.querySelector('.' + BUTTON_CLASS)) return;

  let report = storedReport() || declared;
  const host = mountPoint();

  const bar = document.createElement('div');
  bar.className = 'ts-embed-bar';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.title = 'Build this report as a ThoughtSpot Liveboard and show it here';
  const label = document.createElement('span');
  label.textContent = 'Embed with Spotter';
  button.innerHTML = SPARKLE_SVG;
  button.appendChild(label);

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'ts-embed-gear';
  gear.title = 'Embed settings';
  gear.setAttribute('aria-label', 'Embed settings');
  gear.textContent = '⚙';

  const { box: settings, input } = settingsPanel(report, (value) => {
    report = value;
    storeReport(value);
    // A new report starts where every report starts: showing Power BI.
    toPowerBi();
  });

  // Two views of the same report, and one button between them. The page opens
  // on Power BI — what the customer has today — and the button replaces it with
  // the ThoughtSpot Liveboard of that same report.
  const POWERBI = 'Replace with ThoughtSpot';
  const THOUGHTSPOT = 'Show the Power BI report';
  let reportFrame = null;
  let showing = 'none';

  function toPowerBi() {
    try {
      reportFrame = showReport(report, host);
      showing = 'powerbi';
      label.textContent = POWERBI;
      button.title = 'Build this report as a ThoughtSpot Liveboard and show that instead';
      button.disabled = false;
    } catch (err) {
      failure(host, err.message, () => toPowerBi());
      button.disabled = true;
    }
  }

  function toThoughtSpot() {
    if (!reportFrame) return;
    button.disabled = true;
    label.textContent = 'Building\u2026';
    showing = 'thoughtspot';
    showLiveboard(reportFrame, host, (ok) => {
      reportFrame = null;
      label.textContent = ok ? THOUGHTSPOT : 'Try again';
      button.title = ok ? 'Go back to the Power BI report' : 'Build the Liveboard again';
      button.disabled = false;
      if (!ok) showing = 'powerbi';
    });
  }

  button.addEventListener('click', () => {
    if (showing === 'powerbi') toThoughtSpot();
    else toPowerBi();
  });

  bar.append(button, gear);
  document.body.append(bar, settings);
  const place = () => {
    const top = topOffset();
    bar.style.top = top + 'px';
    settings.style.top = (top + 44) + 'px';
  };
  place();
  addEventListener('resize', place);
  toPowerBi();
  console.log('[Spotter Embed] ready for', report);
})();
