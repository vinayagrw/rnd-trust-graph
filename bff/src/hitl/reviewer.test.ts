/**
 * F6 — reviewer identity + purpose are stamped on a governed change set and
 * SURVIVE a revert (they are audit metadata, never part of the op replay, so the
 * graph round-trip stays byte-identical). Uses an overlay-only manual-flag change
 * (no baseline graph data touched) and a per-pid scratch HITL_CHANGESETS_PATH
 * (test-setup.ts), so the real audit log is never touched.
 *
 * Run: node --import tsx --import ./test-setup.ts --test src/hitl/reviewer.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { ChangeOp } from "@rnd/shared";
import { healthcheck, closeDriver } from "../neo4j.js";
import { apply, revert, refreshFromDisk } from "./store.js";

let neo4jUp = false;

before(async () => {
  neo4jUp = await healthcheck();
  refreshFromDisk();
});

after(async () => {
  await closeDriver();
});

test("reviewer + purpose are stamped on apply and survive revert (F6)", async (t) => {
  if (!neo4jUp) {
    t.skip("Neo4j not reachable");
    return;
  }
  const nodeId = "AE-MYOCARDITIS";
  const add: ChangeOp = { op: "addManualFlag", nodeId, flag: "conflicting-annotation", reason: "F6 test" };
  const rem: ChangeOp = { op: "removeManualFlag", nodeId, flag: "conflicting-annotation" };

  const cs = await apply({
    title: "F6 reviewer-stamp test",
    description: "overlay-only flag to verify reviewer/purpose stamping",
    targetNodeId: nodeId,
    forwardOps: [add],
    inverseOps: [rem],
    reviewer: { name: "Dr. Vega", role: "PV signal lead" },
    purpose: "safety-review",
  });

  try {
    // Stamped on apply; legacy `actor` mirrors the reviewer name for old views.
    assert.deepEqual(cs.reviewer, { name: "Dr. Vega", role: "PV signal lead" });
    assert.equal(cs.purpose, "safety-review");
    assert.equal(cs.actor, "Dr. Vega");
    assert.equal(cs.status, "applied");
  } finally {
    // Always revert so the overlay/store returns to baseline for other tests.
    const reverted = await revert(cs.id);
    assert.ok(reverted, "revert returned a change set");
    // Metadata is intact after revert; only status flips.
    assert.deepEqual(reverted!.reviewer, { name: "Dr. Vega", role: "PV signal lead" });
    assert.equal(reverted!.purpose, "safety-review");
    assert.equal(reverted!.status, "reverted");
  }
});

test("apply with no reviewer falls back to the legacy demo actor (F6 back-compat)", async (t) => {
  if (!neo4jUp) {
    t.skip("Neo4j not reachable");
    return;
  }
  const nodeId = "AE-MYOCARDITIS";
  const add: ChangeOp = { op: "addManualFlag", nodeId, flag: "duplicate-record" };
  const rem: ChangeOp = { op: "removeManualFlag", nodeId, flag: "duplicate-record" };
  const cs = await apply({
    title: "F6 back-compat",
    description: "no reviewer supplied",
    targetNodeId: nodeId,
    forwardOps: [add],
    inverseOps: [rem],
  });
  try {
    assert.equal(cs.actor, "demo-reviewer");
    assert.equal(cs.reviewer, undefined);
    assert.equal(cs.purpose, undefined);
  } finally {
    await revert(cs.id);
  }
});
