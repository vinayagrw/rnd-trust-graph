/**
 * Deterministic template builder — the safety net.
 *
 * Asserts it is deterministic, always produces a schema-valid grounded spec, and
 * selects the same figures GroundedDiagrams does (SignalStat → stat chart, hero AE
 * → hero flow).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "@rnd/shared";
import { templateDashboard } from "./template.js";
import { validateSpec } from "./schema.js";

const node = (id: string, kind: GraphNode["kind"]): Pick<GraphNode, "id" | "kind"> => ({ id, kind });

test("is deterministic — same input yields byte-identical spec", () => {
  const input = { question: "why?", citedNodes: [node("AE-MYOCARDITIS", "AdverseEvent"), node("STAT-1", "SignalStat")] };
  assert.deepEqual(templateDashboard(input), templateDashboard(input));
});

test("produces a schema-valid grounded spec", () => {
  const spec = templateDashboard({ question: "why?", citedNodes: [node("DRUG-A", "Drug"), node("TGT-B", "BiologicalTarget")] });
  const res = validateSpec(spec);
  assert.equal(res.ok, true, res.ok ? "" : res.error);
  assert.equal(spec.source, "template");
  assert.deepEqual(spec.citedNodeIds, ["DRUG-A", "TGT-B"]);
});

test("adds a stat chart only when a SignalStat is cited", () => {
  const withStat = templateDashboard({ question: "q", citedNodes: [node("STAT-1", "SignalStat")] });
  const without = templateDashboard({ question: "q", citedNodes: [node("DRUG-A", "Drug")] });
  assert.ok(withStat.widgets.some((w) => w.kind === "stat-chart"));
  assert.ok(!without.widgets.some((w) => w.kind === "stat-chart"));
});

test("adds the hero flow only when the hero AE is cited", () => {
  const withHero = templateDashboard({ question: "q", citedNodes: [node("AE-MYOCARDITIS", "AdverseEvent")] });
  const without = templateDashboard({ question: "q", citedNodes: [node("AE-OTHER", "AdverseEvent")] });
  assert.ok(withHero.widgets.some((w) => w.kind === "hero-flow"));
  assert.ok(!without.widgets.some((w) => w.kind === "hero-flow"));
});
