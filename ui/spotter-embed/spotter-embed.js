import { STYLES } from './styles.js';

const DEFAULTS = {
  platform: 'unknown',
  label: 'Spotter',
  accent: '#2770ef',
  subject: () => null,
  contextRows: [],
  dataKinds: ['summary'],
  underlyingCap: 10000,
  chunk: 500,
};

const EMPTY = '—';

function isPrimitive(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function pick(context, source) {
  return typeof source === 'function' ? source(context) : context[source];
}

export class SpotterEmbed {
  constructor(config = {}, hooks = {}) {
    this.config = { ...DEFAULTS, ...config };
    this.hooks = hooks;
    this.doc = hooks.document || document;
    this.host = null;
    this.root = null;
    this.summary = null;
    this.underlying = null;
    this.onKeydown = (ev) => {
      if (ev.key === 'Escape') this.close();
    };
  }

  get isOpen() {
    return this.host !== null;
  }

  open(context) {
    this.close();
    this.context = context;
    this.summary = null;
    this.underlying = null;
    this.host = this.el('div');
    this.host.style.setProperty('--accent', this.config.accent);
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = this.el('style');
    style.textContent = STYLES;
    this.root.append(style, this.renderPanel(context));
    (this.hooks.mount || this.doc.body).appendChild(this.host);
    this.doc.addEventListener('keydown', this.onKeydown);
    this.loadSummary(context);
    return this;
  }

  close() {
    if (!this.host) return;
    this.host.remove();
    this.host = null;
    this.root = null;
    this.doc.removeEventListener('keydown', this.onKeydown);
  }

  el(tag, className, text) {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  renderPanel(context) {
    const panel = this.el('aside', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Spotter');
    const header = this.el('header');
    const title = this.el('span', null, 'Spotter');
    title.appendChild(this.el('span', 'platform', this.config.label));
    const close = this.el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close Spotter');
    close.addEventListener('click', () => this.close());
    header.append(title, close);
    this.body = this.el('div', 'body');
    panel.append(header, this.renderContextRows(context), this.body);
    return panel;
  }

  renderContextRows(context) {
    const dl = this.el('dl', 'rows');
    this.config.contextRows.forEach(([label, source]) => {
      const value = pick(context, source);
      dl.append(this.el('dt', null, label), this.el('dd', null, value == null || value === '' ? EMPTY : String(value)));
    });
    return dl;
  }

  async loadSummary(context) {
    const subject = this.config.subject(context);
    if (!this.hooks.loadData) {
      this.body.textContent = 'No data source connected.';
      return;
    }
    this.body.textContent = 'Loading data' + (subject ? ' for ' + subject : '') + '…';
    try {
      this.summary = await this.hooks.loadData('summary', context);
    } catch (err) {
      this.body.textContent = '';
      this.body.appendChild(this.el('div', 'error', err && err.message ? err.message : String(err)));
      return;
    }
    if (!this.isOpen) return;
    this.body.textContent = '';
    this.body.append(this.el('h3', null, 'Shape'), this.renderShape(this.summary));
    if (this.hooks.sendSession) this.body.append(this.el('h3', null, 'Backend'), this.renderSend());
    this.body.append(
      this.el('h3', null, 'Summary data (' + this.summary.rows.length + ' rows)'),
      this.renderTable(this.summary)
    );
    if (this.config.dataKinds.includes('underlying')) {
      this.body.append(this.el('h3', null, 'Underlying data'), this.renderUnderlying(context));
    }
  }

  renderShape(data) {
    const dl = this.el('dl', 'rows');
    const add = (label, value) => dl.append(this.el('dt', null, label), this.el('dd', null, value));
    add('Rows', String(data.totalRows ?? data.rows.length));
    add('Columns', data.columns.map((c) => c.name + (c.type ? ' (' + c.type + ')' : '')).join('\n'));
    if (data.filters) add('Filters', data.filters.length ? data.filters.map(describeFilter).join('\n') : 'none');
    if (data.parameters) {
      add('Parameters', data.parameters.length ? data.parameters.map((p) => p.name + ' = ' + p.value).join('\n') : 'none');
    }
    if (data.selectedMarks != null) add('Selected marks', String(data.selectedMarks));
    return dl;
  }

  renderTable(data, chunk) {
    const wrap = this.el('div');
    const table = this.el('table');
    const headRow = this.el('tr');
    headRow.appendChild(this.el('th', null, '#'));
    data.columns.forEach((c) => headRow.appendChild(this.el('th', null, c.name)));
    const head = this.el('thead');
    head.appendChild(headRow);
    const tbody = this.el('tbody');
    table.append(head, tbody);
    wrap.appendChild(table);

    const size = chunk || data.rows.length;
    let shown = 0;
    const append = (to) => {
      for (let i = shown; i < to; i++) {
        const tr = this.el('tr');
        tr.appendChild(this.el('td', 'rownum', String(i + 1)));
        data.rows[i].forEach((cell) => tr.appendChild(this.el('td', null, cell == null ? '' : String(cell))));
        tbody.appendChild(tr);
      }
      shown = to;
    };
    append(Math.min(size, data.rows.length));
    if (shown < data.rows.length) {
      const more = this.el('button', 'action');
      more.type = 'button';
      const label = () => 'Show ' + Math.min(size, data.rows.length - shown) + ' more (' + shown + ' of ' + data.rows.length + ')';
      more.textContent = label();
      more.addEventListener('click', () => {
        append(Math.min(shown + size, data.rows.length));
        if (shown >= data.rows.length) more.remove();
        else more.textContent = label();
      });
      wrap.appendChild(more);
    }
    return wrap;
  }

  renderUnderlying(context) {
    const section = this.el('div');
    const load = this.el('button', 'action');
    load.type = 'button';
    load.textContent = 'Load underlying rows (all columns, up to ' + this.config.underlyingCap.toLocaleString() + ')';
    load.addEventListener('click', async () => {
      load.disabled = true;
      load.textContent = 'Loading underlying rows…';
      try {
        this.underlying = await this.hooks.loadData('underlying', context);
      } catch (err) {
        load.disabled = false;
        load.textContent = 'Retry: ' + (err && err.message ? err.message : String(err));
        return;
      }
      load.remove();
      const capped = this.underlying.rows.length >= this.config.underlyingCap;
      section.append(
        this.el(
          'div',
          'note',
          this.underlying.rows.length.toLocaleString() + ' rows × ' + this.underlying.columns.length + ' columns' +
            (capped ? ' (API cap reached; the table may be larger)' : '')
        ),
        this.renderTable(this.underlying, this.config.chunk)
      );
    });
    section.appendChild(load);
    return section;
  }

  renderSend() {
    const section = this.el('div');
    const send = this.el('button', 'action', 'Send to Spotter backend');
    send.type = 'button';
    const result = this.el('div', 'note');
    send.addEventListener('click', async () => {
      send.disabled = true;
      send.textContent = 'Sending…';
      const payload = this.buildPayload();
      try {
        const res = await this.hooks.sendSession(payload);
        result.className = 'note';
        result.textContent =
          'Session ' + res.id + ' (' + payload.context.dataKind + ', ' + payload.data.rows.length + ' rows)' + (res.url ? ' at ' + res.url : '');
      } catch (err) {
        result.className = 'note error';
        result.textContent = err && err.message ? err.message : String(err);
      }
      send.disabled = false;
      send.textContent = 'Send to Spotter backend';
    });
    section.append(send, result);
    return section;
  }

  buildPayload() {
    if (this.hooks.buildPayload) return this.hooks.buildPayload(this.context, this.summary, this.underlying);
    const data = this.underlying || this.summary;
    const context = {};
    for (const [k, v] of Object.entries(this.context)) if (isPrimitive(v)) context[k] = v;
    context.dataKind = this.underlying ? 'underlying' : 'summary';
    context.summaryRows = this.summary.totalRows ?? this.summary.rows.length;
    if (this.summary.filters) context.filters = JSON.stringify(this.summary.filters);
    if (this.summary.parameters) context.parameters = JSON.stringify(this.summary.parameters);
    return {
      platform: this.config.platform,
      context,
      data: { columns: data.columns, rows: data.rows, totalRows: data.totalRows ?? data.rows.length },
    };
  }
}

function describeFilter(f) {
  if (f.values) return f.field + ': ' + (f.exclude ? 'exclude ' : '') + f.values.join(', ');
  if (f.min != null) return f.field + ': ' + f.min + ' to ' + f.max;
  if (f.period) return f.field + ': ' + f.range + ' ' + f.period;
  return f.field + ': ' + f.type;
}
