// Generate ThoughtSpot TML (a table + a worksheet on top) from a column schema.
// NOTE: TML shape varies by cluster version — validate against the target
// cluster's tml/export output before relying on import.
import type { Column, WorkbookStructure } from './tableau';

export interface GeneratedTml {
  tableName: string;
  worksheetName: string;
  tableTml: string;
  worksheetTml: string;
}

const q = (s: string): string => s.replace(/"/g, '\\"');

const DB_NAME = 'spotter_everywhere';
const SCHEMA_NAME = 'falcon_default_schema';

export function generateTml(name: string, columns: Column[]): GeneratedTml {
  const tableName = `${name} Table`;

  const tableCols = columns.map((c) => [
    `    - name: "${q(c.name)}"`,
    `      db_column_name: ${c.id}`,
    '      properties:',
    `        column_type: ${c.type}`,
    '      db_column_properties:',
    `        data_type: ${c.dataType}`,
  ].join('\n')).join('\n');

  // Falcon tables require db + schema; without them import fails with
  // "db cannot be left empty for falcon table".
  const tableTml = [
    'table:',
    `  name: "${q(tableName)}"`,
    `  db: ${DB_NAME}`,
    `  schema: ${SCHEMA_NAME}`,
    `  db_table: ${slugId(tableName)}`,
    '  columns:',
    tableCols,
    '',
  ].join('\n');

  // A worksheet column references a TABLE PATH alias (<ALIAS>::<Column Name>),
  // never the table name — that is what a real tml/export emits, and without
  // the table_paths block every column fails with "Model/Worksheet columns use
  // invalid table columns". Same shape as generateWorksheetOnTable below.
  const alias = `${tableName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'T'}_1`;

  const wsCols = columns.map((c) => [
    `    - name: "${q(c.name)}"`,
    `      column_id: "${q(alias)}::${q(c.name)}"`,
    '      properties:',
    `        column_type: ${c.type}`,
  ].join('\n')).join('\n');

  const worksheetTml = [
    'worksheet:',
    `  name: "${q(name)}"`,
    '  tables:',
    `    - name: "${q(tableName)}"`,
    '  table_paths:',
    `    - id: "${q(alias)}"`,
    `      table: "${q(tableName)}"`,
    '      join_path:',
    '      - {}',
    '  worksheet_columns:',
    wsCols,
    '',
  ].join('\n');

  return { tableName, worksheetName: name, tableTml, worksheetTml };
}

const slugId = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'table';

// Build a Liveboard TML on top of a worksheet: a table viz of everything, plus
// one column-chart per measure broken down by the first attribute. TML shape is
// version-sensitive — validate against the target cluster's tml/export.
const MAX_CHART_VIZ = 6;

export function generateLiveboardTml(name: string, worksheetName: string, columns: Column[]): string {
  const attrs = columns.filter((c) => c.type === 'ATTRIBUTE');
  const measures = columns.filter((c) => c.type === 'MEASURE');
  const dim = attrs[0];

  const answerCols = (names: string[]): string[] => ['      answer_columns:', ...names.map((n) => `      - name: "${q(n)}"`)];

  const viz = (id: string, title: string, query: string, colNames: string[], chart?: string): string[] => {
    const block = [
      `  - id: ${id}`,
      '    answer:',
      `      name: "${q(title)}"`,
      '      tables:',
      `      - id: "${q(worksheetName)}"`,
      `        name: "${q(worksheetName)}"`,
      `      search_query: "${q(query)}"`,
      ...answerCols(colNames),
    ];
    if (chart) {
      block.push('      display_mode: CHART_MODE', '      chart:', `        type: ${chart}`);
    } else {
      block.push('      display_mode: TABLE_MODE');
    }
    return block;
  };

  const vizzes: string[][] = [];
  const allNames = columns.map((c) => c.name);
  vizzes.push(viz('Viz_1', `${name} — all data`, allNames.map((n) => `[${n}]`).join(' '), allNames));

  if (dim) {
    for (const m of measures.slice(0, MAX_CHART_VIZ)) {
      vizzes.push(
        viz(`Viz_${vizzes.length + 1}`, `${m.name} by ${dim.name}`, `[${dim.name}] [${m.name}]`, [dim.name, m.name], 'COLUMN')
      );
    }
  }

  const tiles = vizzes.map((_, i) => [`    - visualization_id: Viz_${i + 1}`, '      size: MEDIUM']).flat();

  return [
    'liveboard:',
    `  name: "${q(name)}"`,
    '  visualizations:',
    ...vizzes.flat(),
    '  layout:',
    '    tiles:',
    ...tiles,
    '',
  ].join('\n');
}

/** One loaded source behind a liveboard tile: a worksheet plus its columns. */
export interface LiveboardSource {
  /** Title to show on the tile — the source visual's own name. */
  title: string;
  /** Worksheet the tile answers from. */
  worksheetName: string;
  columns: Column[];
  /** The source visual's own type, so the tile mirrors how it was drawn. */
  visualType?: string;
}

/**
 * How a source visual maps to a ThoughtSpot chart. A liveboard should look like
 * the report it came from, so the source's own visual type leads and the data's
 * shape only overrides it when the chart could not render — a chart needs a
 * measure, and every chart but KPI needs something to plot it against.
 *
 * Power BI's map visuals fall back to a bar chart on purpose: GEO_AREA needs
 * columns that ThoughtSpot has geo-mapped, and an uploaded VARCHAR is not.
 */
const CHART_BY_VISUAL: Record<string, string> = {
  card: 'KPI', kpi: 'KPI', multiRowCard: 'KPI', gauge: 'KPI',
  columnChart: 'COLUMN', clusteredColumnChart: 'COLUMN',
  stackedColumnChart: 'STACKED_COLUMN', hundredPercentStackedColumnChart: 'STACKED_COLUMN',
  barChart: 'BAR', clusteredBarChart: 'BAR',
  stackedBarChart: 'BAR', hundredPercentStackedBarChart: 'BAR',
  funnel: 'BAR', map: 'BAR', filledMap: 'BAR', shapeMap: 'BAR', azureMap: 'BAR',
  lineChart: 'LINE', areaChart: 'AREA', stackedAreaChart: 'AREA',
  lineClusteredColumnComboChart: 'LINE', lineStackedColumnComboChart: 'LINE',
  pieChart: 'PIE', donutChart: 'PIE',
  scatterChart: 'SCATTER',
  tableEx: 'TABLE', pivotTable: 'TABLE', matrix: 'TABLE', slicer: 'TABLE',
};

/** Wide categories read better lying down than squeezed onto an x-axis. */
const WIDE_CATEGORY_COUNT = 15;

function chartTypeFor(source: LiveboardSource, dims: Column[], measures: Column[]): string {
  if (!measures.length) return 'TABLE';
  if (!dims.length) return 'KPI';
  const mapped = source.visualType ? CHART_BY_VISUAL[source.visualType] : undefined;
  // A card keeps its single number. Power BI gives those visuals a placeholder
  // dimension ("Blank") that is not a real breakdown, so trusting the shape here
  // would draw one lonely bar against a {Null} axis.
  if (mapped) return mapped;
  // Unknown visual type: pick on shape.
  return dims.length > 1 ? 'TABLE' : 'COLUMN';
}

/**
 * Build a Liveboard TML spanning several worksheets — one tile per source, so a
 * report's liveboard mirrors the report: each visual becomes a visualization
 * answering from the worksheet loaded with that visual's own rows.
 *
 * A chart tile needs `chart_columns`, `axis_configs` and `display_mode:
 * CHART_MODE` together; with the chart type alone ThoughtSpot renders the
 * answer as a table. TML shape is version-sensitive — validate against the
 * target cluster's tml/export.
 */
export function generateLiveboardOverSources(name: string, sources: LiveboardSource[]): string {
  const vizzes: string[][] = [];
  /** Grid footprint per tile, in 12-column units. */
  const sizes: { width: number; height: number }[] = [];

  sources.forEach((source, index) => {
    const dims = source.columns.filter((c) => c.type === 'ATTRIBUTE');
    const measures = source.columns.filter((c) => c.type === 'MEASURE');
    let chart = chartTypeFor(source, dims, measures);

    // Keep a tile readable: one dimension and a few measures, not every column.
    const dim = dims[0];
    const charted = measures.slice(0, 3);
    const names = chart === 'TABLE'
      ? source.columns.map((c) => c.name)
      : chart === 'KPI'
        ? charted.map((m) => m.name)
        : [dim!.name, ...charted.map((m) => m.name)];

    const block = [
      `  - id: Viz_${index + 1}`,
      '    answer:',
      `      name: "${q(source.title)}"`,
      '      tables:',
      `      - id: "${q(source.worksheetName)}"`,
      `        name: "${q(source.worksheetName)}"`,
      `      search_query: "${q(names.map((n) => `[${n}]`).join(' '))}"`,
      '      answer_columns:',
      ...names.map((n) => `      - name: "${q(n)}"`),
    ];

    if (chart === 'TABLE') {
      block.push('      display_mode: TABLE_MODE');
      // A table needs room for its rows.
      sizes.push({ width: 6, height: 5 });
      vizzes.push(block);
      return;
    }

    block.push('      chart:', `        type: ${chart}`, '        chart_columns:');
    for (const m of charted) block.push(`        - column_id: "${q(m.name)}"`);
    // Every chart needs axis_configs, KPI included — with chart_columns alone
    // the import fails. A KPI has no category, so it carries only the y axis.
    if (chart === 'KPI') {
      block.push(
        '        axis_configs:',
        '        - "y":',
        ...charted.map((m) => `          - "${q(m.name)}"`),
      );
    } else {
      block.push(`        - column_id: "${q(dim!.name)}"`);
      block.push(
        '        axis_configs:',
        '        - x:',
        `          - "${q(dim!.name)}"`,
        '          "y":',
        ...charted.map((m) => `          - "${q(m.name)}"`),
      );
    }
    block.push('      display_mode: CHART_MODE');
    // A KPI is one number — four fit on a row; charts sit two across.
    sizes.push(chart === 'KPI' ? { width: 3, height: 3 } : { width: 6, height: 5 });
    vizzes.push(block);
  });

  // A liveboard lays out on a 12-column grid. Sizing every tile the same makes
  // a single KPI number occupy as much room as a chart, so each tile takes the
  // footprint its content needs and rows are packed left to right.
  const GRID_COLUMNS = 12;
  const tiles: string[] = [];
  let cursorX = 0;
  let rowY = 0;
  let rowHeight = 0;
  vizzes.forEach((_, i) => {
    const { width, height } = sizes[i]!;
    if (cursorX + width > GRID_COLUMNS) {
      rowY += rowHeight;
      cursorX = 0;
      rowHeight = 0;
    }
    tiles.push(
      `    - visualization_id: Viz_${i + 1}`,
      `      x: ${cursorX}`,
      `      "y": ${rowY}`,
      `      width: ${width}`,
      `      height: ${height}`,
    );
    cursorX += width;
    rowHeight = Math.max(rowHeight, height);
  });

  return [
    'liveboard:',
    `  name: "${q(name)}"`,
    '  visualizations:',
    ...vizzes.flat(),
    '  layout:',
    '    tiles:',
    ...tiles,
    '',
  ].join('\n');
}

// Falcon numeric types default to measures; everything else to attributes.
const MEASURE_TYPES = new Set(['INT64', 'INT32', 'DOUBLE', 'FLOAT', 'DECIMAL']);
function columnTypeFor(dataType?: string): 'MEASURE' | 'ATTRIBUTE' {
  return dataType && MEASURE_TYPES.has(dataType.toUpperCase()) ? 'MEASURE' : 'ATTRIBUTE';
}

export interface UploadedColumn {
  logicalName?: string;
  physicalName?: string;
  name?: string;
  dataType?: string;
}

/**
 * Generate a worksheet TML that sits on top of an already-uploaded table.
 * A worksheet over an EXISTING table needs a `table_paths` alias, and the
 * worksheet columns reference that alias (`<ALIAS>::<COLUMN>`), not the table
 * name — matching a real `tml/export` of a worksheet.
 */
export function generateWorksheetOnTable(
  worksheetName: string,
  tableName: string,
  columns: UploadedColumn[],
): string {
  const alias = `${tableName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'T'}_1`;

  const cols = columns
    .map((c) => ({
      name: c.logicalName ?? c.name ?? '',
      dbName: c.physicalName ?? c.logicalName ?? c.name ?? '',
      dataType: c.dataType,
    }))
    .filter((c) => c.name);

  const wsCols = cols
    .map((c) => [
      `  - name: "${q(c.name)}"`,
      `    column_id: "${q(alias)}::${q(c.dbName)}"`,
      '    properties:',
      `      column_type: ${columnTypeFor(c.dataType)}`,
    ].join('\n'))
    .join('\n');

  return [
    'worksheet:',
    `  name: "${q(worksheetName)}"`,
    '  tables:',
    `  - name: "${q(tableName)}"`,
    '  table_paths:',
    `  - id: "${q(alias)}"`,
    `    table: "${q(tableName)}"`,
    '    join_path:',
    '    - {}',
    '  worksheet_columns:',
    wsCols,
    '',
  ].join('\n');
}

// ── Tabbed liveboard that mirrors the workbook's dashboards ──────────────────
// One Liveboard tab per dashboard, one visualization per worksheet, built on the
// single loaded worksheet model. Fields are resolved against that model's
// columns; a worksheet whose fields aren't in the model (calc/param-only) is
// skipped, and an otherwise-empty tab gets a summary table so it isn't blank.
// Chart types are limited to the set the cluster validated: COLUMN, BAR, LINE,
// AREA, SCATTER, PIE, and TABLE_MODE (KPI is rejected on import).

function chartFor(mark: string, dims: string[], measures: string[]): string {
  const m = (mark || '').toLowerCase();
  // A scatter is two measures against each other; keep it even with no dimension.
  if (m === 'circle' && measures.length >= 2) return 'SCATTER';
  if (measures.length && dims.length === 0) return 'TABLE_MODE';
  if (m === 'line') return 'LINE';
  if (m === 'area') return 'AREA';
  if (m === 'circle') return 'COLUMN';
  if (m === 'pie') return 'PIE';
  if (m === 'square' || m === 'map' || m.includes('polygon')) return 'TABLE_MODE';
  if (m === 'bar') return 'COLUMN';
  if (dims.length && measures.length) return 'COLUMN';
  return 'TABLE_MODE';
}

const MAX_TAB_VIZ = 12;
const MAX_FILTERS = 8;

export function generateTabbedLiveboardTml(
  name: string,
  worksheetName: string,
  structure: WorkbookStructure,
  columns: Column[],
): string {
  const byName = new Map(columns.map((c) => [c.name.toLowerCase(), c]));
  interface V { id: string; title: string; query: string; cols: string[]; chart: string }
  const vizzes: V[] = [];
  const tabs: { name: string; ids: string[] }[] = [];
  const filterFields: string[] = []; // dimensions the workbook filters on, in first-seen order
  let n = 0;

  const addViz = (title: string, cols: string[], chart: string): string => {
    const id = `Viz_${++n}`;
    vizzes.push({ id, title, query: cols.map((c) => `[${c}]`).join(' '), cols, chart });
    return id;
  };

  for (const dash of structure.dashboards) {
    const ids: string[] = [];
    for (const wsName of dash.worksheets.slice(0, MAX_TAB_VIZ)) {
      const ws = structure.worksheets[wsName];
      if (!ws) continue;
      const dims: string[] = [];
      const measures: string[] = [];
      for (const f of ws.fields) {
        const col = byName.get(f.toLowerCase());
        if (!col) continue;
        const bucket = col.type === 'MEASURE' ? measures : dims;
        if (!bucket.includes(col.name)) bucket.push(col.name);
      }
      const cols = [...dims, ...measures];
      if (!cols.length) continue; // nothing in this viz maps to the model
      ids.push(addViz(wsName, cols, chartFor(ws.mark, dims, measures)));
      // Carry over the worksheet's categorical filters (dimensions in the model).
      for (const f of ws.filters) {
        const col = byName.get(f.toLowerCase());
        if (col && col.type === 'ATTRIBUTE' && !filterFields.includes(col.name)) filterFields.push(col.name);
      }
    }
    // Skip a tab whose worksheets don't map to the loaded model — a fabricated
    // "— data" table just clutters the board and reads as "everything is a table".
    if (ids.length) tabs.push({ name: dash.name, ids });
  }

  // Nothing from the workbook resolved against this view's data — fall back to a
  // real single-tab board (a table plus a column chart per measure) rather than
  // an empty tabbed shell.
  if (!vizzes.length) return generateLiveboardTml(name, worksheetName, columns);

  const lines: string[] = ['liveboard:', `  name: "${q(name)}"`, '  visualizations:'];
  for (const v of vizzes) {
    lines.push(
      `  - id: ${v.id}`,
      '    answer:',
      `      name: "${q(v.title)}"`,
      '      tables:',
      `      - id: "${q(worksheetName)}"`, // id so liveboard filters can reference <table>::<col>
      `        name: "${q(worksheetName)}"`,
      `      search_query: "${q(v.query)}"`,
      '      answer_columns:',
      ...v.cols.map((c) => `      - name: "${q(c)}"`),
    );
    // A chart needs display_mode: CHART_MODE too — with only a chart type the
    // answer defaults to TABLE_MODE and renders as a table.
    if (v.chart === 'TABLE_MODE') lines.push('      display_mode: TABLE_MODE');
    else lines.push('      display_mode: CHART_MODE', '      chart:', `        type: ${v.chart}`);
  }
  lines.push('  tabs:');
  for (const t of tabs) {
    lines.push(`  - name: "${q(t.name)}"`, '    visualizations:', ...t.ids.map((id) => `    - ${id}`));
  }
  // The workbook's categorical filters, as liveboard filter chips (all values by
  // default). The column is referenced as <table-id>::<field>; the vizzes set
  // that table id above, so it resolves on import.
  if (filterFields.length) {
    lines.push('  filters:');
    for (const f of filterFields.slice(0, MAX_FILTERS)) {
      lines.push(
        '  - column:',
        `    - "${q(worksheetName)}::${q(f)}"`,
        '    is_mandatory: false',
        '    is_single_value: false',
        "    display_name: ''",
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
