/**
 * Routines store — persistence for playbook SCHEDULES ("run this dossier on a
 * cadence") plus a bounded run-history. File-backed JSON that mirrors
 * `store.ts` / `threadStore.ts`: cache + disk-sig, Zod-validated on read AND
 * write, gitignore-safe, hot-reloadable.
 *
 * TRUST BOUNDARY: a routine is pure ORCHESTRATION config — it only decides WHEN
 * an existing playbook runs. It holds no answers and no graph writes. When the
 * scheduler fires it, the run is the UNCHANGED grounded path (each `ask` step
 * still refuses off-graph; each `checkpoint` still enqueues a NON-blocking HITL
 * item a human approves later). The store is deliberately ignorant of whether a
 * playbook is curated or custom — it just keys by playbookId.
 *
 * At most ONE routine per playbook (keyed by playbookId): "schedule this
 * playbook" is an upsert, which keeps the UI a single toggle + cadence per row.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { PlaybookRoutine, RoutineRun } from "@rnd/shared";
import { isValidCron, nextRun } from "./cron.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted routines live at bff/routines.json (gitignore-safe, created on first
 *  write). Overridable via ROUTINES_STORE_PATH so tests use a scratch file. */
export const ROUTINES_STORE_PATH =
  process.env.ROUTINES_STORE_PATH ?? join(here, "../../routines.json");

/** Keep the run history bounded so the file never grows without limit. */
const MAX_RUNS = 100;

// --- Schema ----------------------------------------------------------------
const routineRecordSchema = z
  .object({
    id: z.string().min(1).max(96),
    playbookId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "playbookId must be kebab-case"),
    cadence: z.enum(["hourly", "daily", "weekly", "cron"]),
    cron: z
      .string()
      .min(1)
      .max(120)
      .refine(isValidCron, { message: "invalid cron expression" }),
    enabled: z.boolean(),
    createdBy: z.string().max(120).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastRunAt: z.number().optional(),
    lastStatus: z.enum(["ok", "error"]).optional(),
    lastRunId: z.string().optional(),
  })
  .strict();

const runSchema = z
  .object({
    id: z.string(),
    routineId: z.string(),
    playbookId: z.string(),
    playbookTitle: z.string().max(200),
    startedAt: z.number(),
    finishedAt: z.number().optional(),
    status: z.enum(["ok", "error"]),
    trigger: z.enum(["schedule", "manual"]),
    stepCount: z.number(),
    checkpointCount: z.number(),
    error: z.string().max(500).optional(),
  })
  .strict();

const storeSchema = z
  .object({
    routines: z.record(z.string(), routineRecordSchema).default({}),
    runs: z.array(runSchema).default([]),
  })
  .strict();
type Store = z.infer<typeof storeSchema>;
type RoutineRecord = z.infer<typeof routineRecordSchema>;

/** The body accepted by upsertRoutine — the user-settable fields only. */
export const routineInputSchema = z
  .object({
    cadence: z.enum(["hourly", "daily", "weekly", "cron"]),
    cron: z
      .string()
      .min(1)
      .max(120)
      .refine(isValidCron, { message: "invalid cron expression" }),
    enabled: z.boolean(),
  })
  .strict();
export type RoutineInput = z.infer<typeof routineInputSchema>;

// --- Cache + load/persist (mirrors store.ts) --------------------------------
let cache: Store | null = null;
let cacheSig: string | null = null;
/** Monotonic counter so two runs recorded in the same millisecond get unique ids. */
let runSeq = 0;

function diskSig(): string {
  if (!existsSync(ROUTINES_STORE_PATH)) return "";
  try {
    const s = statSync(ROUTINES_STORE_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

function load(): Store {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: Store = { routines: {}, runs: [] };
  if (sig !== "") {
    try {
      parsed = storeSchema.parse(JSON.parse(readFileSync(ROUTINES_STORE_PATH, "utf-8")));
    } catch {
      parsed = { routines: {}, runs: [] };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: Store): void {
  writeFileSync(ROUTINES_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

/** Attach the computed (non-persisted) nextRunAt for the UI. */
function withNext(rec: RoutineRecord, now = new Date()): PlaybookRoutine {
  return { ...rec, nextRunAt: rec.enabled ? nextRun(rec.cron, now) : null };
}

// --- Public API -------------------------------------------------------------

/** All routines, with computed nextRunAt, newest-updated first. */
export function listRoutines(): PlaybookRoutine[] {
  const { routines } = load();
  const now = new Date();
  return Object.values(routines)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((r) => withNext(r, now));
}

/** The single routine for a playbook (or undefined). */
export function getRoutineByPlaybook(playbookId: string): PlaybookRoutine | undefined {
  const rec = load().routines[playbookId];
  return rec ? withNext(rec) : undefined;
}

/**
 * Create-or-update the routine for a playbook. Validates the input (ZodError →
 * 400 upstream). `playbookExists` is injected so this store stays ignorant of
 * definitions.ts (no import cycle) — the caller confirms the id is real first.
 */
export function upsertRoutine(playbookId: string, input: unknown, createdBy?: string): PlaybookRoutine {
  if (!/^[a-z0-9-]+$/.test(playbookId)) throw new Error(`invalid playbookId: ${playbookId}`);
  const def = routineInputSchema.parse(input);
  const store = load();
  const existing = store.routines[playbookId];
  const now = Date.now();
  const record = routineRecordSchema.parse({
    id: existing?.id ?? `rt_${playbookId}`,
    playbookId,
    cadence: def.cadence,
    cron: def.cron,
    enabled: def.enabled,
    createdBy: existing?.createdBy ?? createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastRunId: existing?.lastRunId,
  });
  persist({ ...store, routines: { ...store.routines, [playbookId]: record } });
  return withNext(record);
}

/** Delete a playbook's routine. Returns true if it existed. */
export function deleteRoutine(playbookId: string): boolean {
  const store = load();
  if (!store.routines[playbookId]) return false;
  const { [playbookId]: _removed, ...rest } = store.routines;
  persist({ ...store, routines: rest });
  return true;
}

/** Run history, newest first; optionally filtered to one routine. */
export function listRuns(routineId?: string): RoutineRun[] {
  const { runs } = load();
  const filtered = routineId ? runs.filter((r) => r.routineId === routineId) : runs;
  return filtered.slice().sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Record a completed run and stamp the routine's last-run fields. Bounds the
 * history to MAX_RUNS. `run` is the record minus its generated id.
 */
export function recordRun(run: Omit<RoutineRun, "id">): RoutineRun {
  const store = load();
  const id = `run_${run.startedAt}_${runSeq++}`;
  const full: RoutineRun = runSchema.parse({ ...run, id });
  const runs = [full, ...store.runs].slice(0, MAX_RUNS);
  // Stamp the routine (keyed by playbookId) if it still exists.
  const rec = store.routines[run.playbookId];
  const routines = rec
    ? {
        ...store.routines,
        [run.playbookId]: {
          ...rec,
          lastRunAt: run.startedAt,
          lastStatus: run.status,
          lastRunId: id,
        },
      }
    : store.routines;
  persist({ routines, runs });
  return full;
}

/** Test hook: drop the cache so the next read re-reads disk. */
export function invalidateRoutineCache(): void {
  cache = null;
  cacheSig = null;
}
