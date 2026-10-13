/**
 * Per-node explanation grounding + templated-fallback unit tests. Mirrors the
 * narrator's enforcement: an explanation may only cite the node + its 1-hop
 * neighbours, and the offline template is assembled purely from real facts.
 * Run: `node --import tsx --test src/explain/explainNode.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGrounding } from "../narrate/narrator.js";
import {
  allowedIdsFor,
  templatedExplanation,
  defectReason,
} from "./explainNode.js";
import type { NodeContext } from "../graph/queries.js";

const CTX: NodeContext = {
  node: { id: "DRUG-CPI", kind: "Drug", label: "Checkpoint inhibitor", attrs: { rxnorm: 123 } },
  provenance: {
    sourceSystem: "ChEMBL",
    code: "CHEMBL123",
    timestamp: "2024-01-01",
    license: "CC-BY",
  },
  neighbors: [
    { node: { id: "TGT-PD1", kind: "BiologicalTarget", label: "PD-1" }, relKind: "TARGETS", direction: "out" },
    { node: { id: "AE-MYO", kind: "AdverseEvent", label: "Myocarditis" }, relKind: "CAUSES", direction: "out" },
  ],
};

test("allowedIdsFor = the node plus every 1-hop neighbour", () => {
  assert.deepEqual(allowedIdsFor(CTX), ["DRUG-CPI", "TGT-PD1", "AE-MYO"]);
});

test("accepts an explanation that only cites the node + neighbours", () => {
  const v = validateGrounding(allowedIdsFor(CTX), {
    narration: "Checkpoint inhibitor targets PD-1 and is linked to myocarditis.",
    citedNodeIds: ["DRUG-CPI", "TGT-PD1", "AE-MYO"],
  });
  assert.equal(v.ok, true);
});

test("REFUSES an explanation that cites an entity outside the neighbourhood", () => {
  const v = validateGrounding(allowedIdsFor(CTX), {
    narration: "It is also tied to a fabricated trial.",
    citedNodeIds: ["DRUG-CPI", "NCT-FAKE-9999"],
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "ungrounded");
  assert.deepEqual(v.ok === false && v.offPath, ["NCT-FAKE-9999"]);
});

test("templated fallback is assembled only from real facts (no invention)", () => {
  const text = templatedExplanation(CTX);
  assert.match(text, /Checkpoint inhibitor/);
  assert.match(text, /ChEMBL/);
  assert.match(text, /PD-1/);
  // Must not contain any entity outside the supplied context.
  assert.doesNotMatch(text, /NCT-|fabricat/i);
});

test("templated fallback states the defect reason for a known defect node", () => {
  const ctx: NodeContext = {
    node: { id: "TGT-NOPROV", kind: "BiologicalTarget", label: "Orphan target" },
    provenance: null,
    neighbors: [],
  };
  const text = templatedExplanation(ctx);
  assert.match(text, /no recorded provenance/i);
  assert.match(text, /missing provenance/i);
  assert.ok(defectReason("TGT-NOPROV"));
  assert.equal(defectReason("DRUG-CPI"), null);
});
