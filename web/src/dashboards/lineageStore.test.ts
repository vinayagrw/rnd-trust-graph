import { test } from "node:test";
import assert from "node:assert/strict";
import { applyIncoming, resetLineage, subscribe } from "./lineageStore.js";
import type { DashboardSpec } from "@rnd/shared";

const spec = (id: string, node: string): DashboardSpec => ({
  version: 1, title: "t", widgets: [{ id, kind: "citation-chips", nodeIds: [node] }], citedNodeIds: [node], source: "llm",
});

test("studio and conversation lineages are isolated", () => {
  resetLineage("studio"); resetLineage("conversation");
  applyIncoming(spec("a", "N1"), "studio");
  const conv = applyIncoming(spec("b", "N2"), "conversation");
  assert.deepEqual(conv.spec.widgets.map((w) => w.id), ["b"]); // no "a" bleed
});

test("subscribe fires on merge", () => {
  resetLineage("studio");
  let hits = 0;
  const off = subscribe("studio", () => { hits++; });
  applyIncoming(spec("a", "N1"), "studio");
  off();
  applyIncoming(spec("c", "N1"), "studio");
  assert.equal(hits, 1);
});
