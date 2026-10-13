/**
 * Dashboard snapshots store unit tests (Feature 9). Mirrors routines.test.ts and
 * pins the same trust story for scheduled dashboard SNAPSHOTS:
 *  (a) upsert round-trips + is a true UPSERT (one schedule per key);
 *  (b) nextRunAt is computed on read (present enabled, null when paused);
 *  (c) an invalid cron is REJECTED (can't persist a schedule that never fires);
 *  (d) recordSnapshot stamps the schedule, bounds history, newest-first, and
 *      getLatestSnapshot returns the newest OK snapshot that carries a spec;
 *  (e) an ungrounded schedule (empty citedNodeIds) is rejected at input;
 *  (f) the delta brief is a pure, deterministic summary of changedIds;
 *  (g) TRUST: the store imports nothing from the graph / ask / composer / scheduler
 *      layers — a schedule can never run Cypher or become a new answer source.
 *
 * Uses a scratch DASHBOARD_SNAPSHOTS_STORE_PATH so it never touches the real file.
 * Run: `node --import tsx --import ./test-setup.ts --test src/dashboards/snapshots.test.ts`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardSpec } from "@rnd/shared";

const SCRATCH = join(tmpdir(), `rtg-dash-snap-test-${process.pid}.json`);
process.env.DASHBOARD_SNAPSHOTS_STORE_PATH = SCRATCH;

const {
  listSchedules,
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  listSnapshots,
  getLatestSnapshot,
  recordSnapshot,
  snapshotBrief,
  invalidateSnapshotCache,
  DASHBOARD_SNAPSHOTS_STORE_PATH,
} = await import("./snapshots.js");

function cleanup() {
  if (existsSync(SCRATCH)) unlinkSync(SCRATCH);
  invalidateSnapshotCache();
}

function specFixture(source: "llm" | "template", widgetIds: string[]): DashboardSpec {
  return {
    version: 1,
    title: "Myocarditis signal",
    intent: "what is the CPI myocarditis signal?",
    widgets: widgetIds.map((id) => ({ id, kind: "metric" as const, metric: "faithfulness" as const })),
    citedNodeIds: ["AE-MYOCARDITIS", "DRUG-CPI"],
    source,
  };
}

const goodInput = {
  title: "Myocarditis board",
  question: "what is the CPI myocarditis signal?",
  citedNodeIds: ["AE-MYOCARDITIS", "DRUG-CPI"],
  cadence: "daily" as const,
  cron: "0 9 * * *",
  enabled: true,
};

before(() => assert.equal(DASHBOARD_SNAPSHOTS_STORE_PATH, SCRATCH, "must use scratch store"));
beforeEach(cleanup);
after(cleanup);

test("upsert creates then updates in place (one schedule per key)", () => {
  const a = upsertSchedule("board-myo", goodInput, "Dr. A");
  assert.equal(a.cadence, "daily");
  assert.equal(a.enabled, true);
  assert.equal(a.createdBy, "Dr. A");
  assert.ok(a.createdAt && a.updatedAt);

  invalidateSnapshotCache();
  const b = upsertSchedule("board-myo", { ...goodInput, cadence: "weekly", cron: "0 9 * * 1", enabled: false });
  assert.equal(b.cadence, "weekly");
  assert.equal(b.enabled, false);
  assert.equal(b.createdAt, a.createdAt, "createdAt preserved across upsert");
  assert.equal(b.createdBy, "Dr. A", "createdBy preserved");
  assert.equal(listSchedules().length, 1, "still a single schedule for the key");
});

test("nextRunAt is computed on read (present when enabled, null when paused)", () => {
  const on = upsertSchedule("board-x", { ...goodInput, cadence: "hourly", cron: "0 * * * *", enabled: true });
  assert.equal(typeof on.nextRunAt, "number");
  const off = upsertSchedule("board-x", { ...goodInput, cadence: "hourly", cron: "0 * * * *", enabled: false });
  assert.equal(off.nextRunAt, null, "paused schedule has no next run");
});

test("an invalid cron is rejected", () => {
  assert.throws(() => upsertSchedule("board-y", { ...goodInput, cadence: "cron", cron: "not a cron" }));
});

test("an ungrounded schedule (no cited ids) is rejected", () => {
  assert.throws(() => upsertSchedule("board-z", { ...goodInput, citedNodeIds: [] }));
});

test("a non-url-safe key is rejected", () => {
  assert.throws(() => upsertSchedule("bad key!", goodInput));
});

test("delete returns true then false", () => {
  upsertSchedule("board-d", goodInput);
  assert.equal(deleteSchedule("board-d"), true);
  assert.equal(deleteSchedule("board-d"), false);
  assert.equal(getSchedule("board-d"), undefined);
});

test("recordSnapshot stamps the schedule; history is newest-first + filterable + getLatest", () => {
  upsertSchedule("board-r", goodInput);
  const scheduleId = getSchedule("board-r")!.id;

  recordSnapshot({
    scheduleId,
    key: "board-r",
    title: "Board R",
    startedAt: 1000,
    finishedAt: 1200,
    status: "ok",
    trigger: "schedule",
    source: "llm",
    widgetCount: 3,
    changedIds: ["w1", "w2", "w3"],
    brief: "3 widget(s) · initial snapshot",
    spec: specFixture("llm", ["w1", "w2", "w3"]),
  });
  recordSnapshot({
    scheduleId,
    key: "board-r",
    title: "Board R",
    startedAt: 2000,
    finishedAt: 2200,
    status: "ok",
    trigger: "manual",
    source: "template",
    widgetCount: 3,
    changedIds: ["w2"],
    brief: "3 widget(s) · 1 changed vs prior (w2)",
    spec: specFixture("template", ["w1", "w2", "w3"]),
  });

  const snaps = listSnapshots(scheduleId);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].startedAt, 2000, "newest first");

  const latest = getLatestSnapshot(scheduleId);
  assert.equal(latest?.startedAt, 2000, "latest ok+spec snapshot");
  assert.ok(latest?.spec, "latest carries a spec (the diff base)");

  const schedule = getSchedule("board-r")!;
  assert.equal(schedule.lastRunAt, 2000, "schedule stamped with latest run");
  assert.equal(schedule.lastStatus, "ok");
  assert.equal(listSnapshots("someone-else").length, 0, "filter scopes to scheduleId");
});

test("getLatestSnapshot skips error snapshots (no valid diff base)", () => {
  upsertSchedule("board-e", goodInput);
  const scheduleId = getSchedule("board-e")!.id;
  recordSnapshot({
    scheduleId,
    key: "board-e",
    title: "Board E",
    startedAt: 3000,
    status: "error",
    trigger: "schedule",
    widgetCount: 0,
    changedIds: [],
    brief: "skipped: no cited nodes resolve in the live graph",
    error: "no grounding",
  });
  assert.equal(getLatestSnapshot(scheduleId), undefined, "an error snapshot is not a diff base");
});

test("history is bounded (never grows without limit)", () => {
  upsertSchedule("board-b", goodInput);
  const scheduleId = getSchedule("board-b")!.id;
  for (let i = 0; i < 80; i++) {
    recordSnapshot({
      scheduleId,
      key: "board-b",
      title: "Board B",
      startedAt: 1000 + i,
      status: "ok",
      trigger: "schedule",
      widgetCount: 1,
      changedIds: [],
      brief: "1 widget(s) · no change vs prior",
      spec: specFixture("llm", ["w1"]),
    });
  }
  assert.ok(listSnapshots().length <= 60, "snapshot history capped at 60");
});

test("snapshotBrief is a deterministic summary of the delta", () => {
  assert.equal(snapshotBrief(6, ["w1", "w2", "w3", "w4", "w5", "w6"], true), "6 widget(s) · initial snapshot");
  assert.equal(snapshotBrief(4, [], false), "4 widget(s) · no change vs prior");
  assert.equal(snapshotBrief(4, ["w2", "w4"], false), "4 widget(s) · 2 changed vs prior (w2, w4)");
});

test("TRUST: snapshots store imports nothing from the graph / composer / scheduler", () => {
  const mod = readFileSync(join(import.meta.dirname, "snapshots.ts"), "utf-8");
  assert.doesNotMatch(
    mod,
    /from ["']\.\.\/(neo4j|graph)|from ["']\.\.\/ask\/|from ["']\.\/(composer|scheduler)|from ["']\.\.\/playbooks\/(runner|scheduler)/,
    "the snapshots store must stay a dumb schedule sink (no run/graph/composer coupling)",
  );
  upsertSchedule("board-t", goodInput);
  const raw = readFileSync(SCRATCH, "utf-8");
  assert.doesNotMatch(raw, /\b(MERGE|DETACH)\b|bolt:\/\/|neo4j:\/\/|password/i);
});
