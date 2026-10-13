/**
 * Routines store unit tests (scheduled playbook runs). Pins the schedule-config
 * trust story:
 *  (a) upsert round-trips (cadence/cron/enabled) + stamps timestamps, and is a
 *      true UPSERT (one routine per playbook, second call updates in place);
 *  (b) nextRunAt is computed on read (present when enabled, null when paused);
 *  (c) an invalid cron is REJECTED (can't persist a schedule that never/always
 *      fires by accident);
 *  (d) recordRun stamps the routine's last-run fields and bounds the history;
 *  (e) TRUST: the store imports nothing from the graph layer — a schedule can
 *      never run Cypher or become a new answer source.
 *
 * Uses a scratch ROUTINES_STORE_PATH so it never touches bff/routines.json.
 * Run: `node --import tsx --test src/playbooks/routines.test.ts`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = join(tmpdir(), `rtg-routines-test-${process.pid}.json`);
process.env.ROUTINES_STORE_PATH = SCRATCH;

const {
  listRoutines,
  getRoutineByPlaybook,
  upsertRoutine,
  deleteRoutine,
  listRuns,
  recordRun,
  invalidateRoutineCache,
  ROUTINES_STORE_PATH,
} = await import("./routines.js");

function cleanup() {
  if (existsSync(SCRATCH)) unlinkSync(SCRATCH);
  invalidateRoutineCache();
}

before(() => assert.equal(ROUTINES_STORE_PATH, SCRATCH, "must use scratch store"));
beforeEach(cleanup);
after(cleanup);

test("upsert creates then updates in place (one routine per playbook)", () => {
  const a = upsertRoutine("hepatotox-dossier", { cadence: "daily", cron: "0 9 * * *", enabled: true }, "Dr. A");
  assert.equal(a.cadence, "daily");
  assert.equal(a.enabled, true);
  assert.equal(a.createdBy, "Dr. A");
  assert.ok(a.createdAt && a.updatedAt);

  invalidateRoutineCache();
  const b = upsertRoutine("hepatotox-dossier", { cadence: "weekly", cron: "0 9 * * 1", enabled: false });
  assert.equal(b.cadence, "weekly");
  assert.equal(b.enabled, false);
  assert.equal(b.createdAt, a.createdAt, "createdAt preserved across upsert");
  assert.equal(b.createdBy, "Dr. A", "createdBy preserved");

  assert.equal(listRoutines().length, 1, "still a single routine for the playbook");
});

test("nextRunAt is computed on read (present when enabled, null when paused)", () => {
  const on = upsertRoutine("dossier-x", { cadence: "hourly", cron: "0 * * * *", enabled: true });
  assert.equal(typeof on.nextRunAt, "number");

  const off = upsertRoutine("dossier-x", { cadence: "hourly", cron: "0 * * * *", enabled: false });
  assert.equal(off.nextRunAt, null, "paused routine has no next run");
});

test("an invalid cron is rejected", () => {
  assert.throws(() =>
    upsertRoutine("dossier-y", { cadence: "cron", cron: "not a cron", enabled: true }),
  );
});

test("delete returns true then false", () => {
  upsertRoutine("dossier-z", { cadence: "daily", cron: "0 9 * * *", enabled: true });
  assert.equal(deleteRoutine("dossier-z"), true);
  assert.equal(deleteRoutine("dossier-z"), false);
  assert.equal(getRoutineByPlaybook("dossier-z"), undefined);
});

test("recordRun stamps the routine and history is newest-first + filterable", () => {
  upsertRoutine("dossier-r", { cadence: "daily", cron: "0 9 * * *", enabled: true });
  const routineId = getRoutineByPlaybook("dossier-r")!.id;

  recordRun({
    routineId,
    playbookId: "dossier-r",
    playbookTitle: "Dossier R",
    startedAt: 1000,
    finishedAt: 1200,
    status: "ok",
    trigger: "schedule",
    stepCount: 4,
    checkpointCount: 1,
  });
  recordRun({
    routineId,
    playbookId: "dossier-r",
    playbookTitle: "Dossier R",
    startedAt: 2000,
    finishedAt: 2200,
    status: "error",
    trigger: "manual",
    stepCount: 2,
    checkpointCount: 0,
    error: "boom",
  });

  const runs = listRuns(routineId);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].startedAt, 2000, "newest first");

  const routine = getRoutineByPlaybook("dossier-r")!;
  assert.equal(routine.lastRunAt, 2000, "routine stamped with latest run");
  assert.equal(routine.lastStatus, "error");
  assert.equal(listRuns("someone-else").length, 0, "filter scopes to routineId");
});

test("history is bounded (never grows without limit)", () => {
  upsertRoutine("dossier-b", { cadence: "hourly", cron: "0 * * * *", enabled: true });
  const routineId = getRoutineByPlaybook("dossier-b")!.id;
  for (let i = 0; i < 130; i++) {
    recordRun({
      routineId,
      playbookId: "dossier-b",
      playbookTitle: "Dossier B",
      startedAt: 1000 + i,
      status: "ok",
      trigger: "schedule",
      stepCount: 1,
      checkpointCount: 0,
    });
  }
  assert.ok(listRuns().length <= 100, "run history capped at 100");
});

test("TRUST: routines store imports nothing from the graph layer", () => {
  const mod = readFileSync(join(import.meta.dirname, "routines.ts"), "utf-8");
  assert.doesNotMatch(
    mod,
    /from ["']\.\.\/(neo4j|graph)|from ["']\.\.\/ask\/|from ["']\.\/(runner|definitions)/,
    "the routines store must stay a dumb schedule sink (no run/graph coupling)",
  );
  upsertRoutine("dossier-t", { cadence: "daily", cron: "0 9 * * *", enabled: true });
  const raw = readFileSync(SCRATCH, "utf-8");
  assert.doesNotMatch(raw, /\b(MERGE|DETACH)\b|bolt:\/\/|neo4j:\/\/|password/i);
});
