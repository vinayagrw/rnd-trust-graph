/**
 * Verified-query certification (Feature 8) — LLM-free, graph-free.
 *
 * Asserts a widget is certified only when its kind + cited-node kinds match a curated
 * pattern, that certification reads the widget's `nodeIds` subset (not the whole
 * cited set), and that `certifySpec` reports the matched verified-query ids.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardSpec, GraphNode } from "@rnd/shared";
import { certifyWidget, certifySpec } from "./verified.js";

const cited = (pairs: [string, GraphNode["kind"]][]): Pick<GraphNode, "id" | "kind">[] =>
  pairs.map(([id, kind]) => ({ id, kind }));

test("certifies a stat-chart drawn over a SignalStat", () => {
  const q = certifyWidget({ id: "w", kind: "stat-chart" }, cited([["STAT-1", "SignalStat"]]));
  assert.equal(q, "vq-signal-disproportionality");
});

test("does NOT certify a stat-chart without a SignalStat", () => {
  const q = certifyWidget({ id: "w", kind: "stat-chart" }, cited([["DRUG-A", "Drug"]]));
  assert.equal(q, null);
});

test("certifies a hero-flow only with BOTH an AdverseEvent and a Drug", () => {
  const both = cited([["AE-1", "AdverseEvent"], ["DRUG-A", "Drug"]]);
  assert.equal(certifyWidget({ id: "w", kind: "hero-flow" }, both), "vq-mechanism-flow");
  const aeOnly = cited([["AE-1", "AdverseEvent"]]);
  assert.equal(certifyWidget({ id: "w", kind: "hero-flow" }, aeOnly), null);
});

test("certifies an evidence-ledger when any provenance kind is cited (requiresAny)", () => {
  assert.equal(
    certifyWidget({ id: "w", kind: "evidence-ledger" }, cited([["LIT-1", "LiteratureAbstract"]])),
    "vq-evidence-provenance",
  );
  assert.equal(
    certifyWidget({ id: "w", kind: "evidence-ledger" }, cited([["DRUG-A", "Drug"]])),
    null,
  );
});

test("evidence-subgraph needs at least 2 cited nodes (minNodes)", () => {
  const two = cited([["A", "Drug"], ["B", "BiologicalTarget"]]);
  assert.equal(certifyWidget({ id: "w", kind: "evidence-subgraph" }, two), "vq-relational-subgraph");
  const one = cited([["A", "Drug"]]);
  assert.equal(certifyWidget({ id: "w", kind: "evidence-subgraph" }, one), null);
});

test("certification respects a widget's nodeIds subset (not the whole cited set)", () => {
  // The SignalStat is cited, but this stat-chart is scoped to the drug only → no cert.
  const all = cited([["STAT-1", "SignalStat"], ["DRUG-A", "Drug"]]);
  const scoped = certifyWidget({ id: "w", kind: "stat-chart", nodeIds: ["DRUG-A"] }, all);
  assert.equal(scoped, null);
});

test("certifySpec reports certified widget ids + unique verified-query ids", () => {
  const spec: DashboardSpec = {
    version: 1,
    title: "Signal",
    citedNodeIds: ["STAT-1", "AE-1", "DRUG-A"],
    source: "llm",
    widgets: [
      { id: "stat", kind: "stat-chart" },
      { id: "hero", kind: "hero-flow" },
      { id: "chips", kind: "citation-chips" }, // no verified pattern → not certified
    ],
  };
  const { certified, verifiedQueryIds } = certifySpec(spec, cited([
    ["STAT-1", "SignalStat"],
    ["AE-1", "AdverseEvent"],
    ["DRUG-A", "Drug"],
  ]));
  assert.deepEqual(certified.sort(), ["hero", "stat"]);
  assert.deepEqual(verifiedQueryIds.sort(), ["vq-mechanism-flow", "vq-signal-disproportionality"]);
});
