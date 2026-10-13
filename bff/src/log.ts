/**
 * Located logger (BFF) — prepends `file:line fn()` to every line so you can see
 * exactly which function/method emitted it, without hand-instrumenting.
 *
 * Dev-only located metadata: active unless NODE_ENV=production (override with
 * LOG_LOCATED=1 / =0). When gated off, warn/error still print plainly (no stack
 * cost, preserves prior prod behaviour) and debug/info become no-ops. The logger
 * NEVER throws — a stack-parse failure degrades to a plain message.
 *
 * Location comes from parsing one caller frame off `new Error().stack`. Under
 * `tsx` (dev + start) the stack already points at the original `.ts` line; a
 * built `dist` needs `sourceMap:true` + `node --enable-source-maps`.
 */

type Level = "debug" | "info" | "warn" | "error";

const LOCATED =
  process.env.LOG_LOCATED === "1" ||
  (process.env.LOG_LOCATED !== "0" && process.env.NODE_ENV !== "production");

/** This module's basename — frames from here are skipped so the reported site is
 *  the actual caller, not the logger's own internals. */
const LOGGER_FILE = "log.ts";

function parseFrame(frame: string): { fn: string; file: string; line: string } | null {
  // "  at fn (file:///…/x.ts:12:3)" | "  at file:///…/x.ts:12:3" | "  at async fn (…)"
  const m = frame.match(/^\s*at\s+(?:(.*?)\s+\()?([^()]*?):(\d+):\d+\)?\s*$/);
  if (!m) return null;
  let fn = (m[1] || "").trim().replace(/^async\s+/, "");
  if (!fn || fn === "Object.<anonymous>") fn = "<anon>";
  const file = (m[2] || "").replace(/^.*[\\/]/, "").replace(/\?.*$/, "");
  return { fn, file, line: m[3] };
}

/** First stack frame that isn't inside this logger = the caller. "" if unknown. */
function callSite(): string {
  try {
    const lines = (new Error().stack || "").split("\n");
    for (const ln of lines) {
      if (!/^\s*at\s/.test(ln)) continue;
      const s = parseFrame(ln);
      if (!s || !s.file || s.file === LOGGER_FILE) continue;
      return `${s.file}:${s.line} ${s.fn}()`;
    }
  } catch {
    /* never let logging throw */
  }
  return "";
}

function emit(level: Level, args: unknown[]): void {
  const out = console[level] as (...a: unknown[]) => void;
  if (!LOCATED) {
    if (level === "debug" || level === "info") return; // quiet in prod
    out(...args);
    return;
  }
  const where = callSite();
  out(where ? `${level.toUpperCase()} ${where} ›` : `${level.toUpperCase()} ›`, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
