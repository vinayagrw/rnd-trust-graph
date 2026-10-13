/** Deterministic board critic — pure unit tests. */
import test from "node:test";
import assert from "node:assert/strict";
import type { GenerativeTile, BoardPlan, FieldMenuEntry } from "@rnd/shared";
import { scoreBoard, BOARD_THRESHOLD } from "./boardCritic.js";

const fm: FieldMenuEntry[] = [
  { name: "kind", vlType: "nominal", cardinality: 3, dataset: "cited" },
  { name: "degree", vlType: "quantitative", cardinality: 5, dataset: "cited" },
];

const chart = (id: string, mark: string, encoding: unknown, app = 0.9): GenerativeTile => ({
  id,
  title: id,
  dataset: "cited",
  vlSkeleton: { mark, encoding },
  appropriateness: app,
});

const detailSlots = (n: number): BoardPlan["slots"] =>
  Array.from({ length: n }, () => ({ role: "detail" as const, dataset: "cited" as const, intent: "x" }));

test("an all-identical, redundant board scores below threshold and flags mark diversity", () => {
  const enc = { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } };
  const tiles = ["a", "b", "c", "d"].map((id) => chart(id, "bar", enc));
  const plan: BoardPlan = { archetype: "analytic-grid", filterFields: [], slots: detailSlots(4) };
  const r = scoreBoard(tiles, plan, fm);
  assert.ok(r.score < BOARD_THRESHOLD, `score ${r.score} should be < ${BOARD_THRESHOLD}`);
  assert.ok(r.feedback.some((f) => /diversity/i.test(f)), "flags low mark diversity");
});

test("a missing slot is reported in failedSlots and dents coverage", () => {
  const tiles = [chart("a", "bar", { x: { field: "kind" }, y: { aggregate: "count" } })];
  const plan: BoardPlan = { archetype: "kpi-grid", filterFields: [], slots: detailSlots(2) };
  const r = scoreBoard(tiles, plan, fm);
  assert.deepEqual(r.failedSlots, [1]);
  assert.ok(r.feedback.some((f) => /coverage/i.test(f)));
});

test("a balanced, covered, varied board scores at or above threshold", () => {
  const tiles = [
    chart("a", "bar", { x: { field: "kind" }, y: { aggregate: "count" } }),
    chart("b", "line", { x: { field: "degree" }, y: { aggregate: "count" } }),
    chart("c", "arc", { theta: { aggregate: "count" }, color: { field: "kind" } }),
  ];
  const plan: BoardPlan = { archetype: "analytic-grid", filterFields: ["kind"], slots: detailSlots(3) };
  const r = scoreBoard(tiles, plan, fm);
  assert.ok(r.score >= BOARD_THRESHOLD, `score ${r.score} should be >= ${BOARD_THRESHOLD}`);
  assert.deepEqual(r.failedSlots, []);
});

test("an unresolved filter field is flagged", () => {
  const tiles = [chart("a", "bar", { x: { field: "kind" }, y: { aggregate: "count" } })];
  const plan: BoardPlan = { archetype: "analytic-grid", filterFields: ["ghost"], slots: detailSlots(1) };
  const r = scoreBoard(tiles, plan, fm);
  assert.ok(r.feedback.some((f) => /ghost/.test(f)));
});
