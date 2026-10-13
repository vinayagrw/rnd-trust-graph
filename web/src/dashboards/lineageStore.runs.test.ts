import { test } from "node:test";
import assert from "node:assert/strict";
import { applyIncoming, currentSpec, resetLineage, subscribe } from "./lineageStore.js";
import type { DashboardSpec } from "@rnd/shared";

/** Spec helper — configurable widget ids + a shared cited node so `continues` holds. */
const spec = (widgetIds: string[], node = "N1"): DashboardSpec => ({
  version: 1,
  title: "t",
  widgets: widgetIds.map((id) => ({ id, kind: "citation-chips" as const, nodeIds: [node] })),
  citedNodeIds: [node],
  source: "llm",
});

test("same-run streaming deltas accumulate tiles", () => {
  resetLineage("conversation");
  applyIncoming(spec(["w1"]), "conversation", { runId: "r1" });
  const merged = applyIncoming(spec(["w1", "w2"]), "conversation", { runId: "r1" });
  assert.deepEqual(merged.spec.widgets.map((w) => w.id), ["w1", "w2"]);
});

test("failed-run partials roll back on a new run (retry does not duplicate tiles)", () => {
  resetLineage("conversation");
  // Run r1 streams widget "a" but never reconciles (stream dropped / failed).
  applyIncoming(spec(["a"]), "conversation", { runId: "r1" });
  // The retry (run r2) recomposes with a DIFFERENT widget id but a shared cited node.
  applyIncoming(spec(["b"]), "conversation", { runId: "r2" });
  assert.deepEqual(currentSpec("conversation")?.widgets.map((w) => w.id), ["b"]);
});

test("committed board survives a failed retry's partials", () => {
  resetLineage("conversation");
  // r1 reconciles (final) — [a] is the committed base.
  applyIncoming(spec(["a"]), "conversation", { runId: "r1", final: true });
  // r2 streams a partial [p] and never finalizes.
  applyIncoming(spec(["p"]), "conversation", { runId: "r2" });
  // r3 streams [c] — partial p is rolled back, committed a is kept.
  applyIncoming(spec(["c"]), "conversation", { runId: "r3" });
  assert.deepEqual(currentSpec("conversation")?.widgets.map((w) => w.id), ["a", "c"]);
});

test("a stale re-render of a retired run is dropped without notify", () => {
  resetLineage("conversation");
  applyIncoming(spec(["a"]), "conversation", { runId: "r1" });
  applyIncoming(spec(["b"]), "conversation", { runId: "r2" });
  let hits = 0;
  const off = subscribe("conversation", () => { hits++; });
  // Historical transcript re-render replays r1's delta after r2 took over.
  const res = applyIncoming(spec(["a"]), "conversation", { runId: "r1" });
  off();
  assert.deepEqual(res.spec.widgets.map((w) => w.id), ["b"]); // current board, not a merge
  assert.deepEqual(res.changedIds, []);
  assert.equal(hits, 0);
});

test("re-applying an already-applied spec is a cache hit with no notify", () => {
  resetLineage("conversation");
  const first = applyIncoming(spec(["a"]), "conversation", { runId: "r1" });
  let hits = 0;
  const off = subscribe("conversation", () => { hits++; });
  const second = applyIncoming(spec(["a"]), "conversation", { runId: "r1" });
  off();
  assert.equal(second, first); // the SAME cached result object
  assert.equal(hits, 0);
});

test("a byte-identical final (sig-cache hit) still commits — the next run keeps the board", () => {
  resetLineage("conversation");
  // r1 streams delta [w1]...
  applyIncoming(spec(["w1"]), "conversation", { runId: "r1" });
  // ...and its FINAL reconcile is byte-identical to the delta (real for one-widget
  // boards with the fallback title) → sig-cache hit. It must STILL commit.
  applyIncoming(spec(["w1"]), "conversation", { runId: "r1", final: true });
  // The next run rolls back to the committed base — [w1] must survive, not be discarded.
  applyIncoming(spec(["w2"]), "conversation", { runId: "r2" });
  assert.deepEqual(currentSpec("conversation")?.widgets.map((w) => w.id), ["w1", "w2"]);
});

test("retry with byte-identical content re-merges from the committed base (no dup)", () => {
  resetLineage("conversation");
  applyIncoming(spec(["x"]), "conversation", { runId: "r1" });
  // r2 streams the IDENTICAL spec bytes — the new run must not hit r1's cache entry.
  applyIncoming(spec(["x"]), "conversation", { runId: "r2" });
  assert.deepEqual(currentSpec("conversation")?.widgets.map((w) => w.id), ["x"]);
});

test("no-runId calls keep the legacy merge/accumulate behavior", () => {
  resetLineage("conversation");
  applyIncoming(spec(["a"]), "conversation");
  const merged = applyIncoming(spec(["b"]), "conversation");
  assert.deepEqual(merged.spec.widgets.map((w) => w.id), ["a", "b"]);
});
