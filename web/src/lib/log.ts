/**
 * Located logger (web) — prepends `file:line fn()` to every console line so you
 * can see which component/function/hook emitted it.
 *
 * Dev-only located metadata: active when Vite `import.meta.env.DEV` is true (a
 * production build turns it off). When gated off, warn/error still print plainly
 * and debug/info become no-ops. The logger NEVER throws — a stack-parse failure
 * degrades to a plain message. Vite dev source maps mean frames point at the
 * original `.ts`/`.tsx` line.
 */

type Level = "debug" | "info" | "warn" | "error";

const LOCATED = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/** This module's basename — frames from here are skipped so the reported site is
 *  the actual caller, not the logger's own internals. */
const LOGGER_FILE = "log.ts";

function parseFrame(frame: string): { fn: string; file: string; line: string } | null {
  // "  at fn (http://host/src/x.tsx?t=…:12:3)" | "  at http://host/src/x.tsx:12:3"
  const m = frame.match(/^\s*at\s+(?:(.*?)\s+\()?([^()]*?):(\d+):\d+\)?\s*$/);
  if (!m) return null;
  let fn = (m[1] || "").trim().replace(/^async\s+/, "");
  if (!fn || fn === "Object.<anonymous>") fn = "<anon>";
  const file = (m[2] || "").replace(/^.*[\\/]/, "").replace(/\?.*$/, "");
  return { fn, file, line: m[3] };
}

/** First stack frame that isn't inside this logger = the caller. "" if unknown.
 *  (Chromium is V8, so the format matches; Firefox frames differ and degrade to
 *  no-location, which is acceptable.) */
function callSite(): string {
  try {
    const lines = (new Error().stack || "").split("\n");
    for (const ln of lines) {
      if (!/(^|\s)at\s/.test(ln)) continue;
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
    if (level === "debug" || level === "info") return; // quiet in prod builds
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
