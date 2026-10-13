/**
 * In-process routine scheduler — a lightweight ticker that runs due playbooks on
 * their cadence while the BFF is up. On each tick it asks each ENABLED routine
 * "are you due this minute?" (via the cron matcher) and, if so, runs the playbook
 * HEADLESS through the UNCHANGED runner, then records the run in the history.
 *
 * TRUST BOUNDARY: this adds no new answer source and no graph write. A scheduled
 * run is byte-for-byte the same as pressing "Run" — each `ask` step drives the
 * grounded agent (which refuses off-graph on its own) and each `checkpoint`
 * enqueues a NON-blocking HITL item for a human to approve later. The scheduler
 * only decides WHEN; it never decides WHAT is true.
 *
 * Safety rails: (a) at most one run per routine per minute (minute-key dedupe);
 * (b) never two concurrent runs of the same playbook (in-flight set); (c) a
 * missing playbook is skipped, not crashed; (d) any run error is caught and
 * recorded as status:"error" rather than taking the process down.
 */
import type { DossierResult, GraphNode, DashboardSnapshot } from "@rnd/shared";
import { mergeDashboard } from "@rnd/shared";
import { log } from "../log.js";
import { getPlaybook } from "./definitions.js";
import { runPlaybook } from "./runner.js";
import { listRoutines, recordRun } from "./routines.js";
import { cronMatches, parseCron } from "./cron.js";
import { getFullGraph } from "../graph/queries.js";
import { composeDashboard } from "../dashboards/composer.js";
import {
  listSchedules,
  getLatestSnapshot,
  recordSnapshot,
  snapshotBrief,
} from "../dashboards/snapshots.js";

/** Tick every 30s; the minute-key dedupe means a routine still fires at most once
 *  per matching minute even though we visit each minute ~twice. */
const TICK_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
/** routineId → last minute-key we fired it on, so a routine runs once per minute. */
const firedThisMinute = new Map<string, string>();
/** playbookIds with a run currently in flight (prevents overlap). */
const inFlight = new Set<string>();
/** schedule keys with a snapshot currently in flight (prevents overlap). */
const snapInFlight = new Set<string>();

function minuteKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
}

/**
 * Run a playbook once and record the outcome in the routine history. Exported so
 * a "Run now" route can reuse the exact same headless path (trigger:"manual").
 * Returns the assembled dossier (or null if the playbook is unknown / in flight).
 */
export async function executeRoutineRun(
  routineId: string,
  playbookId: string,
  trigger: "schedule" | "manual",
): Promise<DossierResult | null> {
  const playbook = getPlaybook(playbookId);
  if (!playbook) {
    log.warn(`scheduler: routine ${routineId} references unknown playbook ${playbookId}; skipping`);
    return null;
  }
  if (inFlight.has(playbookId)) {
    log.warn(`scheduler: ${playbookId} already running; skipping overlapping ${trigger} run`);
    return null;
  }

  inFlight.add(playbookId);
  const startedAt = Date.now();
  let dossier: DossierResult | null = null;
  let checkpointCount = 0;
  let stepCount = 0;
  let status: "ok" | "error" = "ok";
  let error: string | undefined;

  try {
    await runPlaybook(playbookId, (e) => {
      if (e.type === "step-result") {
        stepCount++;
        const kind = (e as { result?: { kind?: string } }).result?.kind;
        if (kind === "checkpoint") checkpointCount++;
      } else if (e.type === "done") {
        dossier = ((e as { dossier?: DossierResult }).dossier) ?? null;
      } else if (e.type === "error") {
        status = "error";
        error = String((e as { message?: unknown }).message ?? "run error");
      }
    });
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    inFlight.delete(playbookId);
  }

  recordRun({
    routineId,
    playbookId,
    playbookTitle: playbook.title,
    startedAt,
    finishedAt: Date.now(),
    status,
    trigger,
    stepCount,
    checkpointCount,
    error,
  });
  log.info(
    `scheduler: ${trigger} run of "${playbook.title}" → ${status} (${stepCount} steps, ${checkpointCount} checkpoints)`,
  );
  return dossier;
}

/**
 * Feature 9 — recompose a scheduled dashboard once and record the snapshot + delta
 * brief. HEADLESS: it resolves the schedule's stored cited ids against the LIVE
 * graph, recomposes via the UNCHANGED grounded composer (`composeDashboard` — LLM
 * when live, else the deterministic template), delta-detects vs the prior snapshot
 * (`mergeDashboard.changedIds`), and stores a brief. Adds NO new answer source and
 * writes NO graph triples — the composed spec is the same inert `DashboardSpec` the
 * chat emits. Exported so a "Run now" route can reuse the exact same path.
 *
 * GROUNDING GATE: only composes + stores a spec when ≥1 stored cited id resolves in
 * the live graph. If nothing resolves, it records a metadata-only error snapshot (no
 * spec) rather than an ungrounded board.
 */
export async function composeSnapshot(
  scheduleId: string,
  key: string,
  question: string,
  title: string,
  citedNodeIds: string[],
  trigger: "schedule" | "manual",
): Promise<DashboardSnapshot | null> {
  if (snapInFlight.has(key)) {
    log.warn(`scheduler: dashboard "${key}" already snapshotting; skipping overlapping ${trigger} run`);
    return null;
  }
  snapInFlight.add(key);
  const startedAt = Date.now();
  try {
    const graph = await getFullGraph("all");
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const citedNodes: GraphNode[] = citedNodeIds
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => Boolean(n));

    // GROUNDING GATE — no cited node resolves ⇒ do NOT compose/store a board.
    if (citedNodes.length === 0) {
      return recordSnapshot({
        scheduleId,
        key,
        title,
        startedAt,
        finishedAt: Date.now(),
        status: "error",
        trigger,
        widgetCount: 0,
        changedIds: [],
        brief: "skipped: no cited nodes resolve in the live graph",
        error: "no grounding",
      });
    }

    const spec = await composeDashboard({ question, answerText: "", citedNodes });
    const prior = getLatestSnapshot(scheduleId);
    const { changedIds } = mergeDashboard(prior?.spec ?? null, spec);
    const brief = snapshotBrief(spec.widgets.length, changedIds, !prior);

    const snap = recordSnapshot({
      scheduleId,
      key,
      title,
      startedAt,
      finishedAt: Date.now(),
      status: "ok",
      trigger,
      source: spec.source,
      widgetCount: spec.widgets.length,
      changedIds,
      brief,
      spec,
    });
    log.info(`scheduler: ${trigger} snapshot of "${title}" → ${brief}`);
    return snap;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn(`scheduler: snapshot of "${title}" failed: ${error}`);
    return recordSnapshot({
      scheduleId,
      key,
      title,
      startedAt,
      finishedAt: Date.now(),
      status: "error",
      trigger,
      widgetCount: 0,
      changedIds: [],
      brief: `snapshot failed: ${error}`.slice(0, 500),
      error: error.slice(0, 500),
    });
  } finally {
    snapInFlight.delete(key);
  }
}

/** One scheduler tick: fire every enabled routine / dashboard schedule whose cron
 *  matches `now`. */
export async function tickOnce(now = new Date()): Promise<void> {
  const key = minuteKey(now);
  for (const routine of listRoutines()) {
    if (!routine.enabled) continue;
    let due = false;
    try {
      due = cronMatches(parseCron(routine.cron), now);
    } catch {
      due = false; // a bad cron never fires
    }
    if (!due) continue;
    if (firedThisMinute.get(routine.id) === key) continue; // already fired this minute
    firedThisMinute.set(routine.id, key);
    // Fire-and-forget within the tick; executeRoutineRun guards overlap itself.
    void executeRoutineRun(routine.id, routine.playbookId, "schedule");
  }

  // Feature 9 — fire due dashboard snapshot schedules (same dedupe + overlap rails).
  for (const schedule of listSchedules()) {
    if (!schedule.enabled) continue;
    let due = false;
    try {
      due = cronMatches(parseCron(schedule.cron), now);
    } catch {
      due = false;
    }
    if (!due) continue;
    if (firedThisMinute.get(schedule.id) === key) continue;
    firedThisMinute.set(schedule.id, key);
    void composeSnapshot(
      schedule.id,
      schedule.key,
      schedule.question,
      schedule.title,
      schedule.citedNodeIds,
      "schedule",
    );
  }

  // Bound the dedupe map: drop keys that aren't the current minute.
  for (const [id, k] of firedThisMinute) if (k !== key) firedThisMinute.delete(id);
}

/** Start the ticker (idempotent). Safe no-op if already running. */
export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void tickOnce().catch((err) => log.error("scheduler tick failed:", err));
  }, TICK_MS);
  // Don't keep the event loop alive solely for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
  log.info(`scheduler: started (tick ${TICK_MS / 1000}s)`);
}

/** Stop the ticker (used on shutdown / in tests). */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
