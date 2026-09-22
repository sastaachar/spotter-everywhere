import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Tee console output to a log file so there is a persistent, timestamped record
// of every request and every failure — including hono/logger's access lines and
// the [tml/import] / [create-liveboard] / [admin] messages — without touching
// each call site. Filesystem runtimes only (Bun/Node); never a Worker.

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Level = (typeof LEVELS)[number];

// State lives on globalThis, not module scope: `bun --hot` re-evaluates this
// module on every reload, so a module-level "patched" flag would reset and
// console would get wrapped again and again (each console.log then writing N
// times). Keyed on globalThis, the patch happens exactly once per process and
// later calls only update the path.
interface LogState { path: string | null; patched: boolean; }
const g = globalThis as unknown as { __spotterLog?: LogState };
const state: LogState = g.__spotterLog ?? (g.__spotterLog = { path: null, patched: false });

function line(level: Level, args: unknown[]): string {
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  return `${ts} [${level.toUpperCase()}] ${msg}\n`;
}

/**
 * Start teeing console.* to `path` (appended), keeping normal stdout/stderr.
 * Idempotent across hot reloads: console is wrapped once per process; repeat
 * calls only repoint the file. Best-effort — a write failure never breaks a
 * request.
 */
export function initFileLog(path: string): string {
  state.path = path;
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* ignore */ }
  if (!state.patched) {
    const console_ = console as unknown as Record<Level, (...a: unknown[]) => void>;
    for (const level of LEVELS) {
      const orig = console_[level].bind(console);
      console_[level] = (...args: unknown[]) => {
        orig(...args);
        if (!state.path) return;
        try { appendFileSync(state.path, line(level, args)); } catch { /* never fail a request over logging */ }
      };
    }
    state.patched = true;
  }
  console.log(`[log] file logging → ${path}`);
  return path;
}
