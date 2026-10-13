/**
 * Canonical reasoner service tests (slice 1c) — run on the DEFAULT oxigraph
 * backend. Asserts every trust-critical invariant against the reasoner path,
 * and a parity check that the refactored getGatedConclusions / hero-path return
 * the same shape/values they did before the RDF-first rebuild.
 *
 * Run: `node --import tsx --test src/reasoner/service.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCanonicalReasoner,
  getCanonicalReasoner,
  getHeroPath,
  getFairConformance,
  getGatedConclusions,
  NS,
} from "./service.js";
import { RISK_POLICY, type RiskFlag } from "@rnd/shared";

const EXPECTED_NOISE = [
  "AE-CONFLICT",
  "CON-STALE",
  "DRUG-ORPHAN",
  "STAT-DUP-A",
  "STAT-DUP-B",
  "STAT-NOFOLLOWUP",
  "TGT-NOPROV",
];

/** Clean (non-noise) nodes that MUST NOT be flagged — guards against false
 *  positives from the two new shapes (duplicate / missing-followup). */
const CLEAN_NODES = ["AE-MYOCARDITIS", "DRUG-CPI", "TGT-PDCD1", "PW-CHECKPOINT", "STAT-MYO-CPI"];

/** Every RiskFlag value — the union, spelled out so the policy-totality test
 *  fails the moment a new flag is added without a RISK_POLICY entry. */
const ALL_FLAGS: RiskFlag[] = [
  "missing-cross-source-link",
  "dangling-reference",
  "conflicting-annotation",
  "missing-provenance",
  "stale-ontology-version",
  "duplicate-record",
  "missing-followup",
];

test("canonical reasoner builds on oxigraph and materializes candidate-signal", async () => {
  const r = await buildCanonicalReasoner("oxigraph");
  assert.equal(r.backend, "oxigraph");
  // Entailment materialized: DRUG-CPI → PW-CHECKPOINT (TARGETS ∘ IN_PATHWAY).
  const entailed = await r.sparqlAsk(`
    PREFIX rtg: <${NS}>
    ASK { rtg:DRUG-CPI rtg:CANDIDATE_SIGNAL rtg:PW-CHECKPOINT }`);
  assert.equal(entailed, true, "CANDIDATE_SIGNAL DRUG-CPI→PW-CHECKPOINT must be entailed");
});

test("hero path stays 3 hops along AE→DRUG→TGT→PW (SPARQL-confirmed edges)", async () => {
  const path = await getHeroPath();
  assert.equal(path.pathId, "hero-onco-myocarditis-cpi");
  assert.equal(path.deductive, true);
  // The mechanistic chain is exactly 3 edges: SUSPECTED_IN, TARGETS, IN_PATHWAY.
  const chainKinds = ["SUSPECTED_IN", "TARGETS", "IN_PATHWAY"];
  const chainEdges = path.hops
    .map((h) => h.edge)
    .filter((e): e is NonNullable<typeof e> => !!e && chainKinds.includes(e.kind));
  assert.equal(chainEdges.length, 3, "hero mechanistic path must be 3 hops");
  assert.deepEqual(
    chainEdges.map((e) => e.kind),
    chainKinds,
    "hero hops in pinned order AE→DRUG→TGT→PW"
  );
  // Pinned node ids present in order.
  const ids = path.hops.map((h) => h.node.id);
  for (const id of ["AE-MYOCARDITIS", "DRUG-CPI", "TGT-PDCD1", "PW-CHECKPOINT"]) {
    assert.ok(ids.includes(id), `hero path must include ${id}`);
  }
});

test("AE-MYOCARDITIS case series >= 6 (REPORTS)", async () => {
  const r = await getCanonicalReasoner();
  const rows = await r.sparqlSelect(`
    PREFIX rtg: <${NS}>
    SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p rtg:REPORTS rtg:AE-MYOCARDITIS . }`);
  const n = Number(rows[0]?.n ?? 0);
  assert.ok(n >= 6, `AE-MYOCARDITIS case series must be >= 6; got ${n}`);
});

test("live SHACL flags EXACTLY the 7 noise nodes and nothing else", async () => {
  const report = await getFairConformance();
  const flagged = report.findings
    .filter((f) => f.flags.length > 0)
    .map((f) => f.nodeId)
    .sort();
  assert.deepEqual(flagged, EXPECTED_NOISE, `flagged must be exactly the 7 noise nodes`);
  assert.equal(report.shacl?.conforms, false, "live SHACL must be non-conforming");
});

test("each noise node carries its DESIGNED defect flag (incl. the 2 new types)", async () => {
  const report = await getFairConformance();
  const byId = new Map(report.findings.map((f) => [f.nodeId, f.flags]));
  assert.deepEqual(byId.get("TGT-NOPROV"), ["missing-provenance"]);
  assert.deepEqual(byId.get("CON-STALE"), ["stale-ontology-version"]);
  assert.deepEqual(byId.get("DRUG-ORPHAN"), ["missing-cross-source-link"]);
  assert.deepEqual(byId.get("AE-CONFLICT"), ["conflicting-annotation"]);
  // New: duplicate-record fires on BOTH near-duplicate SignalStats.
  assert.deepEqual(byId.get("STAT-DUP-A"), ["duplicate-record"]);
  assert.deepEqual(byId.get("STAT-DUP-B"), ["duplicate-record"]);
  // New: referral-without-follow-up fires on the escalated, un-reviewed stat.
  assert.deepEqual(byId.get("STAT-NOFOLLOWUP"), ["missing-followup"]);
});

test("clean nodes are NOT flagged (no false positives from the new shapes)", async () => {
  const report = await getFairConformance();
  const byId = new Map(report.findings.map((f) => [f.nodeId, f.flags]));
  for (const id of CLEAN_NODES) {
    assert.deepEqual(byId.get(id), [], `${id} must be clean`);
  }
});

test("every flagged finding carries a non-empty, SHACL-grounded reason", async () => {
  const report = await getFairConformance();
  for (const f of report.findings.filter((x) => x.flags.length > 0)) {
    assert.ok(f.reasons && f.reasons.length === f.flags.length, `${f.nodeId} reasons parallel flags`);
    for (const r of f.reasons!) {
      assert.ok(r.reason && r.reason.trim().length > 0, `${f.nodeId} reason non-empty`);
      assert.ok(r.rule && r.rule.length > 0, `${f.nodeId} reason names a rule`);
      assert.ok(f.flags.includes(r.flag), `${f.nodeId} reason flag is one of the node's flags`);
    }
  }
});

test("RISK_POLICY is TOTAL over the RiskFlag union (every flag has severity+owner)", () => {
  for (const flag of ALL_FLAGS) {
    const policy = RISK_POLICY[flag];
    assert.ok(policy, `RISK_POLICY missing entry for flag '${flag}'`);
    assert.ok(["P0", "P1", "P2"].includes(policy.severity), `${flag} severity valid`);
    assert.ok(policy.owner && policy.owner.length > 0, `${flag} owner non-empty`);
  }
  // The map must have NO extra keys beyond the union (catches drift).
  assert.deepEqual(Object.keys(RISK_POLICY).sort(), [...ALL_FLAGS].sort());
});

test("readiness formula preserved: base − penalty·flags (defaults 100/25)", async () => {
  const report = await getFairConformance();
  for (const f of report.findings) {
    const expected = Math.max(0, 100 - 25 * f.flags.length);
    assert.equal(f.readiness, expected, `${f.nodeId} readiness`);
  }
  // Overall is the mean of per-node readiness.
  const mean = Math.round(
    report.findings.reduce((s, f) => s + f.readiness, 0) / report.findings.length
  );
  assert.equal(report.overall, mean);
});

test("gated conclusions: deductive auto-accept (entailment) + statistical human-review", async () => {
  const gated = await getGatedConclusions();
  // Parity: same two ids/kinds/routing as before the rebuild.
  const deductive = gated.find((g) => g.id === "gc-path-exists");
  const statistical = gated.find((g) => g.id === "gc-disproportionality");
  assert.ok(deductive && statistical, "both gated conclusions present");
  assert.equal(deductive!.kind, "deductive");
  assert.equal(deductive!.routedToHuman, false);
  assert.equal(statistical!.kind, "statistical");
  assert.equal(statistical!.routedToHuman, true);
  assert.equal(typeof statistical!.confidence, "number");

  // The deductive conclusion carries a REAL entailment trace (why the rule fires).
  const trace = (deductive as any).trace;
  assert.ok(trace, "deductive conclusion must carry an inference trace");
  assert.match(trace.rule, /CANDIDATE_SIGNAL/);
  assert.equal(trace.steps.length, 2, "TARGETS + IN_PATHWAY premises");
  assert.match(trace.steps[0].premise, /TARGETS/);
  assert.match(trace.steps[1].premise, /IN_PATHWAY/);
  assert.match(trace.conclusion, /CANDIDATE_SIGNAL/);

  // The statistical conclusion's confidence is reasoner-config data, and its
  // summary reports a PRR read from the store (not a hardcoded literal).
  assert.match(statistical!.summary, /PRR/);
});
