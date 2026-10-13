import { test } from "node:test";
import assert from "node:assert/strict";
import type { StreamEvent } from "@rnd/shared";
import { extractCompleteWidgets, filterWidget, composeFromModelText, type ComposeInput } from "./composer.js";
import type { GraphNode } from "@rnd/shared";

test("dashboard-delta is a valid StreamEvent", () => {
  const ev: StreamEvent = {
    type: "dashboard-delta",
    spec: { version: 1, title: "t", widgets: [{ id: "w", kind: "citation-chips" }], citedNodeIds: ["X"], source: "llm" },
  };
  assert.equal(ev.type, "dashboard-delta");
});

const input: ComposeInput = {
  question: "why myocarditis?",
  answerText: "supported by disproportionality metrics.",
  citedNodes: [
    { id: "AE-MYOCARDITIS", kind: "AdverseEvent" as GraphNode["kind"], label: "Myocarditis" },
    { id: "STAT-1", kind: "SignalStat" as GraphNode["kind"], label: "Disproportionality" },
  ],
};
const cited = new Set(input.citedNodes.map((n) => n.id));

test("a half-typed widget yields NO complete widget", () => {
  const buf = '{"title":"S","widgets":[{"id":"a","kind":"citation-chips"},{"id":"b","kind":"evi';
  const done = extractCompleteWidgets(buf);
  assert.equal(done.length, 1);
  assert.equal((done[0] as any).id, "a");
});

test("filterWidget drops an un-cited node id (per-partial grounding)", () => {
  const w = filterWidget({ id: "c", kind: "citation-chips", nodeIds: ["AE-MYOCARDITIS", "AE-NOPE"] }, cited);
  assert.deepEqual(w?.nodeIds, ["AE-MYOCARDITIS"]);
});

test("filterWidget rejects an unknown kind", () => {
  assert.equal(filterWidget({ id: "x", kind: "iframe" }, cited), null);
});

test("streaming reconciliation equals buffered-parse-once (idempotent)", () => {
  const full = JSON.stringify({
    title: "Signal", widgets: [
      { id: "chips", kind: "citation-chips", nodeIds: ["AE-MYOCARDITIS"] },
      { id: "stat", kind: "stat-chart", nodeIds: ["STAT-1"] },
    ],
  });
  const emitted: string[] = [];
  const seen = new Set<string>();
  for (let i = 20; i <= full.length; i += 7) {
    for (const w of extractCompleteWidgets(full.slice(0, i))) {
      const fw = filterWidget(w, cited);
      if (fw && !seen.has(fw.id)) { seen.add(fw.id); emitted.push(fw.id); }
    }
  }
  const once = composeFromModelText(full, input);
  assert.deepEqual(emitted, once.widgets.map((w) => w.id));
});
