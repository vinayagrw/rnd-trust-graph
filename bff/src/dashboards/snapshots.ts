/**
 * Dashboard snapshots store (Feature 9) — persistence for scheduled dashboard
 * SNAPSHOTS ("recompose this board on a cadence and brief me on what changed")
 * plus a bounded snapshot history. File-backed JSON that MIRRORS
 * `playbooks/routines.ts`: cache + disk-sig, Zod-validated on read AND write,
 * gitignore-safe, hot-reloadable, per-pid scratch in tests.
 *
 * TRUST BOUNDARY: a schedule is pure ORCHESTRATION config — it only decides WHEN a
 * board is recomposed and over WHICH already-cited nodes. It holds no answers and
 * performs NO graph writes. When the scheduler fires it, the recomposition is the
 * UNCHANGED grounded composer (`composeDashboard`), and the resulting spec is the
 * same structurally-inert `DashboardSpec` the chat emits. This store deliberately
 * imports nothing from the graph / ask / composer layers — the executor that couples
 * them lives in `playbooks/scheduler.ts` (`composeSnapshot`), exactly as
 * `executeRoutineRun` is the coupling seam for routines.
 *
 * At most ONE schedule per key (keyed by `key`): "schedule this board" is an upsert.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DashboardSchedule, DashboardSnapshot } from "@rnd/shared";
import { isValidCron, nextRun } from "../playbooks/cron.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted schedules live at bff/dashboard-snapshots.json (gitignore-safe, created
 *  on first write). Overridable via DASHBOARD_SNAPSHOTS_STORE_PATH so tests use a
 *  scratch file. */
export const DASHBOARD_SNAPSHOTS_STORE_PATH =
  process.env.DASHBOARD_SNAPSHOTS_STORE_PATH ?? join(here, "../../dashboard-snapshots.json");

/** Keep the snapshot history bounded so the file never grows without limit. */
const MAX_SNAPSHOTS = 60;

// --- Schema ----------------------------------------------------------------
// A stored spec is validated only STRUCTURALLY here (it was already grounding-checked
// at compose time by dashboards/schema.ts); this store never re-derives grounding.
const storedSpecSchema = z
  .object({
    version: z.literal(1),
    title: z.string(),
    intent: z.string().optional(),
    widgets: z.array(z.record(z.string(), z.unknown())),
    citedNodeIds: z.array(z.string()),
    source: z.enum(["llm", "template"]),
  })
  .passthrough();

const scheduleRecordSchema = z
  .object({
    id: z.string().min(1).max(96),
    key: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9_-]+$/, "key must be url-safe (A-Za-z0-9_-)"),
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(2000),
    citedNodeIds: z.array(z.string().min(1).max(80)).max(64).default([]),
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
    lastSnapshotId: z.string().optional(),
  })
  .strict();

const snapshotSchema = z
  .object({
    id: z.string(),
    scheduleId: z.string(),
    key: z.string(),
    title: z.string().max(200),
    startedAt: z.number(),
    finishedAt: z.number().optional(),
    status: z.enum(["ok", "error"]),
    trigger: z.enum(["schedule", "manual"]),
    source: z.enum(["llm", "template"]).optional(),
    widgetCount: z.number(),
    changedIds: z.array(z.string()).default([]),
    brief: z.string().max(500),
    spec: storedSpecSchema.optional(),
    error: z.string().max(500).optional(),
  })
  .strict();

const storeSchema = z
  .object({
    schedules: z.record(z.string(), scheduleRecordSchema).default({}),
    snapshots: z.array(snapshotSchema).default([]),
  })
  .strict();
type Store = z.infer<typeof storeSchema>;
type ScheduleRecord = z.infer<typeof scheduleRecordSchema>;
/** Internal (zod-inferred) snapshot shape — structurally looser than the shared
 *  `DashboardSnapshot` (spec.widgets is validated only structurally here). Cast to
 *  the shared type at the public boundary. */
type SnapshotRecord = z.infer<typeof snapshotSchema>;

/** The body accepted by upsertSchedule — the user-settable fields only. */
export const scheduleInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    question: z.string().min(1).max(2000),
    citedNodeIds: z.array(z.string().min(1).max(80)).min(1).max(64),
    cadence: z.enum(["hourly", "daily", "weekly", "cron"]),
    cron: z
      .string()
      .min(1)
      .max(120)
      .refine(isValidCron, { message: "invalid cron expression" }),
    enabled: z.boolean(),
  })
  .strict();
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

// --- Cache + load/persist (mirrors routines.ts) -----------------------------
let cache: Store | null = null;
let cacheSig: string | null = null;
/** Monotonic counter so two snapshots recorded in the same millisecond get unique ids. */
let snapSeq = 0;

function diskSig(): string {
  if (!existsSync(DASHBOARD_SNAPSHOTS_STORE_PATH)) return "";
  try {
    const s = statSync(DASHBOARD_SNAPSHOTS_STORE_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

function load(): Store {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: Store = { schedules: {}, snapshots: [] };
  if (sig !== "") {
    try {
      parsed = storeSchema.parse(JSON.parse(readFileSync(DASHBOARD_SNAPSHOTS_STORE_PATH, "utf-8")));
    } catch {
      parsed = { schedules: {}, snapshots: [] };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: Store): void {
  writeFileSync(DASHBOARD_SNAPSHOTS_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

/** Attach the computed (non-persisted) nextRunAt for the UI. */
function withNext(rec: ScheduleRecord, now = new Date()): DashboardSchedule {
  return { ...rec, nextRunAt: rec.enabled ? nextRun(rec.cron, now) : null };
}

// --- Public API -------------------------------------------------------------

/** All schedules, with computed nextRunAt, newest-updated first. */
export function listSchedules(): DashboardSchedule[] {
  const { schedules } = load();
  const now = new Date();
  return Object.values(schedules)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((r) => withNext(r, now));
}

/** The single schedule for a key (or undefined). */
export function getSchedule(key: string): DashboardSchedule | undefined {
  const rec = load().schedules[key];
  return rec ? withNext(rec) : undefined;
}

/**
 * Create-or-update the schedule for a key. Validates the input (ZodError → 400
 * upstream). One schedule per key (upsert), preserving createdAt/createdBy.
 */
export function upsertSchedule(key: string, input: unknown, createdBy?: string): DashboardSchedule {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`invalid schedule key: ${key}`);
  const def = scheduleInputSchema.parse(input);
  const store = load();
  const existing = store.schedules[key];
  const now = Date.now();
  const record = scheduleRecordSchema.parse({
    id: existing?.id ?? `ds_${key}`,
    key,
    title: def.title,
    question: def.question,
    citedNodeIds: def.citedNodeIds,
    cadence: def.cadence,
    cron: def.cron,
    enabled: def.enabled,
    createdBy: existing?.createdBy ?? createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastSnapshotId: existing?.lastSnapshotId,
  });
  persist({ ...store, schedules: { ...store.schedules, [key]: record } });
  return withNext(record);
}

/** Delete a key's schedule. Returns true if it existed. */
export function deleteSchedule(key: string): boolean {
  const store = load();
  if (!store.schedules[key]) return false;
  const { [key]: _removed, ...rest } = store.schedules;
  persist({ ...store, schedules: rest });
  return true;
}

/** Snapshot history, newest first; optionally filtered to one schedule. */
export function listSnapshots(scheduleId?: string): DashboardSnapshot[] {
  const { snapshots } = load();
  const filtered = scheduleId ? snapshots.filter((s) => s.scheduleId === scheduleId) : snapshots;
  return filtered.slice().sort((a, b) => b.startedAt - a.startedAt) as unknown as DashboardSnapshot[];
}

/** The most recent snapshot for a schedule (the diff base for the next run), or
 *  undefined. Only OK snapshots that carry a spec are valid diff bases. */
export function getLatestSnapshot(scheduleId: string): DashboardSnapshot | undefined {
  return listSnapshots(scheduleId).find((s) => s.status === "ok" && s.spec);
}

/**
 * Record a completed snapshot and stamp the schedule's last-run fields. Bounds the
 * history to MAX_SNAPSHOTS. `snap` is the record minus its generated id.
 */
export function recordSnapshot(snap: Omit<DashboardSnapshot, "id">): DashboardSnapshot {
  const store = load();
  const id = `snap_${snap.startedAt}_${snapSeq++}`;
  const full: SnapshotRecord = snapshotSchema.parse({ ...snap, id });
  const snapshots = [full, ...store.snapshots].slice(0, MAX_SNAPSHOTS);
  // Stamp the schedule (keyed by key) if it still exists.
  const rec = store.schedules[snap.key];
  const schedules = rec
    ? {
        ...store.schedules,
        [snap.key]: {
          ...rec,
          lastRunAt: snap.startedAt,
          lastStatus: snap.status,
          lastSnapshotId: id,
        },
      }
    : store.schedules;
  persist({ schedules, snapshots });
  return full as unknown as DashboardSnapshot;
}

/** Build the one-line delta brief for a snapshot. Pure — safe to unit test. */
export function snapshotBrief(widgetCount: number, changedIds: string[], firstRun: boolean): string {
  if (firstRun) return `${widgetCount} widget(s) · initial snapshot`;
  if (changedIds.length === 0) return `${widgetCount} widget(s) · no change vs prior`;
  return `${widgetCount} widget(s) · ${changedIds.length} changed vs prior (${changedIds.slice(0, 4).join(", ")})`;
}

/** Test hook: drop the cache so the next read re-reads disk. */
export function invalidateSnapshotCache(): void {
  cache = null;
  cacheSig = null;
}
