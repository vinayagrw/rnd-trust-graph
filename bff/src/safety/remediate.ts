/**
 * F2 · Agentic Remediate — remediation planner for the UC4 safety radar.
 *
 * Turns each SafetyFinding the SHACL radar produced into a GOVERNED, REVERSIBLE
 * remediation the agent drafts for the accountable owner. It is DETERMINISTIC —
 * grounded in SAFETY_POLICY + the finding's own attributes (including the corrective
 * ops the finding carries, built from its live evidence query) — so it works even
 * when the live LLM is unavailable, and it can never invent an action or owner.
 *
 * TWO governed paths, both audit-logged + fully reversible, neither touching the
 * read-only agent/MCP path or the FAIR (canonical) baseline:
 *   1. ROUTE (remediationPendingItem) — enqueue a PROPOSE-ONLY item into the HITL
 *      queue for the owner. It carries EMPTY canonical ChangeOps (it records intent,
 *      not a data change) — that routing posture is unchanged and still asserted.
 *   2. APPLY (planRemediation.forwardOps/inverseOps) — the authorized SAFETY-writer
 *      (safety/ops.ts) applies the finding's reversible corrective SafetyChangeOps to
 *      the ISOLATED safety substrate (safety reasoner + :Safety Neo4j), which CLEARS
 *      the finding and moves the readiness score. Revert replays the inverse ops to
 *      restore byte-identical state. This closes the loop the radar previously left open.
 */
import type {
  SafetyFinding,
  SafetyRemediation,
  HitlPendingItem,
  SafetyRiskType,
} from "@rnd/shared";
import { SAFETY_POLICY } from "@rnd/shared";

/** Risk types whose fix is pure data stewardship (vs a clinical judgement in the EHR). */
const STEWARDSHIP: ReadonlySet<SafetyRiskType> = new Set<SafetyRiskType>([
  "duplicate-subject",
  "unmapped-local-code",
]);

/** Deterministic pending-item id for a finding's remediation (stable across calls). */
export const remediationItemId = (findingId: string): string => `remediate:${findingId}`;

/** The honest, plain-English effect of applying this remediation. */
function effectFor(f: SafetyFinding, kind: SafetyRemediation["kind"]): string {
  const subjects = f.affectedSubjects.join(" + ");
  const hasCorrection = f.correction.forwardOps.length > 0;
  const base =
    `Governed remediation on ${subjects} (owner: ${f.owner}) — ` +
    `“${f.remediation}”. Audit-logged and fully revertible.`;
  if (!hasCorrection) {
    return (
      base +
      " Routing records the decision for the accountable owner; no graph data is changed here."
    );
  }
  const honesty =
    kind === "clinical-judgement"
      ? " Applying records the governed clinical action as a reversible change to the safety graph — it clears the finding and moves the readiness score; revert restores the prior state."
      : " Applying performs the reversible data-stewardship fix (dedupe / code mapping) on the safety graph — it clears the finding and moves the readiness score; revert restores the prior state.";
  return base + honesty;
}

/** Draft the remediation the agent proposes for one finding (propose-only, no writes). */
export function planRemediation(f: SafetyFinding): SafetyRemediation {
  const kind: SafetyRemediation["kind"] = STEWARDSHIP.has(f.riskType)
    ? "data-stewardship"
    : "clinical-judgement";
  return {
    findingId: f.id,
    riskType: f.riskType,
    subjectId: f.subjectId,
    subjectLabel: f.subjectLabel,
    severity: f.severity,
    action: f.remediation,
    owner: f.owner,
    kind,
    affectedSubjects: f.affectedSubjects,
    sourceSystems: f.sourceSystems,
    reversible: true,
    effect: effectFor(f, kind),
    pendingItemId: remediationItemId(f.id),
    // The reversible corrective ops that CLEAR the finding when applied by the
    // authorized safety-writer — grounded on the finding (built from the same live
    // query as its evidence path), never fabricated.
    forwardOps: f.correction.forwardOps,
    inverseOps: f.correction.inverseOps,
  };
}

/** Draft remediations for every finding (propose-only, no writes). */
export function planRemediations(findings: SafetyFinding[]): SafetyRemediation[] {
  return findings.map(planRemediation);
}

/**
 * Build the HITL pending item a routed remediation becomes.
 *
 * PROPOSE-ONLY: forward/inverse ops are EMPTY by design — approving records a governed
 * remediation decision (audit + a reversible no-op change set that stamps the subject
 * "human-reviewed"), it never mutates graph data. This is the whole trust posture, not
 * an omission; remediate.test.ts asserts the ops stay empty.
 */
export function remediationPendingItem(f: SafetyFinding): HitlPendingItem {
  const rem = planRemediation(f);
  const policy = SAFETY_POLICY[f.riskType];
  return {
    id: rem.pendingItemId,
    title: `Remediate: ${policy.label} (${f.affectedSubjects.join(" + ")})`,
    description:
      `Agent-drafted remediation for the ${policy.label.toLowerCase()} safety finding on ` +
      `${f.affectedSubjects.join(" + ")}. Owner: ${f.owner}. Action: ${f.remediation}.`,
    effect: rem.effect,
    targetNodeId: f.subjectId,
    forwardOps: [],
    inverseOps: [],
  };
}
