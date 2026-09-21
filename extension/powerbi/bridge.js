(() => {
  // Runs in the report page's MAIN world: window.powerBIAccessToken and the MWC
  // token are only visible there, and the content script's isolated world
  // cannot read them.
  //
  // Two jobs:
  //   1. Push the report layout once, so the panel can name each visual.
  //   2. Answer 'spotter:request' with a visual's data, same protocol as the
  //      Tableau bridge.
  const REQUEST = 'spotter:request';
  const RESPONSE = 'spotter:response';
  const LAYOUT = 'spotter:layout';
  const EXPLORATION_PATTERN = /^(https:\/\/[^/]*analysis\.windows\.net)\/explore\/reports\/(\d+)\//;
  // A single window tops out at 20,000 rows server side; page below that and
  // follow RestartTokens for anything larger.
  const PAGE_SIZE = 10000;
  const PREVIEW_ROWS = 1000;
  const MAX_ROWS = 20000;
  const POLL_MS = 1500;
  const MAX_WAIT_MS = 45000;

  let explorationPromise = null;

  // The report builds each visual's query with the full Where -- report, page
  // and visual level filters merged, with table aliases already reconciled.
  // Rebuilding that by hand is fragile, so observe the real request instead and
  // replay it. Installed at document_start so nothing is missed.
  const capturedByVisual = new Map();
  let queryEndpoint = null;

  function remember(url, bodyText) {
    let body;
    try { body = JSON.parse(bodyText); } catch (e) { return; }
    const queries = body && body.queries;
    if (!Array.isArray(queries)) return;
    queryEndpoint = url;
    queries.forEach((q) => {
      const source = q.ApplicationContext && q.ApplicationContext.Sources && q.ApplicationContext.Sources[0];
      if (!source || !source.VisualId) return;
      // A visual can issue several queries -- the data query plus auxiliary
      // lookups such as what-if parameter bounds. Keep the richest one rather
      // than whichever landed last.
      const candidate = { envelope: body, query: q };
      const width = (c) => {
        try { return c.query.Query.Commands[0].SemanticQueryDataShapeCommand.Query.Select.length; }
        catch (e) { return 0; }
      };
      const existing = capturedByVisual.get(source.VisualId);
      if (!existing || width(candidate) >= width(existing)) {
        capturedByVisual.set(source.VisualId, candidate);
      }
    });
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (/QueryExecutionService|querydata/i.test(url) && String(method).toUpperCase() === 'POST') {
        const payload = (init && init.body) || (input && input.body);
        if (typeof payload === 'string') remember(url, payload);
      }
    } catch (e) { /* never break the host page */ }
    return nativeFetch.apply(this, arguments);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__tsSpotter = { method: String(method || '').toUpperCase(), url: String(url || '') };
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (payload) {
    try {
      const info = this.__tsSpotter;
      if (info && info.method === 'POST' && /QueryExecutionService|querydata/i.test(info.url)
          && typeof payload === 'string') {
        remember(info.url, payload);
      }
    } catch (e) { /* never break the host page */ }
    return nativeSend.apply(this, arguments);
  };

  // The backend host is region-specific and the numeric report key is not the
  // guid in the URL, so read both off a request the report already made.
  function discover() {
    for (const entry of performance.getEntriesByType('resource')) {
      const m = entry.name.match(EXPLORATION_PATTERN);
      if (m) return { base: m[1], reportKey: m[2] };
    }
    return null;
  }

  function exploration() {
    if (explorationPromise) return explorationPromise;
    const found = discover();
    if (!found) return Promise.reject(new Error('backend host not discovered yet'));
    explorationPromise = fetch(`${found.base}/explore/reports/${found.reportKey}/exploration`, {
      headers: { Authorization: 'Bearer ' + window.powerBIAccessToken },
    }).then((r) => {
      if (!r.ok) throw new Error('exploration ' + r.status);
      return r.json();
    });
    return explorationPromise;
  }

  function literal(objects, name) {
    const entry = objects && objects[name] && objects[name][0];
    const expr = entry && entry.properties && entry.properties.text && entry.properties.text.expr;
    const value = expr && expr.Literal && expr.Literal.Value;
    return typeof value === 'string' ? value.replace(/^'|'$/g, '') : null;
  }

  function visuals(ex) {
    const out = [];
    (ex.sections || []).forEach((section) => {
      (section.visualContainers || []).forEach((vc) => {
        let config = {};
        try { config = JSON.parse(vc.config); } catch (e) { return; }
        const sv = config.singleVisual || {};
        let filters = [];
        try { filters = JSON.parse(vc.filters || '[]') || []; } catch (e) { /* keep empty */ }
        out.push({
          section: section.name,
          visualId: config.name || null,
          visualType: sv.visualType || null,
          title: literal(sv.vcObjects, 'title'),
          roles: Object.fromEntries(
            Object.entries(sv.projections || {}).map(([role, items]) => [
              role, items.map((i) => i.queryRef).filter(Boolean),
            ])
          ),
          filterCount: filters.length,
          rect: { x: vc.x, y: vc.y, w: vc.width, h: vc.height },
          prototypeQuery: sv.prototypeQuery || null,
        });
      });
    });
    return out;
  }

  // Power BI format strings are a superset of .NET's; cover the shapes the
  // service actually emits for measures rather than the whole grammar.
  function formatValue(value, format) {
    if (value == null) return '';
    if (typeof value !== 'number' && !(typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) {
      return String(value);
    }
    const n = Number(value);
    if (!format) return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const positive = format.split(';')[0];
    // .NET placeholders: '0' is a required digit, '#' an optional one, so they
    // set the minimum and maximum fraction digits respectively.
    const fraction = (positive.match(/\.([0#]+)/) || [null, ''])[1];
    const min = (fraction.match(/0/g) || []).length;
    const max = Math.min(fraction.length, 20);
    if (positive.includes('%')) return (n * 100).toFixed(min) + '%';
    const body = n.toLocaleString(undefined, {
      minimumFractionDigits: min,
      maximumFractionDigits: Math.max(min, max),
    });
    const currency = positive.match(/\\?([$€£¥])/);
    return currency ? currency[1] + body : body;
  }

  // DSR packs rows: the first row carries the schema, later rows omit any value
  // that repeats from the row above (bitmask R) or is null (bitmask Ø), and
  // high-cardinality columns are indexes into ValueDicts (schema entry DN).
  function readDsr(data) {
    const ds = (data.dsr && data.dsr.DS && data.dsr.DS[0]) || null;
    if (!ds || !ds.PH || !ds.PH[0]) return { columns: [], rows: [] };
    const bucket = ds.PH.find((p) => p.DM0) || ds.PH[0];
    const records = bucket[Object.keys(bucket)[0]] || [];
    const dicts = ds.ValueDicts || {};
    const byKey = new Map((data.descriptor && data.descriptor.Select || []).map((s) => [s.Value, s]));

    let schema = null;
    const rows = [];
    let previous = [];
    records.forEach((record) => {
      if (record.S) schema = record.S;
      if (!schema) return;
      const repeat = record.R || 0;
      const nulls = record['Ø'] || 0;
      const cells = record.C || [];
      const values = [];
      let cursor = 0;
      for (let i = 0; i < schema.length; i += 1) {
        if (nulls & (1 << i)) values[i] = null;
        else if (repeat & (1 << i)) values[i] = previous[i];
        else values[i] = cells[cursor++];
      }
      previous = values;
      rows.push(values.map((value, i) => {
        const dict = schema[i].DN;
        if (dict && dicts[dict] && typeof value === 'number') return dicts[dict][value];
        return value;
      }));
    });

    const columns = (schema || []).map((s) => {
      const descriptor = byKey.get(s.N);
      return {
        name: descriptor ? descriptor.Name : s.N,
        format: descriptor ? descriptor.Format : null,
        kind: String(s.N).startsWith('G') ? 'group' : 'measure',
      };
    });
    return { columns, rows };
  }

  async function summary(visualId, options) {
    const maxRows = Math.min((options && options.maxRows) || PREVIEW_ROWS, MAX_ROWS);
    const ex = await exploration();
    const target = visuals(ex).find((v) => v.visualId === visualId);
    const captured = capturedByVisual.get(visualId);
    if (!captured) {
      throw new Error('no query captured for this visual yet - it may not have rendered, '
        + 'or it draws no data (image, shape or textbox)');
    }

    const source = captured.query;
    const query = source.Query.Commands[0].SemanticQueryDataShapeCommand.Query;
    const pageSize = Math.min(PAGE_SIZE, maxRows);

    const fetchPage = async (restartTokens) => {
      const window = { Count: pageSize };
      if (restartTokens) window.RestartTokens = restartTokens;
      const body = {
        ...captured.envelope,
        queries: [{
          ...source,
          Query: { Commands: [{ SemanticQueryDataShapeCommand: {
            Query: query,
            // One flat grouping over every projection, so matrix and other
            // hierarchical visuals come back as plain rows.
            Binding: {
              Primary: { Groupings: [{ Projections: query.Select.map((_, i) => i) }] },
              DataReduction: { DataVolume: 4, Primary: { Window: window } },
              Version: 1,
            },
            ExecutionMetricsKind: 1,
          } }] },
          QueryId: '',
        }],
        cancelQueries: [],
      };
      // The capacity query service authenticates with the MWC token from the
      // exploration payload, not the Bearer token the rest of the API uses.
      const res = await fetch(queryEndpoint || (ex.capacityUri + 'query'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Authorization: 'MWCToken ' + ex.mwcToken,
          ActivityId: crypto.randomUUID(),
          RequestId: crypto.randomUUID(),
          'x-ms-workload-resource-moniker': ex.report.model.dbName,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('query ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const payload = await res.json();
      const result = payload.results && payload.results[0] && payload.results[0].result;
      if (!result) throw new Error('no result in query response');
      const ds = result.data.dsr && result.data.dsr.DS && result.data.dsr.DS[0];
      return { ...readDsr(result.data), restartTokens: (ds && ds.RT) || null };
    };

    let columns = [];
    let rows = [];
    let restartTokens = null;
    let pages = 0;
    do {
      const page = await fetchPage(restartTokens);
      if (!columns.length) columns = page.columns;
      // A restart token is inclusive, so every page after the first repeats the
      // previous page's last row.
      rows = rows.concat(pages === 0 ? page.rows : page.rows.slice(1));
      restartTokens = page.restartTokens;
      pages += 1;
    } while (restartTokens && rows.length < maxRows && pages < 20);
    if (rows.length > maxRows) rows = rows.slice(0, maxRows);

    return {
      visualId,
      visualType: target ? target.visualType : null,
      title: target ? target.title : null,
      filterConditions: (query.Where || []).length,
      columns,
      rows: rows.map((r) => r.map((v, i) => formatValue(v, columns[i] && columns[i].format))),
      rowCount: rows.length,
      pages,
      truncated: !!restartTokens,
    };
  }

  const HANDLERS = { summary };

  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !ev.data || ev.data.type !== REQUEST) return;
    const { requestId, visualId, kind, maxRows } = ev.data;
    const reply = (payload) =>
      ev.source && ev.source.postMessage({ type: RESPONSE, requestId, ...payload }, ev.origin);
    const handler = HANDLERS[kind] || summary;
    Promise.resolve()
      .then(() => handler(visualId, { maxRows }))
      .then((result) => reply({ result }), (err) => reply({ error: String((err && err.message) || err) }));
  });

  // Push the layout as soon as the report has talked to its backend.
  (function pushLayout(started) {
    if (!discover()) {
      if (Date.now() - started > MAX_WAIT_MS) return;
      setTimeout(() => pushLayout(started), POLL_MS);
      return;
    }
    exploration().then(
      (ex) => window.postMessage({ type: LAYOUT, visuals: visuals(ex) }, location.origin),
      (err) => window.postMessage({ type: LAYOUT, error: String(err.message || err) }, location.origin)
    );
  })(Date.now());
})();
