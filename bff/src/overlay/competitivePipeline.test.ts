/**
 * F8 — the synthetic competitive overlay is grounding-safe. Every overlay node is
 * labelled synthetic and prefixed EXT-PIPE-, and — crucially — NONE of its ids
 * appear in the real graph that builds the citation allow-list (loadValidNodeIds →
 * getFullGraph). So the grounded agent can never cite a synthetic competitor node.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { healthcheck, closeDriver } from "../neo4j.js";
import { getFullGraph } from "../graph/queries.js";
import { getCompetitiveOverlay, COMPETITIVE_ID_PREFIX } from "./competitivePipeline.js";

let neo4jUp = false;
before(async () => {
  neo4jUp = await healthcheck();
});
after(async () => {
  await closeDriver();
});

test("every overlay node is synthetic and EXT-PIPE-prefixed", () => {
  const overlay = getCompetitiveOverlay();
  assert.equal(overlay.synthetic, true);
  assert.ok(overlay.nodes.length > 0);
  for (const n of overlay.nodes) {
    assert.equal(n.synthetic, true, `${n.id} synthetic`);
    assert.ok(n.id.startsWith(COMPETITIVE_ID_PREFIX), `${n.id} prefixed`);
    assert.equal(n.kind, "ExternalPipeline");
  }
  // Every COMPETES_WITH edge points FROM a synthetic node.
  for (const e of overlay.edges) {
    assert.equal(e.kind, "COMPETES_WITH");
    assert.ok(e.source.startsWith(COMPETITIVE_ID_PREFIX), `${e.id} source synthetic`);
  }
});

test("no synthetic overlay id is in the real graph (never citable, F8)", async (t) => {
  if (!neo4jUp) {
    t.skip("Neo4j not reachable");
    return;
  }
  const realIds = new Set((await getFullGraph("all")).nodes.map((n) => n.id));
  const overlay = getCompetitiveOverlay();
  for (const n of overlay.nodes) {
    assert.ok(!realIds.has(n.id), `${n.id} must NOT be in the grounding allow-list`);
  }
});
