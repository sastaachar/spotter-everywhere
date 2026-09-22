import { expect, test } from 'bun:test';
import { generateLiveboardOverSources } from '../src/tml';
const col = (name: string, type: 'ATTRIBUTE'|'MEASURE', dataType: any = 'VARCHAR') => ({ id: name, name, type, dataType });
const chartOf = (tml: string) => [...tml.matchAll(/type: ([A-Z_]+)/g)].map((m) => m[1]);

test('unknown visual type: date axis draws a trend', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('Month','ATTRIBUTE','DATE'), col('Rev','MEASURE','DOUBLE')], visualType: 'someCustomVisual' }]);
  expect(chartOf(t)).toEqual(['LINE']);
});
test('unknown visual type: two breakdowns draw a pivot', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('A','ATTRIBUTE'), col('B','ATTRIBUTE'), col('Rev','MEASURE','DOUBLE')], visualType: 'zz' }]);
  expect(chartOf(t)).toEqual(['PIVOT_TABLE']);
});
test('unknown visual type: a long category list lies down', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('A','ATTRIBUTE'), col('Rev','MEASURE','DOUBLE')], visualType: 'zz', rowCount: 40 }]);
  expect(chartOf(t)).toEqual(['BAR']);
});
test('unknown visual type: a short category list stands up', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('A','ATTRIBUTE'), col('Rev','MEASURE','DOUBLE')], visualType: 'zz', rowCount: 5 }]);
  expect(chartOf(t)).toEqual(['COLUMN']);
});
test('power bi ids: stacked is the plain id, clustered carries the word', () => {
  const cols = [col('A','ATTRIBUTE'), col('Rev','MEASURE','DOUBLE')];
  const one = (visualType: string) => chartOf(generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w', columns: cols, visualType }]))[0];
  expect(one('barChart')).toBe('STACKED_BAR');
  expect(one('clusteredBarChart')).toBe('BAR');
  expect(one('columnChart')).toBe('STACKED_COLUMN');
  expect(one('clusteredColumnChart')).toBe('COLUMN');
  expect(one('pivotTable')).toBe('PIVOT_TABLE');
  expect(one('ribbonChart')).toBe('STACKED_COLUMN');
  expect(one('lineStackedColumnComboChart')).toBe('LINE_STACKED_COLUMN');
});
test('a scatter that binds a size role is a bubble', () => {
  const cols = [col('A','ATTRIBUTE'), col('X','MEASURE','DOUBLE'), col('Y','MEASURE','DOUBLE')];
  const one = (roles?: string[]) => chartOf(generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w', columns: cols, visualType: 'scatterChart', roles }]))[0];
  expect(one()).toBe('SCATTER');
  expect(one(['X','Y','Size'])).toBe('BUBBLE');
});

// A period column arrives all-digits — "YEAR MONTH" as 202111 — so the loader
// types it as a measure and the visual is left with no axis at all.
test('a category chart keeps its axis when the axis column looks numeric', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('YEAR MONTH','MEASURE','DOUBLE'), col('Revenue','MEASURE','DOUBLE')], visualType: 'lineChart' }]);
  expect(chartOf(t)).toEqual(['LINE']);
  expect(t).toContain('- x:\n          - "YEAR MONTH"');
});
test('a real attribute is never overridden', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('Region','ATTRIBUTE'), col('Revenue','MEASURE','DOUBLE')], visualType: 'lineChart' }]);
  expect(t).toContain('- x:\n          - "Region"');
});
test('a grid of all-numeric columns stays a grid, not a single number', () => {
  const cols = [col('YEAR MONTH','MEASURE','DOUBLE'), col('Revenue','MEASURE','DOUBLE')];
  expect(generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w', columns: cols, visualType: 'tableEx' }]))
    .toContain('display_mode: TABLE_MODE');
});
test('a card with one measure is still a KPI', () => {
  const t = generateLiveboardOverSources('lb', [{ title: 'x', worksheetName: 'w',
    columns: [col('Revenue','MEASURE','DOUBLE')], visualType: 'kpi' }]);
  expect(chartOf(t)).toEqual(['KPI']);
});
