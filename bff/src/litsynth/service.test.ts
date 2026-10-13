/**
 * F7 — Literature synthesis tests. Pure units only (no Neo4j / no LLM):
 *  - rankSources orders by source tier, then recency, then id, with 1-based ranks.
 *  - groundOrFallback ENFORCES grounding: an off-list citation (JSON or inline)
 *    refuses the model narrative and falls back to a template that only restates
 *    the served summaries — so an off-list paper can never be surfaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "@rnd/shared";
import { rankSources, groundOrFallback } from "./service.js";

function litNode(id: string, summary: string, source: string, ts: string): GraphNode {
  return {
    id,
    kind: "LiteratureAbstract",
    label: `${id} title`,
    attrs: { summary },
    provenance: { sourceSystem: source, timestamp: ts, license: "public-domain" },
  };
}

test("rankSources: regulatory > trial > journal, then recency, with 1-based ranks", () => {
  const nodes = [
    litNode("LIT-PMID-1", "older journal", "PubMed", "2020-01-01T00:00:00Z"),
    litNode("LIT-PMID-2", "newer journal", "PubMed", "2026-01-01T00:00:00Z"),
    litNode("LIT-PMID-3", "a trial", "ClinicalTrials.gov", "2019-01-01T00:00:00Z"),
    litNode("LIT-PMID-4", "a label", "FDA label", "2018-01-01T00:00:00Z"),
  ];
  const ranked = rankSources(nodes);
  assert.deepEqual(
    ranked.map((r) => r.nodeId),
    ["LIT-PMID-4", "LIT-PMID-3", "LIT-PMID-2", "LIT-PMID-1"],
  );
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 4]);
  assert.equal(ranked[0].tierLabel, "Regulatory");
  assert.equal(ranked[2].year, 2026);
});

test("groundOrFallback: a clean grounded narrative passes (not fallback)", () => {
  const ranked = rankSources([
    litNode("LIT-PMID-100", "finding A", "PubMed", "2026-01-01T00:00:00Z"),
    litNode("LIT-PMID-200", "finding B", "PubMed", "2025-01-01T00:00:00Z"),
  ]);
  const raw = JSON.stringify({
    narrative: "Two sources agree [LIT-PMID-100] and [LIT-PMID-200].",
    citedNodeIds: ["LIT-PMID-100", "LIT-PMID-200"],
  });
  const out = groundOrFallback(raw, ranked);
  assert.equal(out.isFallback, false);
  assert.deepEqual(out.citedNodeIds.sort(), ["LIT-PMID-100", "LIT-PMID-200"]);
});

test("groundOrFallback: an off-list INLINE citation refuses → deterministic fallback", () => {
  const ranked = rankSources([litNode("LIT-PMID-100", "finding A", "PubMed", "2026-01-01T00:00:00Z")]);
  const raw = JSON.stringify({
    narrative: "Per [LIT-PMID-100] and the fabricated [LIT-PMID-999], X holds.",
    citedNodeIds: ["LIT-PMID-100"], // JSON looks clean, but the inline 999 is off-list
  });
  const out = groundOrFallback(raw, ranked);
  assert.equal(out.isFallback, true);
  // The fallback only restates served summaries — the fabricated id never appears.
  assert.ok(!out.narrative.includes("LIT-PMID-999"));
  assert.deepEqual(out.citedNodeIds, ["LIT-PMID-100"]);
});

test("groundOrFallback: an off-list citedNodeIds entry refuses → fallback", () => {
  const ranked = rankSources([litNode("LIT-PMID-100", "finding A", "PubMed", "2026-01-01T00:00:00Z")]);
  const raw = JSON.stringify({
    narrative: "Per [LIT-PMID-100], X holds.",
    citedNodeIds: ["LIT-PMID-100", "LIT-PMID-555"],
  });
  const out = groundOrFallback(raw, ranked);
  assert.equal(out.isFallback, true);
  assert.ok(!out.citedNodeIds.includes("LIT-PMID-555"));
});
