/**
 * UC4 subject-safety radar tests.
 *
 * Two layers, matching the real stack:
 *   - HERMETIC (no Neo4j): the SHACL → findings computation (computeSafetyFindings)
 *     runs on the dedicated safety reasoner alone. Asserts EXACTLY the designed
 *     subjects fire (each on its one risk), the clean controls never fire, and each
 *     finding carries the source brief's seven attributes + a well-formed multi-hop path.
 *   - INTEGRATION (skip unless Neo4j is seeded, like etl/project.test.ts): the
 *     Neo4j-backed report + audit — assessed inventory, score 30/100, and a
 *     reproducible audit whose numbers recompute the headline.
 *
 * Run: `node --import tsx --import ./test-setup.ts --test src/safety/service.test.ts`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  computeSafetyFindings,
  getSafetyReport,
  getSafetyAudit,
  resetSafetyStore,
} from "./service.js";
import { SAFETY_POLICY, type SafetyRiskType } from "@rnd/shared";
import { read, closeDriver } from "../neo4j.js";

/** (subject, risk) pairs the seeded data is designed to raise — and only these. */
const EXPECTED: Record<string, SafetyRiskType> = {
  "SUBJ-201": "missing-allergy-status",
  "SUBJ-202": "conflicting-medication",
  "SUBJ-203": "stale-lab-result",
  "SUBJ-204": "referral-without-followup",
  "SUBJ-205A": "duplicate-subject",
  "SUBJ-206": "unmapped-local-code",
};

/** Controls that MUST raise no finding. */
const CLEAN = ["SUBJ-101", "SUBJ-102", "SUBJ-103"];

/** The DISTINCT subject records that fire ≥1 shape (both duplicate records count). */
const UNSAFE = ["SUBJ-201", "SUBJ-202", "SUBJ-203", "SUBJ-204", "SUBJ-205A", "SUBJ-205B", "SUBJ-206"];

// Neo4j reachability + populated-cache probe (integration tests skip if not ready).
let ready = false;
try {
  const r = await read<{ n: number }>(`MATCH (s:Subject) RETURN count(s) AS n`);
  ready = (r[0]?.n ?? 0) > 0;
} catch {
  ready = false;
}

// --- HERMETIC: SHACL → findings (reasoner only, no Neo4j) --------------------

test("safety radar flags EXACTLY the designed subjects, each on its one risk", async () => {
  resetSafetyStore();
  const { findings, unsafeSubjects } = await computeSafetyFindings();
  const bySubject = new Map(findings.map((f) => [f.subjectId, f.riskType]));
  for (const [subj, risk] of Object.entries(EXPECTED)) {
    assert.equal(bySubject.get(subj), risk, `${subj} must raise ${risk}`);
  }
  assert.equal(findings.length, Object.keys(EXPECTED).length, "exactly 6 findings");
  const flaggedSubjects = new Set(findings.flatMap((f) => f.affectedSubjects));
  for (const c of CLEAN) {
    assert.ok(!flaggedSubjects.has(c), `${c} must be clean`);
  }
  // Both duplicate records count as unsafe (7), even though they collapse to 1 finding.
  assert.deepEqual([...unsafeSubjects].sort(), UNSAFE, "7 unsafe subject records");
});

test("duplicate-subject collapses the pair into one finding listing both records", async () => {
  const { findings } = await computeSafetyFindings();
  const dup = findings.find((f) => f.riskType === "duplicate-subject");
  assert.ok(dup, "a duplicate-subject finding exists");
  assert.deepEqual([...dup!.affectedSubjects].sort(), ["SUBJ-205A", "SUBJ-205B"]);
});

test("every finding carries the source brief's seven attributes", async () => {
  const { findings } = await computeSafetyFindings();
  for (const f of findings) {
    const policy = SAFETY_POLICY[f.riskType];
    assert.equal(f.severity, policy.severity, `${f.id} severity from policy`);
    assert.equal(f.owner, policy.owner, `${f.id} owner from policy`);
    assert.ok(f.reason.trim().length > 0, `${f.id} has a grounded reason`);
    assert.equal(f.rule, policy.rule, `${f.id} names its SHACL shape`);
    assert.ok(f.expected.trim().length > 0, `${f.id} has expected-vs-actual`);
    assert.ok(f.sourceSystems.length > 0, `${f.id} names ≥1 source system`);
    assert.ok(f.remediation.trim().length > 0, `${f.id} has a remediation`);
    assert.ok(f.affectedSubjects.length > 0, `${f.id} names ≥1 affected subject`);
  }
});

test("every finding's path is a multi-hop Subject→…→rule→risk→source chain", async () => {
  const { findings } = await computeSafetyFindings();
  for (const f of findings) {
    const tones = f.path.map((s) => s.tone);
    assert.equal(f.path[0].tone, "fact", `${f.id} path starts at the subject (fact)`);
    assert.equal(f.path[0].nodeId, f.subjectId, `${f.id} first hop is the subject node`);
    assert.ok(tones.includes("gap"), `${f.id} path shows the relationship gap`);
    assert.ok(tones.includes("rule"), `${f.id} path shows the safety rule`);
    assert.equal(f.path[f.path.length - 2].tone, "risk", `${f.id} penultimate hop raises the risk`);
    assert.equal(f.path[f.path.length - 1].tone, "source", `${f.id} last hop names source systems`);
    assert.ok(f.path.length >= 5, `${f.id} path is multi-hop (≥5 steps)`);
  }
});

// --- INTEGRATION: Neo4j-backed report + audit (skip unless seeded) -----------

test("readiness score = 30/100 over 10 assessed subjects", { skip: !ready }, async () => {
  const report = await getSafetyReport();
  assert.equal(report.subjectsAssessed, 10, "10 subjects assessed (from Neo4j)");
  assert.equal(report.findings.length, 6, "6 findings");
  assert.equal(report.overall, 30, "round(100·(10−7)/10) = 30");
  assert.match(report.aiSafetyNote, /Beat 4|ungrounded|faithfulness/i, "cross-links the 8th risk");
});

test("audit reproduces the score: assessed − unsafe recomputes the headline", { skip: !ready }, async () => {
  const audit = await getSafetyAudit();
  assert.equal(audit.assessedCount, 10);
  assert.deepEqual(audit.unsafe, UNSAFE, "the exact unsafe set is exposed, not inferred");
  assert.equal(audit.unsafeCount, 7);
  const recomputed = Math.round((100 * (audit.assessedCount - audit.unsafeCount)) / audit.assessedCount);
  assert.equal(audit.overall, recomputed, "overall recomputes from the exposed counts");
  assert.equal(audit.overall, 30);
  // Every unsafe subject names the shape(s) that fired (traceable, not asserted).
  for (const s of audit.perSubject) {
    assert.ok(s.firedShapes.length > 0, `${s.id} names ≥1 fired shape`);
    assert.ok(s.shaclMessages.length > 0, `${s.id} carries its raw SHACL message(s)`);
  }
});

after(async () => {
  await closeDriver();
});
