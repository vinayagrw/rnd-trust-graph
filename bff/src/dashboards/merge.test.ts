/**
 * mergeDashboard (Feature 7) — the live-patch engine, tested purely.
 *
 * Asserts append-only-by-default (existing tiles keep position), update-in-place on a
 * recurring widget id, the union of cited ids (no grounding lost), and an accurate
 * changed-id set for the patch pulse. `mergeDashboard` lives in `@rnd/shared` (a pure
 * transform over the shared type) so it is testable here without any React/web deps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeDashboard, type DashboardSpec } from "@rnd/shared";

const spec = (over: Partial<DashboardSpec>): DashboardSpec => ({
  version: 1,
  title: "Board",
  citedNodeIds: ["A"],
  source: "llm",
  widgets: [{ id: "w1", kind: "citation-chips" }],
  ...over,
});

test("first board: prev=null returns next with every widget marked changed", () => {
  const next = spec({ widgets: [{ id: "w1", kind: "citation-chips" }, { id: "w2", kind: "metric", metric: "coverage" }] });
  const { spec: out, changedIds } = mergeDashboard(null, next);
  assert.equal(out, next);
  assert.deepEqual(changedIds.sort(), ["w1", "w2"]);
});

test("appends a new widget without reflowing existing ones", () => {
  const prev = spec({ widgets: [{ id: "w1", kind: "citation-chips" }] });
  const next = spec({ widgets: [{ id: "w2", kind: "stat-chart" }], citedNodeIds: ["B"] });
  const { spec: out, changedIds } = mergeDashboard(prev, next);
  assert.deepEqual(out.widgets.map((w) => w.id), ["w1", "w2"]); // w1 kept its position
  assert.deepEqual(changedIds, ["w2"]);
});

test("updates a widget in place when its id recurs", () => {
  const prev = spec({ widgets: [{ id: "w1", kind: "citation-chips", title: "Old" }] });
  const next = spec({ widgets: [{ id: "w1", kind: "citation-chips", title: "New" }] });
  const { spec: out, changedIds } = mergeDashboard(prev, next);
  assert.equal(out.widgets.length, 1);
  assert.equal(out.widgets[0].title, "New");
  assert.deepEqual(changedIds, ["w1"]);
});

test("an identical recurring widget is NOT reported as changed", () => {
  const prev = spec({ widgets: [{ id: "w1", kind: "citation-chips", title: "Same" }] });
  const next = spec({ widgets: [{ id: "w1", kind: "citation-chips", title: "Same" }] });
  const { changedIds } = mergeDashboard(prev, next);
  assert.deepEqual(changedIds, []);
});

test("unions cited node ids so no grounding is lost", () => {
  const prev = spec({ citedNodeIds: ["A", "B"] });
  const next = spec({ citedNodeIds: ["B", "C"], widgets: [{ id: "w2", kind: "metric", metric: "coverage" }] });
  const { spec: out } = mergeDashboard(prev, next);
  assert.deepEqual(out.citedNodeIds.sort(), ["A", "B", "C"]);
});

test("the latest turn owns the title/source", () => {
  const prev = spec({ title: "First", source: "template" });
  const next = spec({ title: "Second", source: "llm", widgets: [{ id: "w2", kind: "stat-chart" }] });
  const { spec: out } = mergeDashboard(prev, next);
  assert.equal(out.title, "Second");
  assert.equal(out.source, "llm");
});
