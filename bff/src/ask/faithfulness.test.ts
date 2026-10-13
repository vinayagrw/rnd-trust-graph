/**
 * Faithfulness (F1) + context-recall (F2) + claim-tracing (F4) unit tests.
 *
 * Pure functions over (answer/question, citedNodes) — no I/O, no scratch file.
 * The keystone assertion: a FABRICATED claim (named entities/figures absent from
 * the cited evidence) drops the score and lands in `unsupportedClaims`, while a
 * faithful answer over the same evidence scores high.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "@rnd/shared";
import { scoreFaithfulness, contextRecall, extractClaims } from "./faithfulness.js";

const NODES: GraphNode[] = [
  {
    id: "AE-MYOCARDITIS",
    kind: "AdverseEvent",
    label: "Immune-related myocarditis",
  },
  {
    id: "DRUG-CPI",
    kind: "Drug",
    label: "Checkpoint inhibitor",
  },
  {
    id: "STAT-MYO-CPI",
    kind: "SignalStat",
    label: "Disproportionality signal",
    attrs: { prr: 7.8, cases: 12 },
  },
];

test("extractClaims splits sentences and drops fragments/fences", () => {
  const claims = extractClaims(
    "The checkpoint inhibitor is linked to myocarditis. PRR is 7.8.\n```cypher\nMATCH (n) RETURN n\n```\nok"
  );
  assert.ok(claims.length >= 2);
  assert.ok(!claims.some((c) => c.includes("MATCH"))); // code fence dropped
});

test("faithful answer over cited evidence scores high", () => {
  const answer =
    "The checkpoint inhibitor (DRUG-CPI) is linked to immune-related myocarditis. " +
    "The disproportionality signal shows a PRR of 7.8 across 12 cases.";
  const r = scoreFaithfulness(answer, NODES);
  assert.equal(r.method, "deterministic");
  assert.ok(r.score >= 0.8, `expected high score, got ${r.score}`);
  assert.equal(r.band, "high");
  assert.equal(r.unsupportedClaims.length, 0);
});

test("a fabricated claim drops the score and is flagged unsupported (F4)", () => {
  // First claim is grounded; second names entities/figures NOT in the evidence.
  const answer =
    "The checkpoint inhibitor is linked to myocarditis. " +
    "Aspirin reduces tumor size by 42 percent in pediatric leukemia.";
  const r = scoreFaithfulness(answer, NODES);
  assert.ok(r.score < 0.8, `expected reduced score, got ${r.score}`);
  assert.equal(r.unsupportedClaims.length, 1);
  assert.match(r.unsupportedClaims[0], /aspirin/i);
});

test("no cited evidence but claims present → score 0 (cannot be grounded)", () => {
  const r = scoreFaithfulness("Some confident claim about cardiology outcomes here.", []);
  assert.equal(r.score, 0);
  assert.equal(r.band, "low");
});

test("contextRecall: question entities found in cited evidence", () => {
  // "checkpoint", "inhibitor", "myocarditis" all appear in the cited labels.
  const recall = contextRecall("How is the checkpoint inhibitor linked to myocarditis?", NODES);
  assert.ok(recall >= 0.5, `expected decent recall, got ${recall}`);
  // A question about an unrelated entity recalls poorly.
  const poor = contextRecall("What about aspirin and pediatric leukemia outcomes?", NODES);
  assert.ok(poor < recall, `expected ${poor} < ${recall}`);
});
