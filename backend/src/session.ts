export type Primitive = string | number | boolean | null;

export interface Column {
  name: string;
  type?: string;
}

export interface SessionData {
  columns: Column[];
  rows: Primitive[][];
  totalRows?: number;
}

export interface SessionInput {
  platform: string;
  context: Record<string, Primitive>;
  data?: SessionData;
}

export interface Session extends SessionInput {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionSummary {
  id: string;
  platform: string;
  createdAt: string;
  expiresAt: string;
  context: Record<string, Primitive>;
  data?: { columns: Column[]; rowCount: number; totalRows?: number };
}

export const PLATFORM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_CONTEXT_KEYS = 100;
export const MAX_STRING_LENGTH = 4000;
export const MAX_COLUMNS = 500;
export const MAX_ROWS = 20_000;
export const SESSION_TTL_MS = 60 * 60 * 1000;
export const MAX_SESSIONS = 1000;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= MAX_STRING_LENGTH)
  );
}

function parseContext(value: unknown): Record<string, Primitive> {
  if (!isRecord(value)) throw new ValidationError('context must be an object');
  const keys = Object.keys(value);
  if (keys.length > MAX_CONTEXT_KEYS) throw new ValidationError(`context has more than ${MAX_CONTEXT_KEYS} keys`);
  const out: Record<string, Primitive> = {};
  for (const key of keys) {
    const v = value[key];
    if (!isPrimitive(v)) throw new ValidationError(`context.${key} must be a string, number, boolean or null`);
    out[key] = v;
  }
  return out;
}

function parseColumns(value: unknown): Column[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError('data.columns must be a non-empty array');
  if (value.length > MAX_COLUMNS) throw new ValidationError(`data.columns has more than ${MAX_COLUMNS} entries`);
  return value.map((col, i) => {
    if (!isRecord(col) || typeof col.name !== 'string' || col.name.length === 0 || col.name.length > MAX_STRING_LENGTH) {
      throw new ValidationError(`data.columns[${i}].name must be a non-empty string`);
    }
    if (col.type !== undefined && (typeof col.type !== 'string' || col.type.length > 64)) {
      throw new ValidationError(`data.columns[${i}].type must be a short string`);
    }
    return col.type === undefined ? { name: col.name } : { name: col.name, type: col.type };
  });
}

function parseRows(value: unknown, width: number): Primitive[][] {
  if (!Array.isArray(value)) throw new ValidationError('data.rows must be an array');
  if (value.length > MAX_ROWS) throw new ValidationError(`data.rows has more than ${MAX_ROWS} rows`);
  return value.map((row, i) => {
    if (!Array.isArray(row) || row.length !== width) {
      throw new ValidationError(`data.rows[${i}] must have ${width} cells`);
    }
    for (const cell of row) {
      if (!isPrimitive(cell)) throw new ValidationError(`data.rows[${i}] contains a non-primitive cell`);
    }
    return row as Primitive[];
  });
}

function parseData(value: unknown): SessionData {
  if (!isRecord(value)) throw new ValidationError('data must be an object');
  const columns = parseColumns(value.columns);
  const rows = parseRows(value.rows, columns.length);
  const data: SessionData = { columns, rows };
  if (value.totalRows !== undefined) {
    if (typeof value.totalRows !== 'number' || !Number.isInteger(value.totalRows) || value.totalRows < 0) {
      throw new ValidationError('data.totalRows must be a non-negative integer');
    }
    data.totalRows = value.totalRows;
  }
  return data;
}

export function parseSessionInput(body: unknown): SessionInput {
  if (!isRecord(body)) throw new ValidationError('body must be a JSON object');
  if (typeof body.platform !== 'string' || !PLATFORM_PATTERN.test(body.platform)) {
    throw new ValidationError('platform must be a lowercase identifier such as "tableau" or "powerbi"');
  }
  const input: SessionInput = { platform: body.platform, context: parseContext(body.context ?? {}) };
  if (body.data !== undefined) input.data = parseData(body.data);
  return input;
}

export function summarize(session: Session): SessionSummary {
  const summary: SessionSummary = {
    id: session.id,
    platform: session.platform,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    context: session.context,
  };
  if (session.data) {
    summary.data = { columns: session.data.columns, rowCount: session.data.rows.length };
    if (session.data.totalRows !== undefined) summary.data.totalRows = session.data.totalRows;
  }
  return summary;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly maxSessions = MAX_SESSIONS,
    private readonly now: () => number = Date.now
  ) {}

  create(input: SessionInput): Session {
    this.evictExpired();
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const created = this.now();
    const session: Session = {
      id: crypto.randomUUID(),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttlMs).toISOString(),
      ...input,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private evictExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) this.sessions.delete(id);
    }
  }
}
