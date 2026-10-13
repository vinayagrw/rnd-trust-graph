/**
 * Minimal 5-field cron — self-contained, zero-dependency (min hour dom month dow).
 *
 * Supports `*`, lists (`a,b`), ranges (`a-b`), steps (`* /n`, `a-b/n`), and the
 * standard Vixie-cron day-of-month/day-of-week OR rule (when BOTH dom and dow are
 * restricted, a match on EITHER fires). dow uses 0–6 with 0 = Sunday (7 also
 * accepted as Sunday). Local time, minute granularity — matching the in-process
 * scheduler's once-a-minute tick. Deliberately tiny; not a general cron engine.
 *
 * This module is pure arithmetic over a Date — it never touches Neo4j, the model,
 * or any answer path. It only decides WHEN a routine is due.
 */

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** True when both dom and dow are restricted (drives the OR rule at match time). */
  domAndDowRestricted: boolean;
}

interface FieldSpec {
  min: number;
  max: number;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week (0 or 7 = Sunday)
];

/** Parse ONE cron field into an explicit set of allowed values. Throws on junk. */
function parseField(raw: string, spec: FieldSpec, wildcardOut: { star: boolean }): Set<number> {
  const out = new Set<number>();
  const parts = raw.split(",");
  for (const part of parts) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in cron field: ${part}`);

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = spec.min;
      hi = spec.max;
      if (stepPart === undefined) wildcardOut.star = true;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`bad range: ${part}`);
      lo = a;
      hi = b;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) throw new Error(`bad value: ${part}`);
      lo = v;
      hi = v;
    }
    if (lo < spec.min || hi > spec.max || lo > hi) throw new Error(`out-of-range cron field: ${part}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty cron field: ${raw}`);
  return out;
}

/** Parse a full 5-field cron expression. Throws Error on any malformed field. */
export function parseCron(expr: string): ParsedCron {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) throw new Error(`cron must have 5 fields, got ${tokens.length}`);

  const stars = [{ star: false }, { star: false }, { star: false }, { star: false }, { star: false }];
  const [minute, hour, dom, month, dowRaw] = tokens.map((t, i) => parseField(t, FIELDS[i], stars[i]));

  // Normalize dow: 7 → 0 (both mean Sunday).
  const dow = new Set<number>();
  for (const d of dowRaw) dow.add(d === 7 ? 0 : d);

  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domAndDowRestricted: !stars[2].star && !stars[4].star,
  };
}

/** True if a Date matches the cron (to the minute), in LOCAL time. */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;

  const domHit = parsed.dom.has(date.getDate());
  const dowHit = parsed.dow.has(date.getDay());
  // Vixie-cron rule: both restricted → OR; otherwise the restricted one(s) must hit.
  return parsed.domAndDowRestricted ? domHit || dowHit : domHit && dowHit;
}

/**
 * Next fire time strictly AFTER `from`, scanning minute-by-minute up to a horizon
 * (default ~366 days). Returns epoch ms, or null if nothing matches in-horizon
 * (e.g. an impossible date like Feb 30). Cheap enough for a handful of routines.
 */
export function nextRun(expr: string, from: Date, horizonDays = 366): number | null {
  let parsed: ParsedCron;
  try {
    parsed = parseCron(expr);
  } catch {
    return null;
  }
  const cursor = new Date(from.getTime());
  // Advance to the start of the next minute (strictly after `from`).
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = from.getTime() + horizonDays * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(parsed, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

/** Preset cadence → cron. Custom cadence carries its own cron string. */
export function cadenceToCron(cadence: string, custom?: string): string {
  switch (cadence) {
    case "hourly":
      return "0 * * * *"; // top of every hour
    case "daily":
      return "0 9 * * *"; // 09:00 local
    case "weekly":
      return "0 9 * * 1"; // Mon 09:00 local
    case "cron":
      return (custom ?? "").trim();
    default:
      throw new Error(`unknown cadence: ${cadence}`);
  }
}

/** Validate a cron string, returning true if parseable. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}
