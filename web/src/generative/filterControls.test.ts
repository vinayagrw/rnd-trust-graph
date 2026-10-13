/**
 * Predicate filter store — pure tests. Proves the cardinality→control predicates
 * narrow correctly AND that predicate filtering composes with the id-based
 * cross-filter as an INTERSECTION (the top integration risk).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GenerativeDatasets, FieldMenuEntry } from "@rnd/shared";
import { narrowDatasets } from "./filterStore.js";
import { applyControls, setControl, getControls, clearControls, subscribeControls, type ControlValue } from "./filterControls.js";

const datasets: GenerativeDatasets = {
  cited: [
    { id: "n1", kind: "Drug", degree: 2 },
    { id: "n2", kind: "AE", degree: 5 },
    { id: "n3", kind: "AE", degree: 1 },
  ],
  metrics: [
    { nodeId: "n1", metric: "prr", value: 3 },
    { nodeId: "n2", metric: "prr", value: 5 },
  ],
  edges: [{ source: "n1", target: "n2", kind: "TARGETS" }],
};
const fieldMenu: FieldMenuEntry[] = [
  { name: "kind", vlType: "nominal", cardinality: 2, dataset: "cited" },
  { name: "degree", vlType: "quantitative", cardinality: 3, dataset: "cited" },
  { name: "value", vlType: "quantitative", cardinality: 2, dataset: "metrics" },
];

test("a set control narrows its dataset AND the linked datasets to the surviving nodes", () => {
  const out = applyControls(datasets, { kind: { type: "set", values: ["Drug"] } }, fieldMenu);
  assert.deepEqual(out.cited.map((r) => r.id), ["n1"], "only the Drug node survives");
  assert.deepEqual(out.metrics.map((r) => r.nodeId), ["n1"], "metrics narrowed to the surviving node");
  assert.equal(out.edges.length, 1, "the edge incident to n1 survives");
});

test("a range control filters numerically", () => {
  const out = applyControls(datasets, { degree: { type: "range", min: 0, max: 3 } }, fieldMenu);
  assert.deepEqual(out.cited.map((r) => r.id).sort(), ["n1", "n3"], "degree 2 and 1 survive, 5 is dropped");
});

test("a metrics-field control narrows via the metrics node key", () => {
  const out = applyControls(datasets, { value: { type: "range", min: 4, max: 10 } }, fieldMenu);
  assert.deepEqual(out.metrics.map((r) => r.nodeId), ["n2"]);
  assert.deepEqual(out.cited.map((r) => r.id), ["n2"], "cited narrowed to the node whose metric matched");
});

test("an edges 'target' filter narrows to the TARGET node, not the source (join key follows the field)", () => {
  const fm: FieldMenuEntry[] = [
    { name: "source", vlType: "nominal", cardinality: 1, dataset: "edges" },
    { name: "target", vlType: "nominal", cardinality: 1, dataset: "edges" },
    { name: "kind", vlType: "nominal", cardinality: 1, dataset: "edges" },
  ];
  // Filtering the edge TARGET must keep n2 (the target of the TARGETS edge), not n1 (its source).
  const out = applyControls(datasets, { target: { type: "set", values: ["n2"] } }, fm);
  assert.deepEqual(out.cited.map((r) => r.id), ["n2"], "the selected target node survives, not the source");
});

test("an edges 'kind' filter keeps BOTH endpoints of the matching edges", () => {
  const fm: FieldMenuEntry[] = [{ name: "kind", vlType: "nominal", cardinality: 1, dataset: "edges" }];
  const out = applyControls(datasets, { kind: { type: "set", values: ["TARGETS"] } }, fm);
  assert.deepEqual(out.cited.map((r) => r.id).sort(), ["n1", "n2"], "both endpoints of the TARGETS edge survive");
});

test("predicate controls compose with the id cross-filter as an INTERSECTION", () => {
  const afterControls = applyControls(datasets, { kind: { type: "set", values: ["Drug"] } }, fieldMenu);
  const afterBoth = narrowDatasets(afterControls, ["n2"]); // mark-selected a different node
  assert.deepEqual(afterBoth.cited.map((r) => r.id), [], "Drug (n1) ∩ selection (n2) = empty");
});

test("no active controls returns the datasets by reference (no churn)", () => {
  assert.equal(applyControls(datasets, {}, fieldMenu), datasets);
  assert.equal(applyControls(datasets, { kind: { type: "set", values: [] } }, fieldMenu), datasets, "an empty set is inactive");
});

test("the store set/get/clear round-trips and notifies", () => {
  clearControls();
  let notified = 0;
  const off = subscribeControls(() => (notified += 1));
  setControl("kind", { type: "set", values: ["Drug"] } as ControlValue);
  assert.deepEqual(getControls().kind, { type: "set", values: ["Drug"] });
  setControl("kind", null);
  assert.equal("kind" in getControls(), false, "null clears the field");
  clearControls();
  assert.deepEqual(getControls(), {});
  assert.ok(notified >= 3);
  off();
});
