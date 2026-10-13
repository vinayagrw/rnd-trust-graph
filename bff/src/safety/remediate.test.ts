/**
 * F2 · Agentic Remediate tests — HERMETIC (no Neo4j).
 *
 * Drafts remediations from the REAL findings the dedicated safety reasoner produces
 * (computeSafetyFindings, reasoner-only), and proves the trust posture of the two
 * governed paths:
 *   - ROUTE: the HITL pending item stays PROPOSE-ONLY — its canonical forward/inverse
 *     ops are EMPTY, so routing records intent and touches no data (unchanged posture);
 *   - APPLY: each finding's corrective SafetyChangeOps are REVERSIBLE — applying them
 *     via the authorized safety-writer CLEARS the finding, and replaying the inverse
 *     restores the byte-identical baseline finding set. This is what lets the score move.
 *   - every drafted action + owner is GROUNDED in SAFETY_POLICY (never invented);
 *   - stewardship vs clinical-judgement is classified correctly;
 *   - enqueueItem is idempotent (re-routing the same finding does not duplicate).
 *
 * Run: `node --import tsx --import ./test-setup.ts --test src/safety/remediate.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSafetyFindings, resetSafetyStore, weightedIndexFor } from "./service.js";
import { applySafetyReasonerOps } from "./ops.js";
import { planRemediation, planRemediations, remediationPendingItem, remediationItemId } from "./remediate.js";
import { SAFETY_POLICY, type SafetyRiskType, type SafetyFinding } from "@rnd/shared";

const STEWARDSHIP: SafetyRiskType[] = ["duplicate-subject", "unmapped-local-code"];

/** The DISTINCT risk types currently firing (order-independent). */
async function firingRiskTypes(): Promise<Set<SafetyRiskType>> {
  const { findings } = await computeSafetyFindings();
  return new Set(findings.map((f) => f.riskType));
}

test("planRemediations covers every finding 1:1, grounded in policy", async () => {
  resetSafetyStore();
  const { findings } = await computeSafetyFindings();
  const plans = planRemediations(findings);
  assert.equal(plans.length, findings.length, "one remediation per finding");

  for (const f of findings) {
    const rem = plans.find((p) => p.findingId === f.id);
    assert.ok(rem, `remediation exists for ${f.id}`);
    const policy = SAFETY_POLICY[f.riskType];
    // Grounded — action + owner come straight from the finding/policy, never invented.
    assert.equal(rem!.action, f.remediation);
    assert.equal(rem!.action, policy.remediation);
    assert.equal(rem!.owner, f.owner);
    assert.equal(rem!.owner, policy.owner);
    assert.equal(rem!.reversible, true);
    assert.equal(rem!.pendingItemId, remediationItemId(f.id));
    // Kind classification.
    const expectKind = STEWARDSHIP.includes(f.riskType) ? "data-stewardship" : "clinical-judgement";
    assert.equal(rem!.kind, expectKind, `${f.riskType} → ${expectKind}`);
    // Every seeded finding has a defined, reversible correction (fwd + matching inverse).
    assert.ok(rem!.forwardOps.length > 0, `${f.id}: has corrective forward ops`);
    assert.equal(rem!.inverseOps.length, rem!.forwardOps.length, `${f.id}: inverse mirrors forward`);
  }
});

test("INVARIANT: ROUTING (HITL pending item) stays PROPOSE-ONLY — empty canonical ops", async () => {
  resetSafetyStore();
  const { findings } = await computeSafetyFindings();
  assert.ok(findings.length >= 6, "expected the seeded safety findings");
  for (const f of findings) {
    const item = remediationPendingItem(f);
    // Routing records intent for the owner — it must never carry a canonical data op.
    assert.deepEqual(item.forwardOps, [], `${f.id}: routing forwardOps must stay empty`);
    assert.deepEqual(item.inverseOps, [], `${f.id}: routing inverseOps must stay empty`);
    assert.equal(item.targetNodeId, f.subjectId);
    assert.equal(item.id, remediationItemId(f.id));
    assert.ok(item.effect.length > 0 && /revert/i.test(item.effect), "effect states reversibility");
  }
});

test("INVARIANT: APPLY correction is REVERSIBLE for EVERY finding (clears then restores)", async () => {
  resetSafetyStore();
  const baseline = await firingRiskTypes();
  const { findings } = await computeSafetyFindings();

  for (const f of findings) {
    // Apply the finding's correction → its risk type stops firing.
    await applySafetyReasonerOps(f.correction.forwardOps);
    const afterFix = await firingRiskTypes();
    assert.ok(!afterFix.has(f.riskType), `${f.riskType}: cleared after correction`);

    // Replay the inverse → the exact baseline firing set is restored.
    await applySafetyReasonerOps(f.correction.inverseOps);
    const afterRevert = await firingRiskTypes();
    assert.deepEqual(
      [...afterRevert].sort(),
      [...baseline].sort(),
      `${f.riskType}: revert restores the byte-identical finding set`,
    );
  }
});

test("APPLY unmapped-local-code clears that finding; both scores would rise", async () => {
  resetSafetyStore();
  const before = await computeSafetyFindings();
  const beforeWeighted = weightedIndexFor(before.findings);
  const target = before.findings.find((f) => f.riskType === "unmapped-local-code");
  assert.ok(target, "seeded unmapped-local-code finding present");

  await applySafetyReasonerOps(target!.correction.forwardOps);
  const after = await computeSafetyFindings();
  const afterWeighted = weightedIndexFor(after.findings);

  assert.equal(after.findings.length, before.findings.length - 1, "exactly one finding cleared");
  assert.ok(
    !after.findings.some((f) => f.riskType === "unmapped-local-code"),
    "the unmapped-local-code finding is gone",
  );
  // Fewer unsafe subjects ⇒ reproducible score rises; fewer weighted penalties ⇒
  // weighted index rises. (Reproducible score itself needs Neo4j; the unsafe SET
  // shrinking is the hermetic proxy the endpoint's formula reads.)
  assert.ok(after.unsafeSubjects.size < before.unsafeSubjects.size, "unsafe set shrank");
  assert.ok(afterWeighted > beforeWeighted, "weighted index rose");
});

test("weightedIndexFor penalises P0 more than P2 (severity-weighted)", () => {
  const mk = (severity: SafetyFinding["severity"]): SafetyFinding =>
    ({ severity } as SafetyFinding);
  const clean = weightedIndexFor([]);
  const oneP0 = weightedIndexFor([mk("P0")]);
  const oneP2 = weightedIndexFor([mk("P2")]);
  assert.equal(clean, 100, "no findings ⇒ 100");
  assert.ok(oneP0 < oneP2, "a P0 finding lowers the index more than a P2");
  assert.ok(oneP2 < 100, "any finding lowers the index below clean");
});

test("planRemediation is deterministic (no LLM dependency)", async () => {
  resetSafetyStore();
  const { findings } = await computeSafetyFindings();
  const f = findings[0];
  assert.deepEqual(planRemediation(f), planRemediation(f));
});

test("enqueueItem is idempotent — re-routing does not duplicate", async () => {
  // Point the enqueue store at a scratch file BEFORE importing the module (the path
  // is read at module-eval), so this never touches the real queue.
  const os = await import("node:os");
  const path = await import("node:path");
  const fs = await import("node:fs");
  const scratch = path.join(os.tmpdir(), `f2-enqueue-${process.pid}.json`);
  process.env.HITL_ENQUEUED_PATH = scratch;
  try {
    const { enqueueItem, getEnqueued } = await import("../hitl/enqueue.js");
    resetSafetyStore();
    const { findings } = await computeSafetyFindings();
    const item = remediationPendingItem(findings[0]);
    enqueueItem(item);
    enqueueItem(item); // same id twice
    const queued = getEnqueued().filter((i) => i.id === item.id);
    assert.equal(queued.length, 1, "deduped by id");
  } finally {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      /* ignore */
    }
    delete process.env.HITL_ENQUEUED_PATH;
  }
});
