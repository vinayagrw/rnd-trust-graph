import test from "node:test";
import assert from "node:assert/strict";
import type { GraphPayload, GraphNode, GraphEdge } from "@rnd/shared";
import { bindFromGraph } from "./bind.js";

/** GraphNode has no `flagged` field in shared/src/types.ts — flags come from the
 *  risk overlay (live SHACL findings), passed into bindFromGraph as a
 *  `flaggedIds` set keyed by nodeId, not read off the node itself. */
const nodes: GraphNode[] = [
  { id: "n3", kind: "AdverseEvent", label: "AE C" },
  { id: "n1", kind: "Drug", label: "Drug A" },
  { id: "n4", kind: "Pathway", label: "Path D" }, // not cited
  { id: "n2", kind: "AdverseEvent", label: "AE B" },
];

const edges: GraphEdge[] = [
  { id: "e1", source: "n1", target: "n2", kind: "TARGETS" },
  { id: "e2", source: "n2", target: "n3", kind: "SUPPORTED_BY" },
  { id: "e3", source: "n1", target: "n4", kind: "TARGETS" }, // n4 not cited -> excluded
];

const graph: GraphPayload = { nodes, edges };
const cited = ["n1", "n2", "n3"];
const flaggedIds = new Set(["n1", "n3"]);

test("filters to cited nodes only, sorted by id", () => {
  const { datasets } = bindFromGraph(graph, cited);
  assert.deepEqual(datasets.cited.map((r) => r.id), ["n1", "n2", "n3"]);
});

test("degree counts only edges among cited nodes", () => {
  const { datasets } = bindFromGraph(graph, cited);
  const byId = Object.fromEntries(datasets.cited.map((r) => [r.id, r]));
  assert.equal(byId.n1!.degree, 1);
  assert.equal(byId.n2!.degree, 2);
  assert.equal(byId.n3!.degree, 1);
});

test("cited rows carry id/label/kind/degree/flagged, flagged sourced from flaggedIds", () => {
  const { datasets } = bindFromGraph(graph, cited, flaggedIds);
  const byId = Object.fromEntries(datasets.cited.map((r) => [r.id, r]));
  assert.deepEqual(byId.n1, { id: "n1", label: "Drug A", kind: "Drug", degree: 1, flagged: true });
  assert.deepEqual(byId.n2, { id: "n2", label: "AE B", kind: "AdverseEvent", degree: 2, flagged: false });
  assert.deepEqual(byId.n3, { id: "n3", label: "AE C", kind: "AdverseEvent", degree: 1, flagged: true });
});

test("omitting flaggedIds yields all-false flagged column", () => {
  const { datasets } = bindFromGraph(graph, cited);
  const byId = Object.fromEntries(datasets.cited.map((r) => [r.id, r]));
  assert.equal(byId.n1!.flagged, false);
  assert.equal(byId.n2!.flagged, false);
  assert.equal(byId.n3!.flagged, false);
});

test("edges dataset rows carry source/target/kind, excluding edges touching a non-cited node", () => {
  const { datasets } = bindFromGraph(graph, cited);
  assert.deepEqual(datasets.edges, [
    { source: "n1", target: "n2", kind: "TARGETS" },
    { source: "n2", target: "n3", kind: "SUPPORTED_BY" },
  ]);
});

test("field menu is dataset-scoped: cited base fields + edges fields (no metrics without numeric attrs)", () => {
  const { fieldMenu } = bindFromGraph(graph, cited, flaggedIds);
  assert.deepEqual(fieldMenu, [
    { name: "kind", vlType: "nominal", cardinality: 2, dataset: "cited" },
    { name: "label", vlType: "nominal", cardinality: 3, dataset: "cited" },
    { name: "degree", vlType: "quantitative", cardinality: 2, dataset: "cited" },
    { name: "flagged", vlType: "nominal", cardinality: 2, dataset: "cited" },
    { name: "source", vlType: "nominal", cardinality: 2, dataset: "edges" },
    { name: "target", vlType: "nominal", cardinality: 2, dataset: "edges" },
    { name: "kind", vlType: "nominal", cardinality: 2, dataset: "edges" },
  ]);
});

test("empty cited ids -> empty rows (all 3 datasets) and empty field menu", () => {
  const { datasets, fieldMenu } = bindFromGraph(graph, []);
  assert.deepEqual(datasets, { cited: [], metrics: [], edges: [] });
  assert.deepEqual(fieldMenu, []);
});

// --- Phase 1: parsed node attributes -> typed columns + tidy `metrics` --------
// `n.attrs` is already numeric-coerced upstream (graph/queries.ts allow-list), so
// a SignalStat's prr/ror/cases arrive as numbers; bind exposes them as quantitative
// columns on `cited` and explodes them into the long `metrics` table.
const attrNodes: GraphNode[] = [
  { id: "s1", kind: "SignalStat", label: "Disproportionality", attrs: { prr: 5.1, ror: 5.5, cases: 44, source: "FAERS" } },
  { id: "a1", kind: "AdverseEvent", label: "AFib" }, // no attrs
];
const attrGraph: GraphPayload = { nodes: attrNodes, edges: [] };

test("numeric attributes become quantitative cited columns; strings stay nominal", () => {
  const { datasets, fieldMenu } = bindFromGraph(attrGraph, ["s1", "a1"]);
  const s1 = datasets.cited.find((r) => r.id === "s1")!;
  assert.equal(s1.prr, 5.1);
  assert.equal(s1.cases, 44);
  assert.equal(s1.source, "FAERS");
  assert.ok(fieldMenu.some((f) => f.name === "prr" && f.vlType === "quantitative" && f.dataset === "cited"));
  assert.ok(fieldMenu.some((f) => f.name === "source" && f.vlType === "nominal" && f.dataset === "cited"));
});

test("missing attrs are null in the wide cited row (union of keys)", () => {
  const { datasets } = bindFromGraph(attrGraph, ["s1", "a1"]);
  const a1 = datasets.cited.find((r) => r.id === "a1")!;
  assert.equal(a1.prr, null);
  assert.equal(a1.cases, null);
  assert.equal(a1.source, null);
});

test("numeric attributes explode into the tidy `metrics` dataset (one row per number)", () => {
  const { datasets, fieldMenu } = bindFromGraph(attrGraph, ["s1", "a1"]);
  assert.deepEqual(
    datasets.metrics.map((r) => ({ nodeId: r.nodeId, metric: r.metric, value: r.value })),
    [
      { nodeId: "s1", metric: "prr", value: 5.1 },
      { nodeId: "s1", metric: "ror", value: 5.5 },
      { nodeId: "s1", metric: "cases", value: 44 },
    ],
  );
  // metrics menu appears only because there is at least one numeric attribute
  assert.ok(fieldMenu.some((f) => f.dataset === "metrics" && f.name === "value" && f.vlType === "quantitative"));
  assert.ok(fieldMenu.some((f) => f.dataset === "metrics" && f.name === "metric" && f.vlType === "nominal"));
});
