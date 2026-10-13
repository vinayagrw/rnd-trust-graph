/**
 * HITL enqueue store tests — a grounded conclusion can be enqueued as a human
 * review request, persists to its file-backed queue, and shows up in the pending
 * queue via getPendingItems() (concatenation after the three static items).
 *
 * HITL_ENQUEUED_PATH is pointed at a per-pid scratch file by test-setup.ts (loaded
 * via --import ahead of this module), so the real bff/hitl-enqueued.json is never
 * touched. No Neo4j needed — enqueue carries NO graph ops.
 * Run: `node --import tsx --import ./test-setup.ts --test src/hitl/enqueue.test.ts`
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { enqueueFromConclusion, getEnqueued, HITL_ENQUEUED_PATH } from "./enqueue.js";
import { getPendingItems } from "./pending.js";

beforeEach(() => {
  // Start each test from an empty queue (fresh file).
  if (existsSync(HITL_ENQUEUED_PATH)) rmSync(HITL_ENQUEUED_PATH);
});
after(() => {
  if (existsSync(HITL_ENQUEUED_PATH)) rmSync(HITL_ENQUEUED_PATH);
});

test("getEnqueued() is empty when no file exists (resilient)", () => {
  assert.deepEqual(getEnqueued(), []);
});

test("enqueueFromConclusion persists an item that getEnqueued() returns", () => {
  const item = enqueueFromConclusion({
    summary: "DRUG-CPI shows a disproportionality signal for AE-MYOCARDITIS.",
    confidence: 0.78,
    citedNodeIds: ["DRUG-CPI", "AE-MYOCARDITIS"],
  });
  assert.ok(item.id.startsWith("enq-"), "id is prefixed enq-");
  assert.equal(item.description, "DRUG-CPI shows a disproportionality signal for AE-MYOCARDITIS.");
  assert.equal(item.targetNodeId, "DRUG-CPI", "targetNodeId is the first cited node");
  // NEVER fabricate a graph mutation — review requests carry no ops.
  assert.deepEqual(item.forwardOps, []);
  assert.deepEqual(item.inverseOps, []);

  const enqueued = getEnqueued();
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].id, item.id);
});

test("enqueueFromConclusion with no cited nodes leaves targetNodeId undefined", () => {
  const item = enqueueFromConclusion({ summary: "A grounded conclusion.", citedNodeIds: [] });
  assert.equal(item.targetNodeId, undefined);
  assert.deepEqual(item.forwardOps, []);
});

test("getPendingItems() appends enqueued items AFTER the static ones", () => {
  const baseline = getPendingItems();
  const n = baseline.length; // the static demo-pinned scenarios (count-agnostic)
  assert.ok(n > 0, "there is at least one static pending item at baseline");

  const item = enqueueFromConclusion({
    summary: "Enqueued for human review.",
    citedNodeIds: ["TGT-NOPROV"],
  });
  const after = getPendingItems();
  assert.equal(after.length, n + 1, "enqueued item appended to the pending queue");
  assert.equal(after[n].id, item.id, "enqueued item comes after the static ones");
  // The static items are unchanged + first.
  assert.deepEqual(
    after.slice(0, n).map((i) => i.id),
    baseline.map((i) => i.id)
  );
});
