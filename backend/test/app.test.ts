import { describe, expect, test, afterEach } from 'bun:test';
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

describe('POST /dataset/check', () => {
  test('503 when the cluster is not configured', async () => {
    const res = await makeApp().request('/dataset/check', {
      method: 'POST', headers: JSON_HEADERS,
      body: JSON.stringify({ userid: 'u', platform: 'tableau', name: 'Sales' }),
    });
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe('not_configured');
  });

  test('400 when userid/platform are missing (validated before any lookup)', async () => {
    const app = makeApp({ tsHost: 'https://ts.example', tsToken: 'admin-token' });
    const res = await app.request('/dataset/check', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Sales' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_request');
  });

  test('still requires the API key', async () => {
    const res = await makeApp().request('/dataset/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
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

describe('POST /liveboard', () => {
  const TWB =
    "<workbook><datasource caption='Sales DS'>" +
    "<column name='[Sales]' caption='Sales' role='measure' datatype='real'/>" +
    "<column name='[Profit]' caption='Profit' role='measure' datatype='real'/>" +
    "<column name='[Region]' caption='Region' role='dimension' datatype='string'/>" +
    '</datasource></workbook>';
  const b64 = Buffer.from(TWB).toString('base64');
  const lb = (app: ReturnType<typeof createApp>, body: unknown, query = '') =>
    app.request('/liveboard' + query, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

  test('returns table, worksheet and liveboard TML without a cluster', async () => {
    const res = await lb(makeApp(), { filename: 'Sales.twb', fileBase64: b64 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { imported: boolean; tml: { liveboardTml: string; worksheetTml: string } };
    expect(body.imported).toBe(false);
    expect(body.tml.liveboardTml).toContain('liveboard:');
    // one table viz + one chart per measure (2)
    expect(body.tml.liveboardTml.match(/- id: Viz_/g)?.length).toBe(3);
    expect(body.tml.liveboardTml).toContain('[Region] [Sales]');
    expect(body.tml.liveboardTml).toContain('type: COLUMN');
  });

  test('format=text returns the three docs joined', async () => {
    const res = await lb(makeApp(), { fileBase64: b64 }, '?format=text');
    expect(res.headers.get('content-type')).toContain('text/yaml');
    const text = await res.text();
    expect(text.match(/---/g)?.length).toBe(2);
  });

  test('400 without a file', async () => {
    expect((await lb(makeApp(), {})).status).toBe(400);
  });
});

describe('/liveboard build-once reuse', () => {
  const TS = { tsHost: 'https://ts.example', tsToken: 'tok' };
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('reuses an existing liveboard by name with no file, no rebuild', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('/metadata/search')) {
        return new Response(JSON.stringify([{ metadata_name: 'Superstore', metadata_id: 'LB-1' }]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const app = makeApp(TS);
    const res = await app.request('/liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Superstore' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reused: boolean; liveboardId: string; liveboardUrl: string };
    expect(body.reused).toBe(true);
    expect(body.liveboardId).toBe('LB-1');
    expect(body.liveboardUrl).toContain('/#/pinboard/LB-1');
    expect(calls.some((u) => u.includes('/metadata/import'))).toBe(false); // never built
  });

  test('404 not_built when it does not exist yet and no file is sent', async () => {
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(String(url).includes('/metadata/search') ? [] : {}), { status: 200 })) as typeof fetch;
    const app = makeApp(TS);
    const res = await app.request('/liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: 'Nope' }) });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe('not_built');
  });
});

describe('POST /create-liveboard (staged, platform-generic)', () => {
  const TWB =
    "<workbook><datasource caption='DS'>" +
    "<column name='[Sales]' caption='Sales' role='measure' datatype='real'/>" +
    "<column name='[Region]' caption='Region' role='dimension' datatype='string'/>" +
    '</datasource></workbook>';
  const twbB64 = Buffer.from(TWB).toString('base64');
  const TMDL = "table Sales\n\tcolumn Region\n\t\tdataType: string\n\tcolumn Amount\n\t\tdataType: double\n\tmeasure 'Total' = SUM(Sales[Amount])\n";
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request('/create-liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

  test('rejects an unknown platform', async () => {
    const res = await post(makeApp(), { platform: 'qlik', name: 'X', fileBase64: twbB64 });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('unsupported_platform');
  });

  test('tableau twb: parse+generate stages ok without a cluster', async () => {
    const res = await post(makeApp(), { platform: 'tableau', name: 'Superstore', fileBase64: twbB64 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reused: boolean; stages: { stage: string; status: string }[]; tml: { liveboardTml: string } };
    expect(body.reused).toBe(false);
    const byStage = Object.fromEntries(body.stages.map((s) => [s.stage, s.status]));
    expect(byStage).toMatchObject({ lookup: 'skipped', parse: 'ok', generate: 'ok', import: 'skipped' });
    expect(body.tml.liveboardTml).toContain('liveboard:');
  });

  test('powerbi tmdl: parses columns and measures from the model', async () => {
    const res = await post(makeApp(), { platform: 'powerbi', name: 'Sales Model', model: TMDL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: { name: string; type: string }[] };
    const names = body.columns.map((c) => c.name).sort();
    expect(names).toEqual(['Amount', 'Region', 'Total']);
    expect(body.columns.find((c) => c.name === 'Total')!.type).toBe('MEASURE');
    expect(body.columns.find((c) => c.name === 'Region')!.type).toBe('ATTRIBUTE');
  });

  test('reuse short-circuits with every later stage skipped', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/metadata/search')) {
        return new Response(JSON.stringify([{ metadata_name: 'Superstore', metadata_id: 'LB-9' }]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const res = await post(makeApp({ tsHost: 'https://ts.example', tsToken: 't' }), { platform: 'tableau', name: 'Superstore' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reused: boolean; liveboardId: string; stages: { stage: string; status: string }[] };
    expect(body.reused).toBe(true);
    expect(body.liveboardId).toBe('LB-9');
    expect(body.stages.filter((s) => s.status === 'skipped').map((s) => s.stage)).toEqual(['parse', 'generate', 'import', 'locate']);
  });
});

describe('POST /get-liveboard', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('503 when no cluster is configured', async () => {
    const res = await makeApp().request('/get-liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ platform: 'tableau', guid: 'g1' }) });
    expect(res.status).toBe(503);
  });

  test('400 without platform+guid', async () => {
    const res = await makeApp({ tsHost: 'https://ts.example', tsToken: 't' }).request('/get-liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ platform: 'tableau' }) });
    expect(res.status).toBe(400);
  });

  test('returns the liveboard id when it exists, keyed on platform+guid', async () => {
    let searchedName = '';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes('/metadata/search')) {
        searchedName = JSON.parse(String(init?.body)).metadata[0].name_pattern;
        return new Response(JSON.stringify([{ metadata_name: searchedName, metadata_id: 'LB-7' }]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const res = await makeApp({ tsHost: 'https://ts.example', tsToken: 't' }).request('/get-liveboard', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ platform: 'tableau', guid: '82f7-luid' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean; liveboardId: string; name: string };
    expect(body.exists).toBe(true);
    expect(body.liveboardId).toBe('LB-7');
    expect(body.name).toBe('Spotter · tableau · 82f7-luid');
    expect(searchedName).toBe('Spotter · tableau · 82f7-luid');
  });

  test('exists:false when not found', async () => {
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify(String(url).includes('/metadata/search') ? [] : {}), { status: 200 })) as typeof fetch;
    const res = await makeApp({ tsHost: 'https://ts.example', tsToken: 't' }).request('/get-liveboard', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ platform: 'tableau', guid: 'x' }),
    });
    const body = (await res.json()) as { exists: boolean; liveboardId?: string };
    expect(body.exists).toBe(false);
    expect(body.liveboardId).toBeUndefined();
  });
});

describe('admin token from the trusted-auth secret key (no static TS_TOKEN)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('mints an admin token as tsadmin via secret_key, then does admin calls with it', async () => {
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: String(url), body });
      if (String(url).includes('/auth/token/full')) return new Response(JSON.stringify({ token: 'ADMIN-TOK' }), { status: 200 });
      if (String(url).includes('/metadata/search')) return new Response(JSON.stringify([]), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const app = createApp({ apiKey: KEY, tsHost: 'https://ts.example', tsSecretKey: 'SEKRIT' });
    const res = await app.request('/get-liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ platform: 'tableau', guid: 'g1' }) });
    expect(res.status).toBe(200);
    const mint = calls.find((c) => c.url.includes('/auth/token/full'));
    expect(mint).toBeTruthy();
    expect((mint!.body as { username: string }).username).toBe('tsadmin');
    expect((mint!.body as { secret_key: string }).secret_key).toBe('SEKRIT');
  });

  test('lookup endpoints are available with only a secret key (no tsToken)', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/auth/token/full')) return new Response(JSON.stringify({ token: 'T' }), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    const app = createApp({ apiKey: KEY, tsHost: 'https://ts.example', tsSecretKey: 'S' });
    const res = await app.request('/get-liveboard', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ platform: 'tableau', guid: 'g' }) });
    expect(res.status).not.toBe(503);
  });
});
