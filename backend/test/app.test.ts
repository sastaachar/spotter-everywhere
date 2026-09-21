import { describe, expect, test } from 'bun:test';
import { createApp } from '../src/app';
import { keysMatch } from '../src/auth';
import { rateLimit } from '../src/rate-limit';
import { Hono } from 'hono';
import { MAX_ROWS, SessionStore, parseSessionInput } from '../src/session';

const KEY = 'test-key-0123456789';
const AUTH = { Authorization: `Bearer ${KEY}` };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };

const tableauPayload = {
  platform: 'tableau',
  context: {
    site: 'acme',
    workbook: 'Superstore',
    dashboard: 'Overview',
    worksheet: 'Total Sales',
    zoneId: 32,
    isDashboard: true,
    sessionId: null,
  },
  data: {
    columns: [{ name: 'Measure Names', type: 'string' }, { name: 'Measure Values', type: 'float' }],
    rows: [['Quantity', '38,654.00'], ['Profit Ratio', '12.5%']],
    totalRows: 2,
  },
};

interface ResponseBody {
  id: string;
  platform: string;
  context: Record<string, unknown>;
  data?: { columns: unknown; rowCount?: number; totalRows?: number; rows?: unknown };
  rows?: unknown;
  error?: string;
  detail?: string;
}

function makeApp(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ apiKey: KEY, ...overrides });
}

async function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = JSON_HEADERS) {
  return app.request('/session', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const json = (res: Response) => res.json() as Promise<ResponseBody>;

describe('auth', () => {
  test('rejects a missing bearer token', async () => {
    const res = await makeApp().request('/session/whatever');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  test('rejects a wrong token', async () => {
    const res = await makeApp().request('/session/whatever', { headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  test('keysMatch is length-safe', () => {
    expect(keysMatch('abc', 'abc')).toBe(true);
    expect(keysMatch('abc', 'abcd')).toBe(false);
    expect(keysMatch('', 'x')).toBe(false);
  });

  test('refuses to build without a key', () => {
    expect(() => createApp({ apiKey: '' })).toThrow();
  });
});

describe('POST /session', () => {
  test('creates a session from a Tableau payload and returns a summary', async () => {
    const app = makeApp();
    const res = await post(app, tableauPayload);
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.platform).toBe('tableau');
    expect(body.context.worksheet).toBe('Total Sales');
    expect(body.data).toEqual({ columns: tableauPayload.data.columns, rowCount: 2, totalRows: 2 });
    expect(body.rows).toBeUndefined();
    expect(res.headers.get('location')).toBe(`/session/${body.id}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('accepts another platform with no data', async () => {
    const res = await post(makeApp(), { platform: 'powerbi', context: { report: 'Sales', page: 'Overview' } });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.platform).toBe('powerbi');
    expect(body.data).toBeUndefined();
  });

  test('rejects invalid JSON', async () => {
    const res = await post(makeApp(), '{not json');
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_json');
  });

  test('rejects a bad platform identifier', async () => {
    const res = await post(makeApp(), { platform: 'Tableau Cloud!', context: {} });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_request');
  });

  test('rejects rows that do not match the column count', async () => {
    const res = await post(makeApp(), { platform: 'tableau', context: {}, data: { columns: [{ name: 'a' }], rows: [[1, 2]] } });
    expect(res.status).toBe(400);
    expect((await json(res)).detail).toContain('data.rows[0]');
  });

  test('rejects nested context values', async () => {
    const res = await post(makeApp(), { platform: 'tableau', context: { nested: { a: 1 } } });
    expect(res.status).toBe(400);
  });

  test('rejects oversized bodies', async () => {
    const res = await post(makeApp({ maxBodyBytes: 64 }), tableauPayload);
    expect(res.status).toBe(413);
  });
});

describe('GET and DELETE /session/:id', () => {
  test('round-trips the full session including rows', async () => {
    const app = makeApp();
    const { id } = await json(await post(app, tableauPayload));
    const res = await app.request(`/session/${id}`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data?.rows).toEqual(tableauPayload.data.rows);
    expect(body.context.zoneId).toBe(32);
  });

  test('404s for unknown or malformed ids', async () => {
    const app = makeApp();
    expect((await app.request('/session/not-a-uuid', { headers: AUTH })).status).toBe(404);
    expect((await app.request('/session/00000000-0000-4000-8000-000000000000', { headers: AUTH })).status).toBe(404);
    expect((await app.request('/nowhere', { headers: AUTH })).status).toBe(404);
  });

  test('deletes a session', async () => {
    const app = makeApp();
    const { id } = await json(await post(app, tableauPayload));
    expect((await app.request(`/session/${id}`, { method: 'DELETE', headers: AUTH })).status).toBe(204);
    expect((await app.request(`/session/${id}`, { method: 'DELETE', headers: AUTH })).status).toBe(404);
    expect((await app.request(`/session/${id}`, { headers: AUTH })).status).toBe(404);
  });

  test('expires sessions after the TTL', async () => {
    let clock = 1_000_000;
    const store = new SessionStore(1000, 10, () => clock);
    const app = makeApp({ store, now: () => clock });
    const { id } = await json(await post(app, tableauPayload));
    expect((await app.request(`/session/${id}`, { headers: AUTH })).status).toBe(200);
    clock += 1001;
    expect((await app.request(`/session/${id}`, { headers: AUTH })).status).toBe(404);
  });
});

describe('SessionStore', () => {
  test('evicts the oldest session at capacity', () => {
    const store = new SessionStore(60_000, 2);
    const a = store.create(parseSessionInput({ platform: 'tableau', context: {} }));
    store.create(parseSessionInput({ platform: 'tableau', context: {} }));
    store.create(parseSessionInput({ platform: 'tableau', context: {} }));
    expect(store.size).toBe(2);
    expect(store.get(a.id)).toBeUndefined();
  });

  test('parseSessionInput enforces the row cap and totalRows shape', () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => [1]);
    expect(() => parseSessionInput({ platform: 'tableau', context: {}, data: { columns: [{ name: 'a' }], rows } })).toThrow('rows');
    expect(() => parseSessionInput({ platform: 'tableau', context: {}, data: { columns: [{ name: 'a' }], rows: [[1]], totalRows: -1 } })).toThrow('totalRows');
    expect(() => parseSessionInput({ platform: 'tableau', context: {}, data: { columns: [], rows: [] } })).toThrow('columns');
    expect(() => parseSessionInput({ platform: 'tableau', context: {}, data: { columns: [{ name: 'a', type: 'x'.repeat(65) }], rows: [] } })).toThrow('type');
    expect(() => parseSessionInput('nope')).toThrow('object');
  });
});

describe('rate limit', () => {
  test('returns 429 once the window is exhausted and resets after it', async () => {
    let clock = 0;
    const app = new Hono();
    app.use(rateLimit({ windowMs: 1000, max: 2, now: () => clock }));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
    const limited = await app.request('/');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    clock = 1000;
    expect((await app.request('/')).status).toBe(200);
  });

  test('keys by forwarded client address', async () => {
    const app = new Hono();
    app.use(rateLimit({ windowMs: 1000, max: 1 }));
    app.get('/', (c) => c.text('ok'));
    expect((await app.request('/', { headers: { 'x-forwarded-for': '10.0.0.1, proxy' } })).status).toBe(200);
    expect((await app.request('/', { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(429);
    expect((await app.request('/', { headers: { 'x-real-ip': '10.0.0.2' } })).status).toBe(200);
  });
});

describe('POST /twb-to-tml', () => {
  const TWB =
    "<workbook><datasource caption='Sales DS'>" +
    "<column name='[Sales]' caption='Sales' role='measure' datatype='real'/>" +
    "<column name='[Region]' caption='Region' role='dimension' datatype='string'/>" +
    "<column name='[:Measure Names]' role='dimension' datatype='string'/>" +
    '</datasource></workbook>';
  const b64 = Buffer.from(TWB).toString('base64');

  function tml(app: ReturnType<typeof createApp>, body: unknown, query = '') {
    return app.request('/twb-to-tml' + query, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  }

  test('returns table + worksheet TML for a workbook, no cluster needed', async () => {
    const res = await tml(makeApp(), { filename: 'Superstore.twb', fileBase64: b64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; columns: { name: string }[]; tml: { tableTml: string; worksheetTml: string } };
    expect(body.name).toBe('Superstore');
    expect(body.columns.map((c) => c.name).sort()).toEqual(['Region', 'Sales']);
    expect(body.tml.worksheetTml).toContain('worksheet');
    expect(body.tml.tableTml.length).toBeGreaterThan(0);
  });

  test('format=text returns concatenated YAML', async () => {
    const res = await tml(makeApp(), { fileBase64: b64 }, '?format=text');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/yaml');
    expect(await res.text()).toContain('---');
  });

  test('400 without a file, 422 for unparseable / empty workbook', async () => {
    expect((await tml(makeApp(), {})).status).toBe(400);
    const empty = Buffer.from('<workbook></workbook>').toString('base64');
    expect((await tml(makeApp(), { fileBase64: empty })).status).toBe(422);
  });

  test('still requires the API key', async () => {
    const res = await makeApp().request('/twb-to-tml', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
