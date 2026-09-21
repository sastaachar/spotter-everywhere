(() => {
  // Runs in the portal page's MAIN world: tableau.VizManager is only visible there.
  const REQUEST = 'spotter:request';
  const RESPONSE = 'spotter:response';

  function findWorksheet(name) {
    const vm = window.tableau && window.tableau.VizManager;
    const vizs = vm ? vm.getVizs() : [];
    for (const viz of vizs) {
      const sheet = viz.getWorkbook().getActiveSheet();
      if (sheet.getSheetType() === 'dashboard') {
        const ws = sheet.getWorksheets().find((w) => w.getName() === name);
        if (ws) return { viz, ws };
      } else if (sheet.getName() === name) {
        return { viz, ws: sheet };
      }
    }
    return null;
  }

  function describeFilter(f) {
    const out = { field: f.getFieldName(), type: f.getFilterType() };
    try {
      if (f.getAppliedValues) {
        out.exclude = !!(f.getIsExcludeMode && f.getIsExcludeMode());
        out.values = f.getAppliedValues().map((v) => v.formattedValue);
      } else if (f.getMin && f.getMax) {
        out.min = f.getMin().formattedValue;
        out.max = f.getMax().formattedValue;
      } else if (f.getPeriod) {
        out.period = f.getPeriod();
        out.range = f.getRange();
      }
    } catch (e) {
      out.detail = String((e && e.message) || e);
    }
    return out;
  }

  async function describe(name) {
    const found = findWorksheet(name);
    if (!found) throw new Error('Worksheet not found in the active dashboard: ' + name);
    const { viz, ws } = found;
    const [data, filters, params, marks] = await Promise.all([
      ws.getSummaryDataAsync({ ignoreSelection: true }),
      ws.getFiltersAsync(),
      viz.getWorkbook().getParametersAsync(),
      ws.getSelectedMarksAsync(),
    ]);
    return {
      worksheet: ws.getName(),
      columns: data.getColumns().map((c) => ({ name: c.getFieldName(), type: c.getDataType() })),
      totalRows: data.getTotalRowCount(),
      rows: data.getData().map((r) => r.map((c) => c.formattedValue)),
      filters: filters.map(describeFilter),
      parameters: params.map((p) => ({ name: p.getName(), value: p.getCurrentValue().formattedValue })),
      selectedMarks: marks.length,
    };
  }

  window.addEventListener('message', (ev) => {
    if (ev.origin !== location.origin || !ev.data || ev.data.type !== REQUEST) return;
    const { requestId, worksheet } = ev.data;
    const reply = (payload) =>
      ev.source && ev.source.postMessage({ type: RESPONSE, requestId, ...payload }, ev.origin);
    describe(worksheet).then(
      (result) => reply({ result }),
      (err) => reply({ error: String((err && err.message) || err) })
    );
  });
})();
