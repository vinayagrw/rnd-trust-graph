/**
 * Saved-dashboards store unit tests (Feature 10 — publish/save/share). Pins the
 * persistence trust story:
 *  (a) save → get → list round-trips (spec + audit), list omits the heavy spec;
 *  (b) save is an UPSERT by id — savedAt preserved, updatedAt refreshes;
 *  (c) GROUNDING is re-enforced on save: a spec whose widget references an un-cited
 *      node is REJECTED (the persisted board stays grounded, can't fabricate a cite);
 *  (d) INERTNESS is re-enforced: a smuggled extra field on the spec is rejected
 *      (.strict()), so a saved board can never carry a value/URL/markup;
 *  (e) delete returns true then false;
 *  (f) TRUST: the store writes no graph triple (the file never contains Cypher/creds).
 *
 * Uses a scratch DASHBOARDS_STORE_PATH so it never touches the real file.
 * Run: `node --import tsx --import ./test-setup.ts --test src/dashboards/store.test.ts`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DashboardSpec } from "@rnd/shared";

const SCRATCH = join(tmpdir(), `rtg-dash-store-test-${process.pid}.json`);
process.env.DASHBOARDS_STORE_PATH = SCRATCH;

const {
  listDashboards,
  getDashboard,
  saveDashboard,
  deleteDashboard,
  invalidateDashboardStoreCache,
  DASHBOARDS_STORE_PATH,
} = await import("./store.js");

function cleanup() {
  if (existsSync(SCRATCH)) unlinkSync(SCRATCH);
  invalidateDashboardStoreCache();
}

const groundedSpec: DashboardSpec = {
  version: 1,
  title: "Myocarditis signal",
  intent: "what is the CPI myocarditis signal?",
  widgets: [
    { id: "w1", kind: "metric", metric: "faithfulness" },
    { id: "w2", kind: "stat-chart", nodeIds: ["STAT-MYO"] },
  ],
  citedNodeIds: ["AE-MYOCARDITIS", "DRUG-CPI", "STAT-MYO"],
  source: "llm",
};

const audit = {
  model: "claude-opus-4-8",
  estimated: false,
  faithfulnessScore: 0.85,
  faithfulnessBand: "high",
  verifiedQueryIds: ["vq-signal-disproportionality"],
  certifiedCount: 1,
};

before(() => assert.equal(DASHBOARDS_STORE_PATH, SCRATCH, "must use scratch store"));
beforeEach(cleanup);
after(cleanup);

test("save → get → list round-trips (list omits the heavy spec)", () => {
  const saved = saveDashboard({ id: "board-1", title: "Myocarditis board", spec: groundedSpec, audit, savedBy: "Dr. A" });
  assert.equal(saved.id, "board-1");
  assert.ok(saved.savedAt && saved.updatedAt);

  const got = getDashboard("board-1");
  assert.ok(got);
  assert.equal(got!.spec.widgets.length, 2);
  assert.equal(got!.audit?.estimated, false);
  assert.equal(got!.audit?.certifiedCount, 1);

  const list = listDashboards();
  assert.equal(list.length, 1);
  assert.equal(list[0].widgetCount, 2);
  assert.equal(list[0].savedBy, "Dr. A");
  assert.equal((list[0] as { spec?: unknown }).spec, undefined, "list summary omits the spec");
});

test("save is an upsert by id — savedAt preserved, updatedAt refreshes", async () => {
  const a = saveDashboard({ id: "board-u", title: "v1", spec: groundedSpec });
  invalidateDashboardStoreCache();
  await new Promise((r) => setTimeout(r, 2));
  const b = saveDashboard({ id: "board-u", title: "v2", spec: groundedSpec });
  assert.equal(b.savedAt, a.savedAt, "savedAt preserved across re-save");
  assert.ok(b.updatedAt >= a.updatedAt, "updatedAt refreshed");
  assert.equal(getDashboard("board-u")!.title, "v2");
  assert.equal(listDashboards().length, 1, "same id overwrites, not appends");
});

test("GROUNDING is re-enforced: a widget referencing an un-cited node is rejected", () => {
  const ungrounded: DashboardSpec = {
    ...groundedSpec,
    widgets: [{ id: "w1", kind: "evidence-subgraph", nodeIds: ["NOT-CITED"] }],
  };
  assert.throws(() => saveDashboard({ title: "bad", spec: ungrounded }), /un-cited|nodeIds|invalid/i);
});

test("INERTNESS is re-enforced: a smuggled extra field on the spec is rejected", () => {
  const tampered = { ...groundedSpec, evilUrl: "http://x" } as unknown as DashboardSpec;
  assert.throws(() => saveDashboard({ title: "bad", spec: tampered }));
});

test("delete returns true then false", () => {
  saveDashboard({ id: "board-del", title: "x", spec: groundedSpec });
  assert.equal(deleteDashboard("board-del"), true);
  assert.equal(deleteDashboard("board-del"), false);
  assert.equal(getDashboard("board-del"), null);
});

test("TRUST: the persisted file never contains a graph write or credentials", () => {
  saveDashboard({ id: "board-t", title: "x", spec: groundedSpec, audit });
  const raw = readFileSync(SCRATCH, "utf-8");
  assert.doesNotMatch(raw, /\b(MERGE|DETACH|CREATE)\b|bolt:\/\/|neo4j:\/\/|password/i);
});
