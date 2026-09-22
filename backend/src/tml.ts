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
  /** The data roles the source visual binds (Category, Y, Size…). Distinguishes
   *  visuals that share one type but draw differently — a scatter with a Size
   *  role is a bubble chart. */
  roles?: string[];
  /** Rows behind the tile, so a long category list can be laid out sideways. */
  rowCount?: number;
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
// Power BI's own visualType vocabulary, read off a live report's exploration
// document — not the labels its UI shows. Two traps live here: `barChart` and
// `columnChart` are Power BI's ids for the STACKED variants (the clustered ones
// carry `clustered` in the id), and a matrix is `pivotTable`, never `matrix`.
// Targets are the chart types this cluster accepts on TML import; DONUT, RADAR,
// GAUGE, HISTOGRAM, BOXPLOT and RIBBON are rejected, so each falls back to its
// nearest accepted neighbour rather than failing the import.
const CHART_BY_VISUAL: Record<string, string> = {
  // Single value
  card: 'KPI', kpi: 'KPI', multiRowCard: 'KPI', gauge: 'KPI',
  // Columns (vertical). Power BI: plain id = stacked, `clustered` = side by side.
  columnChart: 'STACKED_COLUMN', clusteredColumnChart: 'COLUMN',
  hundredPercentStackedColumnChart: 'STACKED_COLUMN',
  // Bars (horizontal), same naming rule.
  barChart: 'STACKED_BAR', clusteredBarChart: 'BAR',
  hundredPercentStackedBarChart: 'STACKED_BAR',
  // Lines and areas
  lineChart: 'LINE', areaChart: 'AREA', stackedAreaChart: 'STACKED_AREA',
  hundredPercentStackedAreaChart: 'STACKED_AREA',
  // Combos keep both halves: a line over columns, not just the line.
  lineClusteredColumnComboChart: 'LINE_COLUMN',
  lineStackedColumnComboChart: 'LINE_STACKED_COLUMN',
  // Parts of a whole. DONUT is rejected on import, so a donut draws as a pie.
  pieChart: 'PIE', donutChart: 'PIE', treemap: 'TREEMAP', funnel: 'FUNNEL',
  waterfallChart: 'WATERFALL',
  // A ribbon is a stacked column whose bands re-rank across the category axis.
  // RIBBON is rejected on import, so the stacked column it is built on stands in.
  ribbonChart: 'STACKED_COLUMN',
  // XY. Promoted to BUBBLE when the visual binds a Size role — see chartTypeFor.
  scatterChart: 'SCATTER',
  // Geography. ThoughtSpot only plots a map from a column it has geo-configured
  // (US State, ZIP, country…), and a column that arrived through the CSV upload
  // has no such config — geo_config is silently dropped on import, so the tile
  // renders empty. A bar of the same geography against the same measure is the
  // closest thing that actually draws. Revisit when the pipeline can set a
  // column's geo type.
  map: 'BAR', filledMap: 'BAR', shapeMap: 'BAR', azureMap: 'BAR', esriVisual: 'BAR',
  // Grids. A Power BI matrix is a pivot, and ThoughtSpot has a real pivot for it.
  tableEx: 'TABLE', pivotTable: 'PIVOT_TABLE', matrix: 'PIVOT_TABLE',
};

/** Pivots put every dimension on the axis, not just the first. */
const PIVOT_CHARTS = new Set(['PIVOT_TABLE']);

/** Charts that plot a geography rather than a category axis. */
const GEO_CHARTS = new Set(['GEO_AREA', 'GEO_BUBBLE']);

/** Wide categories read better lying down than squeezed onto an x-axis. */
const WIDE_CATEGORY_COUNT = 15;

/** The chart the source visual was drawn as, before the data is considered. */
function mappedChart(source: LiveboardSource): string | undefined {
  const mapped = source.visualType ? CHART_BY_VISUAL[source.visualType] : undefined;
  // A Power BI scatter with a Size role is drawn as a bubble chart; the
  // visualType is `scatterChart` either way, so only the roles tell them apart.
  if (mapped === 'SCATTER' && (source.roles || []).includes('Size')) return 'BUBBLE';
  return mapped;
}

/** Charts that plot values against a category, so they are useless without one. */
const CATEGORY_CHARTS = new Set([
  'COLUMN', 'BAR', 'STACKED_COLUMN', 'STACKED_BAR', 'LINE', 'AREA', 'STACKED_AREA',
  'PIE', 'FUNNEL', 'TREEMAP', 'WATERFALL', 'HEATMAP', 'SANKEY', 'PARETO',
  'SPIDER_WEB', 'LINE_COLUMN', 'LINE_STACKED_COLUMN', 'PIVOT_TABLE',
]);

/**
 * Columns as they should be charted. Types are inferred from the loaded values,
 * and a period column is all digits — "YEAR MONTH" arrives as 202111, a date as
 * an epoch — so it lands as a measure and the visual loses its axis: a line
 * chart of revenue over time came out as a lone KPI. The source visual knows
 * better. When it is one that plots against a category, its first column is that
 * category whatever the values happen to look like.
 */
function chartedColumns(source: LiveboardSource, chart: string | undefined): Column[] {
  if (!chart || !CATEGORY_CHARTS.has(chart)) return source.columns;
  if (source.columns.some((c) => c.type === 'ATTRIBUTE')) return source.columns;
  if (source.columns.length < 2) return source.columns;
  return source.columns.map((c, i) => (i === 0 ? { ...c, type: 'ATTRIBUTE' as const } : c));
}

function chartTypeFor(source: LiveboardSource, dims: Column[], measures: Column[]): string {
  const mapped = mappedChart(source);
  if (!measures.length) return 'TABLE';
  // A card keeps its single number. Power BI gives those visuals a placeholder
  // dimension ("Blank") that is not a real breakdown, so trusting the shape here
  // would draw one lonely bar against a {Null} axis. A grid is the exception: a
  // table of all-numeric columns has no dimension either, and it is still a
  // table, not a single number.
  if (!dims.length) return mapped === 'TABLE' || mapped === 'PIVOT_TABLE' ? mapped : 'KPI';
  if (mapped) return mapped;

  // No mapping — a custom or third-party visual. Choose the chart that carries
  // this shape of data best rather than defaulting everything to a column.
  // A date axis is a trend, so it draws as a line.
  if (dims.length === 1 && dims[0]!.dataType === 'DATE') return 'LINE';
  // More than one breakdown is what a pivot exists for; a flat table buries it.
  if (dims.length > 1) return 'PIVOT_TABLE';
  // Long category lists need their labels lying down — squeezed onto an x-axis
  // they overlap into noise.
  if (source.rowCount && source.rowCount > WIDE_CATEGORY_COUNT) return 'BAR';
  return 'COLUMN';
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
    const columns = chartedColumns(source, mappedChart(source));
    const dims = columns.filter((c) => c.type === 'ATTRIBUTE');
    const measures = columns.filter((c) => c.type === 'MEASURE');
    let chart = chartTypeFor({ ...source, columns }, dims, measures);

    // Keep a tile readable: one dimension and a few measures, not every column.
    // A pivot is the exception — its whole point is nesting several dimensions.
    const axisDims = PIVOT_CHARTS.has(chart) ? dims.slice(0, 3) : dims.slice(0, 1);
    const charted = measures.slice(0, 3);
    const names = chart === 'TABLE'
      ? columns.map((c) => c.name)
      : chart === 'KPI'
        ? charted.map((m) => m.name)
        : [...axisDims.map((d) => d.name), ...charted.map((m) => m.name)];

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
      for (const d of axisDims) block.push(`        - column_id: "${q(d.name)}"`);
      block.push(
        '        axis_configs:',
        '        - x:',
        ...axisDims.map((d) => `          - "${q(d.name)}"`),
        '          "y":',
        ...charted.map((m) => `          - "${q(m.name)}"`),
      );
    }
    block.push('      display_mode: CHART_MODE');
    // Footprint follows the content: a single number needs a small card, a
    // category chart needs width for its labels, and a long category list needs
    // height rather than a squeezed axis.
    sizes.push(
      chart === 'KPI' ? { width: 3, height: 2 }
        : PIVOT_CHARTS.has(chart) ? { width: 6, height: 5 }
          : charted.length > 1 ? { width: 6, height: 5 }
            : { width: 4, height: 4 },
    );
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
// Chart types are the set the cluster validated: KPI, COLUMN, BAR, STACKED_*,
// LINE, AREA, SCATTER, PIE, FUNNEL, TREEMAP, WATERFALL, HEATMAP, GEO_AREA,
// GEO_BUBBLE and TABLE_MODE.

function chartFor(mark: string, dims: string[], measures: string[]): string {
  const m = (mark || '').toLowerCase();
  // A scatter is two measures against each other; keep it even with no dimension.
  if (m === 'circle' && measures.length >= 2) return 'SCATTER';
  // A single number with nothing to break it down by is a KPI. It used to fall
  // back to a table because KPI was thought to be rejected on import — it is
  // not, it just needs axis_configs like every other chart.
  if (measures.length && dims.length === 0) return 'KPI';
  if (m === 'line') return 'LINE';
  if (m === 'area') return 'AREA';
  if (m === 'circle') return 'COLUMN';
  if (m === 'pie') return 'PIE';
  // Tableau's filled maps and point maps would map to GEO_AREA / GEO_BUBBLE,
  // but the uploaded column carries no geo config so those render empty — see
  // the note on CHART_BY_VISUAL. Bars of the same geography do draw.
  if (m.includes('polygon') || m === 'map') return 'BAR';
  if (m === 'square') return 'HEATMAP';
  if (m === 'gantt') return 'BAR';
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
  interface V { id: string; title: string; query: string; cols: string[]; chart: string; measures: string[] }
  const vizzes: V[] = [];
  const tabs: { name: string; ids: string[] }[] = [];
  const filterFields: string[] = []; // dimensions the workbook filters on, in first-seen order
  let n = 0;

  const addViz = (title: string, cols: string[], chart: string, measures: string[] = []): string => {
    const id = `Viz_${++n}`;
    vizzes.push({ id, title, query: cols.map((c) => `[${c}]`).join(' '), cols, chart, measures });
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
      ids.push(addViz(wsName, cols, chartFor(ws.mark, dims, measures), measures));
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
    // A chart needs chart_columns and axis_configs as well as display_mode:
    // CHART_MODE. Given the type alone the answer renders as a table, and KPI
    // fails the import outright with a bare "Index: 0".
    if (v.chart === 'TABLE_MODE') {
      lines.push('      display_mode: TABLE_MODE');
    } else {
      // Columns arrive measures-last from addViz, so the category is the first
      // non-measure; a KPI has none.
      const measures = v.cols.filter((c) => v.measures.includes(c));
      const dim = v.cols.find((c) => !v.measures.includes(c));
      lines.push('      chart:', `        type: ${v.chart}`, '        chart_columns:');
      for (const m of measures) lines.push(`        - column_id: "${q(m)}"`);
      if (dim) lines.push(`        - column_id: "${q(dim)}"`);
      lines.push('        axis_configs:');
      if (dim) lines.push('        - x:', `          - "${q(dim)}"`, '          "y":');
      else lines.push('        - "y":');
      for (const m of measures) lines.push(`          - "${q(m)}"`);
      lines.push('      display_mode: CHART_MODE');
    }
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
