// Embed host: a customer's own application, where neither Power BI nor Tableau
// is the page — it is something the page wants to put inside itself.
//
// The extension already lights up a BI tool wherever it renders, including in a
// subframe. What a customer site still has to do is write the embed: find the
// report URL, build the reportEmbed address, mount an iframe. This does that
// from a button, so a page gets an embedded report with Spotter and Liveboard
// on it without writing any embed code of its own.
(() => {
  const BUTTON_CLASS = 'ts-embed-btn';
  const PANEL_CLASS = 'ts-embed-panel';
  const MOUNTED_ATTR = 'data-ts-embed';
  const EMBED_BASE = 'https://app.powerbi.com/reportEmbed';
  // Matches .../reports/<id> and .../reports/<id>/<pageId>, with or without a
  // group — the same shape a person copies out of the Power BI address bar.
  const REPORT_URL = /\/(?:groups\/([^/]+)\/)?reports\/([0-9a-f-]{36})(?:\/([^/?#]+))?/i;

  // The report this demo embeds when a page does not name one of its own.
  const DEMO_REPORT = 'https://app.powerbi.com/groups/me/reports/'
    + '9f5b3b87-8700-45f3-8cb4-4fe65e59a38d/ReportSectionb621f12070647be09138';

  /**
   * The report a page wants embedded.
   *
   * A page opts in by naming one, which is also how it says it wants the button
   * at all — nobody wants a floating button on every site they open. A page
   * served from a developer's own machine gets the demo report without asking,
   * since that is what the test harness is for.
   */
  function wantedReport() {
    const meta = document.querySelector('meta[name="spotter-powerbi-report"]');
    const marked = document.querySelector('[data-spotter-powerbi-report]');
    const declared = (meta && meta.content)
      || (marked && marked.getAttribute('data-spotter-powerbi-report'));
    if (declared && declared.trim()) return declared.trim();
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
      || location.protocol === 'file:';
    return local ? DEMO_REPORT : null;
  }

  /** The reportEmbed address Power BI serves an embedded report from. */
  function embedUrl(report) {
    const m = report.match(REPORT_URL);
    if (!m) return null;
    const url = new URL(EMBED_BASE);
    url.searchParams.set('reportId', m[2]);
    // "me" is the personal workspace, not a real group id.
    if (m[1] && m[1] !== 'me') url.searchParams.set('groupId', m[1]);
    if (m[3]) url.searchParams.set('pageName', m[3]);
    // Reuses the signed-in Power BI session, so the page needs no token and no
    // server. A production embed would mint one server-side; the extension sees
    // the same thing either way.
    url.searchParams.set('autoAuth', 'true');
    return url.toString();
  }

  const SPARKLE_SVG =
    '<svg viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z"/>'
    + '<path d="M13 11l.7 1.8L15.5 13.5l-1.8.7L13 16l-.7-1.8-1.8-.7 1.8-.7z"/></svg>';

  /**
   * Where the report goes: into the page's own content, not over it.
   *
   * A page that marks a slot gets the report *in* that slot, replacing whatever
   * placeholder it was holding — otherwise the page ends up showing two report
   * areas, its own empty one and ours below it, which reads as a mistake.
   */
  function mountPoint() {
    const slot = document.querySelector('[data-spotter-embed-here]');
    if (slot) { slot.textContent = ''; return slot; }
    return document.querySelector('main') || document.body;
  }

  function embed(report) {
    const src = embedUrl(report);
    if (!src) return null;

    const panel = document.createElement('section');
    panel.className = PANEL_CLASS;
    panel.setAttribute(MOUNTED_ATTR, '1');

    const head = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = 'Power BI · Spotter Everywhere';
    const note = document.createElement('span');
    note.textContent = 'Ask Spotter, or build a Liveboard, from inside the report';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ts-embed-close';
    close.setAttribute('aria-label', 'Remove the embedded report');
    close.textContent = '×';
    close.addEventListener('click', () => panel.remove());
    head.append(title, note, close);

    const frame = document.createElement('iframe');
    frame.title = 'Embedded Power BI report';
    frame.src = src;
    frame.setAttribute('allowfullscreen', '');
    frame.referrerPolicy = 'no-referrer-when-downgrade';

    panel.append(head, frame);
    mountPoint().appendChild(panel);
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return panel;
  }

  function build(report) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.title = 'Embed this Power BI report, with Spotter and Liveboard on it';
    const label = document.createElement('span');
    label.textContent = 'Embed with Spotter';
    btn.innerHTML = SPARKLE_SVG;
    btn.appendChild(label);
    // The slot's own markup, so removing the report can put it back.
    const slot = document.querySelector('[data-spotter-embed-here]');
    const placeholder = slot ? slot.innerHTML : null;

    const setLabel = (embedded) => {
      label.textContent = embedded ? 'Remove report' : 'Embed with Spotter';
      btn.title = embedded
        ? 'Take the embedded report back out of this page'
        : 'Embed this Power BI report, with Spotter and Liveboard on it';
    };

    btn.addEventListener('click', () => {
      const open = document.querySelector('.' + PANEL_CLASS);
      if (open) {
        open.remove();
        if (slot && placeholder !== null) slot.innerHTML = placeholder;
        setLabel(false);
        return;
      }
      if (embed(report)) setLabel(true);
      else console.error('[Spotter Embed] not a Power BI report URL:', report);
    });
    return btn;
  }

  const report = wantedReport();
  if (!report) return;
  if (document.querySelector('.' + BUTTON_CLASS)) return;
  document.body.appendChild(build(report));
  console.log('[Spotter Embed] ready for', report);
})();
