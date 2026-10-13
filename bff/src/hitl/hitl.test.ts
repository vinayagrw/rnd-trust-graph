/**
 * HITL mutate + revert round-trip tests.
 *
 * Proves, for ALL governed scenarios, that apply → revert restores EXACT
 * prior state on BOTH projections (the Neo4j graph payload AND the canonical RDF
 * store), and that the clean baseline still has exactly 7 flagged nodes and a
 * 3-hop hero path. Uses a scratch HITL_CHANGESETS_PATH so the real audit log is
 * never touched.
 *
 * Requires a reachable Neo4j (the dev DB) — the authorized writer mutates it.
 * Run: `node --import tsx --import ./test-setup.ts --test src/hitl/hitl.test.ts`
 */
// HITL_CHANGESETS_PATH is pointed at a per-pid scratch file by test-setup.ts
// (loaded via --import ahead of this module, so the store reads the scratch path
// not the real bff/hitl-changesets.json).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { healthcheck, closeDriver, read } from "../neo4j.js";
import { getCanonicalReasoner, getHeroPath, getFairConformance, NS } from "../reasoner/service.js";
import {
  apply,
  revert,
  listChangeSets,
  appliedItemIds,
  humanReviewedNodeIds,
  refreshFromDisk,
} from "./store.js";
import { getPendingItems, getPendingItem } from "./pending.js";
import { edgeTagsFor } from "./overlay.js";

let neo4jUp = false;
let baselineClean = false;

before(async () => {
  neo4jUp = await healthcheck();
  refreshFromDisk();
  // These are integration tests against the SHARED dev Neo4j and require a clean
  // baseline (the 7 seeded noise flags, no HUMAN_APPROVED edges). If a prior demo
  // left an applied HITL change-set un-reverted, the graph is dirty and the
  // round-trips cannot assert a known prior state. Detect that here and SKIP (with
  // guidance) instead of emitting confusing baseline-assertion failures. The file
  // stores are per-pid isolated (test-setup.ts) but the Neo4j graph is shared, so
  // recovery is operational: `npm run etl` rebuilds the projection at baseline.
  if (neo4jUp) {
    try {
      baselineClean = JSON.stringify(await flaggedIds()) === JSON.stringify(EXPECTED_NOISE);
    } catch {
      baselineClean = false;
    }
  }
});

after(async () => {
  await closeDriver();
});

const SKIP_DIRTY =
  "shared dev Neo4j is not at clean baseline (7 noise flags) — a prior demo's HITL " +
  "change-set is still applied; run `npm run etl` (or revert it in the HITL audit log), then re-run";

/** Precondition gate: a reachable Neo4j AND a clean baseline are both required. */
function precond(t: { skip: (message?: string) => void }): boolean {
  if (!neo4jUp) {
    t.skip("Neo4j not reachable");
    return false;
  }
  if (!baselineClean) {
    t.skip(SKIP_DIRTY);
    return false;
  }
  return true;
}

/** Deterministic snapshot of the WHOLE Neo4j graph: every node's full property
 *  set (so a status/provenance change is captured) + every relationship, sorted. */
async function neo4jSnapshot(): Promise<string> {
  const nodeRows = await read<{ id: string; props: Record<string, unknown> }>(
    `MATCH (n) RETURN n.id AS id, properties(n) AS props`
  );
  const nodes = nodeRows
    .map((r) => {
      const sorted = Object.fromEntries(
        Object.entries(r.props).sort(([a], [b]) => a.localeCompare(b))
      );
      return `${r.id}|${JSON.stringify(sorted)}`;
    })
    .sort();
  const edgeRows = await read<{ src: string; type: string; dst: string }>(
    `MATCH (a)-[r]->(b) RETURN a.id AS src, type(r) AS type, b.id AS dst`
  );
  const edges = edgeRows.map((r) => `${r.src}|${r.type}|${r.dst}`).sort();
  return JSON.stringify({ nodes, edges });
}

/** Deterministic snapshot of the canonical RDF store: every triple, sorted. */
async function rdfSnapshot(): Promise<string> {
  const r = await getCanonicalReasoner();
  const rows = await r.sparqlSelect(
    `SELECT ?s ?p ?o WHERE { ?s ?p ?o } ORDER BY ?s ?p ?o`
  );
  return JSON.stringify(
    rows.map((row) => `${row.s} ${row.p} ${row.o}`).sort()
  );
}

/** Flagged node ids (sorted) from the live readiness report. */
async function flaggedIds(): Promise<string[]> {
  const report = await getFairConformance();
  return report.findings
    .filter((f) => f.flags.length > 0)
    .map((f) => f.nodeId)
    .sort();
}

const EXPECTED_NOISE = [
  "AE-CONFLICT",
  "CON-STALE",
  "DRUG-ORPHAN",
  "STAT-DUP-A",
  "STAT-DUP-B",
  "STAT-NOFOLLOWUP",
  "TGT-NOPROV",
];

test("clean baseline: exactly 7 flagged nodes + hero 3 hops", async (t) => {
  if (!precond(t)) return;
  assert.deepEqual(await flaggedIds(), EXPECTED_NOISE);
  const hero = await getHeroPath();
  const chain = hero.hops
    .map((h) => h.edge)
    .filter((e): e is NonNullable<typeof e> =>
      !!e && ["SUSPECTED_IN", "TARGETS", "IN_PATHWAY"].includes(e.kind)
    );
  assert.equal(chain.length, 3, "hero mechanistic path must be 3 hops");
});

for (const item of getPendingItems()) {
  test(`round-trip: ${item.id} apply→revert restores exact prior state`, async (t) => {
    if (!precond(t)) return;

    const neoBefore = await neo4jSnapshot();
    const rdfBefore = await rdfSnapshot();
    const flagsBefore = await flaggedIds();

    const cs = await apply({
      title: item.title,
      description: item.description,
      targetNodeId: item.targetNodeId,
      forwardOps: item.forwardOps,
      inverseOps: item.inverseOps,
    });

    // ISOLATION: always revert the change-set, even if an assertion below throws.
    // Otherwise a failed round-trip leaks an APPLIED change-set into the shared dev
    // Neo4j, polluting the baseline for every subsequent test and run (the bug that
    // made this suite degrade over repeated demo sessions).
    let revertedInBody = false;
    try {
      assert.equal(cs.status, "applied");

      // The mutation must be OBSERVABLE (otherwise the round-trip proves nothing).
      const neoApplied = await neo4jSnapshot();
      const rdfApplied = await rdfSnapshot();
      assert.notEqual(neoApplied, neoBefore, "apply must change the Neo4j graph");
      assert.notEqual(rdfApplied, rdfBefore, "apply must change the RDF store");

      const reverted = await revert(cs.id);
      revertedInBody = reverted?.status === "reverted";
      assert.equal(reverted?.status, "reverted");

      // EXACT round-trip on both projections + flags.
      assert.equal(await neo4jSnapshot(), neoBefore, "Neo4j restored byte-identical");
      assert.equal(await rdfSnapshot(), rdfBefore, "RDF store restored byte-identical");
      assert.deepEqual(await flaggedIds(), flagsBefore, "flags restored");
      assert.deepEqual(flagsBefore, EXPECTED_NOISE, "baseline flags = 7 noise nodes");
    } finally {
      if (!revertedInBody && cs?.id) {
        try {
          await revert(cs.id);
        } catch {
          /* best-effort cleanup; the original assertion failure is what matters */
        }
      }
    }
  });
}

test("scenario (b) raises readiness while applied (AE-CONFLICT flag cleared)", async (t) => {
  if (!precond(t)) return;
  const item = getPendingItems().find((i) => i.id === "resolve-ae-conflict")!;
  const before = await flaggedIds();
  const cs = await apply({
    title: item.title,
    description: item.description,
    targetNodeId: item.targetNodeId,
    forwardOps: item.forwardOps,
    inverseOps: item.inverseOps,
  });
  const applied = await flaggedIds();
  assert.ok(!applied.includes("AE-CONFLICT"), "AE-CONFLICT flag suppressed while applied");
  assert.equal(applied.length, before.length - 1, "exactly one fewer flagged node");
  await revert(cs.id);
  assert.deepEqual(await flaggedIds(), before, "flag restored after revert");
});

test("scenario (f) reconciling the duplicate clears BOTH STAT-DUP flags", async (t) => {
  if (!precond(t)) return;
  const item = getPendingItems().find((i) => i.id === "reconcile-stat-duplicate")!;
  const before = await flaggedIds();
  const cs = await apply({
    title: item.title,
    description: item.description,
    targetNodeId: item.targetNodeId,
    forwardOps: item.forwardOps,
    inverseOps: item.inverseOps,
  });
  const applied = await flaggedIds();
  assert.ok(!applied.includes("STAT-DUP-A"), "STAT-DUP-A flag suppressed while applied");
  assert.ok(!applied.includes("STAT-DUP-B"), "STAT-DUP-B flag suppressed while applied");
  assert.equal(applied.length, before.length - 2, "exactly two fewer flagged nodes");
  await revert(cs.id);
  assert.deepEqual(await flaggedIds(), before, "both flags restored after revert");
});

test("scenario (a) edge is visible while applied, gone after revert", async (t) => {
  if (!precond(t)) return;
  const item = getPendingItems().find((i) => i.id === "promote-cpi-myocarditis")!;
  const r = await getCanonicalReasoner();
  const ask = () =>
    r.sparqlAsk(
      `PREFIX rtg: <${NS}> ASK { rtg:DRUG-CPI rtg:HUMAN_APPROVED rtg:AE-MYOCARDITIS }`
    );
  assert.equal(await ask(), false, "no HUMAN_APPROVED edge at baseline");
  const cs = await apply({
    title: item.title,
    description: item.description,
    targetNodeId: item.targetNodeId,
    forwardOps: item.forwardOps,
    inverseOps: item.inverseOps,
  });
  assert.equal(await ask(), true, "edge present while applied");
  await revert(cs.id);
  assert.equal(await ask(), false, "edge removed after revert");
});

// Regression: a reviewer edge tag must SURVIVE apply()'s persist() step. persist()
// rebuilds the overlay from the applied changesets (resetOverlay + replay); if that
// replay doesn't re-add addEdgeTag/removeEdgeTag ops, the just-applied tag is wiped
// and never reaches getFullGraph — the tag applies (audit log shows it) but never
// renders. This asserts the round-trip end-to-end: tag present while applied, gone
// after revert. (edgeTagsFor is overlay-only; it needs no Neo4j write for the tag,
// but this lives with the governed round-trips and runs under the same baseline gate.)
test("edge tag round-trip: tag survives apply/persist, cleared on revert", async (t) => {
  if (!precond(t)) return;
  const E = { source: "AE-AFIB", kind: "HAS_STAT" as const, target: "STAT-BTK-AFIB" };
  const TAG = "needs-review";
  assert.deepEqual(edgeTagsFor(E.source, E.kind, E.target), [], "no tag at baseline");
  const cs = await apply({
    title: `Tag edge (${TAG})`,
    description: "edge tag round-trip test",
    targetNodeId: E.source,
    forwardOps: [{ op: "addEdgeTag", source: E.source, target: E.target, kind: E.kind, tag: TAG, reason: "why" }],
    inverseOps: [{ op: "removeEdgeTag", source: E.source, target: E.target, kind: E.kind, tag: TAG }],
  });
  // The bug this guards: WITHOUT the store rebuildOverlay edge-tag replay, this is [].
  assert.deepEqual(
    edgeTagsFor(E.source, E.kind, E.target),
    [TAG],
    "tag is on the edge while applied (survives persist's overlay rebuild)"
  );
  await revert(cs.id);
  assert.deepEqual(edgeTagsFor(E.source, E.kind, E.target), [], "tag cleared after revert");
});

test("manual reviewer flag: apply raises a flag on a clean node, revert clears it", async (t) => {
  if (!precond(t)) return;
  const before = await flaggedIds();
  assert.ok(!before.includes("TGT-PDCD1"), "TGT-PDCD1 is not flagged at baseline");
  const cs = await apply({
    title: "Raise reviewer flag (TGT-PDCD1)",
    description: "manual flag round-trip test",
    targetNodeId: "TGT-PDCD1",
    forwardOps: [
      { op: "addManualFlag", nodeId: "TGT-PDCD1", flag: "missing-cross-source-link", reason: "needs a target link" },
    ],
    inverseOps: [{ op: "removeManualFlag", nodeId: "TGT-PDCD1", flag: "missing-cross-source-link" }],
  });
  const applied = await flaggedIds();
  assert.ok(applied.includes("TGT-PDCD1"), "manual flag raises the node in the radar");
  assert.equal(applied.length, before.length + 1, "exactly one more flagged node");
  // The "why" evidence carries the reviewer note + the manual-flag rule stamp.
  const report = await getFairConformance();
  const finding = report.findings.find((f) => f.nodeId === "TGT-PDCD1");
  const manual = finding?.reasons?.find((r) => r.rule === "Manual reviewer flag");
  assert.ok(manual, "manual flag reason present on the finding");
  assert.equal(manual?.reason, "needs a target link", "reviewer note surfaced as the why");
  await revert(cs.id);
  assert.deepEqual(await flaggedIds(), before, "flag cleared on revert (baseline restored)");
});

test("approving a queue item hides it from pending + marks its node reviewed; revert restores", async (t) => {
  if (!precond(t)) return;
  const item = getPendingItem("attach-tgt-noprov-provenance");
  assert.ok(item, "the seed pending item exists");
  // Baseline: item is listed; its node is not yet human-reviewed.
  assert.ok(!appliedItemIds().has(item!.id), "not applied at baseline");
  assert.ok(!humanReviewedNodeIds().has(item!.targetNodeId!), "node not reviewed at baseline");
  // The same filter the /api/hitl/pending route applies.
  const visibleBefore = getPendingItems().filter((i) => !appliedItemIds().has(i.id));
  assert.ok(visibleBefore.some((i) => i.id === item!.id), "item is in the visible queue before approval");

  const cs = await apply({
    title: item!.title,
    description: item!.description,
    targetNodeId: item!.targetNodeId,
    itemId: item!.id, // the route now passes this so the queue can hide applied items
    forwardOps: item!.forwardOps,
    inverseOps: item!.inverseOps,
  });

  // Applied: dropped from the queue, node now flagged as human-reviewed.
  assert.ok(appliedItemIds().has(item!.id), "applied item id tracked");
  assert.ok(humanReviewedNodeIds().has(item!.targetNodeId!), "approved node is human-reviewed (drives the check stamp)");
  const visibleAfter = getPendingItems().filter((i) => !appliedItemIds().has(i.id));
  assert.ok(!visibleAfter.some((i) => i.id === item!.id), "approved item is gone from the visible queue");

  await revert(cs.id);
  // Reverted: item returns to the queue, node no longer reviewed.
  assert.ok(!appliedItemIds().has(item!.id), "revert clears the applied id (item returns to queue)");
  assert.ok(!humanReviewedNodeIds().has(item!.targetNodeId!), "revert clears the reviewed stamp");
});

test("audit log records applied then reverted status", async (t) => {
  if (!precond(t)) return;
  const log = listChangeSets();
  // Every changeset created in this run ends reverted (each test reverts its own).
  assert.ok(log.length > 0, "audit log is non-empty after the round-trips");
  assert.ok(log.every((c) => c.status === "reverted"), "all changesets reverted");
});
