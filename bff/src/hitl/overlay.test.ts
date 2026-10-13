/**
 * Overlay key round-trip tests (no Neo4j needed — pure in-memory overlay).
 *
 * Guards the bug where the (nodeId, flag) key was JOINED with one separator but
 * resolvedPairs() SPLIT on another (an ASCII space vs an invisible byte),
 * silently producing malformed pairs. Both now reference the single `SEP`, so a
 * mark → resolvedPairs round-trip must return the exact pair.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  markFlagResolved,
  resolvedPairs,
  resetOverlay,
  markEdgeTag,
  clearEdgeTag,
  edgeTagsFor,
} from "./overlay.js";

beforeEach(() => resetOverlay());

test("resolvedPairs round-trips a single (nodeId, flag) pair", () => {
  markFlagResolved("TGT-NOPROV", "missing-provenance");
  assert.deepEqual(resolvedPairs(), [{ nodeId: "TGT-NOPROV", flag: "missing-provenance" }]);
});

test("resolvedPairs round-trips a hyphenated flag intact (no truncation)", () => {
  markFlagResolved("DRUG-ORPHAN", "missing-cross-source-link");
  const [pair] = resolvedPairs();
  assert.equal(pair.nodeId, "DRUG-ORPHAN");
  // The hyphenated flag must come back whole — the split must not break on hyphens.
  assert.equal(pair.flag, "missing-cross-source-link");
});

test("resolvedPairs returns every distinct pair, deduped by key", () => {
  markFlagResolved("STAT-DUP-A", "duplicate-record");
  markFlagResolved("STAT-DUP-B", "duplicate-record");
  markFlagResolved("STAT-DUP-A", "duplicate-record"); // idempotent — same key
  const pairs = resolvedPairs().sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  assert.deepEqual(pairs, [
    { nodeId: "STAT-DUP-A", flag: "duplicate-record" },
    { nodeId: "STAT-DUP-B", flag: "duplicate-record" },
  ]);
});

test("edge tag: mark → edgeTagsFor → clear round-trips on the exact triple", () => {
  markEdgeTag("DRUG-X", "TARGETS", "TGT-Y", "off-target");
  assert.deepEqual(edgeTagsFor("DRUG-X", "TARGETS", "TGT-Y"), ["off-target"]);
  // A different triple (same nodes, different kind) is unaffected — key is directed+typed.
  assert.deepEqual(edgeTagsFor("DRUG-X", "SUSPECTED_IN", "TGT-Y"), []);
  clearEdgeTag("DRUG-X", "TARGETS", "TGT-Y", "off-target");
  assert.deepEqual(edgeTagsFor("DRUG-X", "TARGETS", "TGT-Y"), []);
});

test("edge tag: multiple tags on one edge, idempotent per tag", () => {
  markEdgeTag("AE-A", "HAS_STAT", "STAT-B", "review");
  markEdgeTag("AE-A", "HAS_STAT", "STAT-B", "priority");
  markEdgeTag("AE-A", "HAS_STAT", "STAT-B", "review"); // idempotent — same tag text
  assert.deepEqual(edgeTagsFor("AE-A", "HAS_STAT", "STAT-B").sort(), ["priority", "review"]);
});

test("resetOverlay wipes edge tags too", () => {
  markEdgeTag("DRUG-X", "TARGETS", "TGT-Y", "off-target");
  resetOverlay();
  assert.deepEqual(edgeTagsFor("DRUG-X", "TARGETS", "TGT-Y"), []);
});
