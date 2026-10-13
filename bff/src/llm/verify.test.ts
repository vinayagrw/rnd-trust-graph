/**
 * Groundedness guardrail tests. Mirrors narrator.test.ts (node:test + tsx).
 * Run: `node --import tsx --test src/llm/verify.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { groundedness } from "./verify.js";

// The allow-list a real check would build from the active path's node
// labels + ids.
const KNOWN = [
  "AE-MYOCARDITIS",
  "DRUG-CPI",
  "STAT-MYO-CPI",
  "Immune-related myocarditis",
  "Checkpoint inhibitor",
  "PRR",
];

test("fully-grounded text passes", () => {
  const v = groundedness(
    'The "Checkpoint inhibitor" is suspected in immune-related myocarditis; the PRR signal is 4.2.',
    KNOWN
  );
  assert.equal(v.grounded, true);
  assert.deepEqual(v.ungroundedTerms, []);
});

test("an invented entity (Aspirin) is flagged", () => {
  const v = groundedness("It is also linked to Aspirin and Warfarin.", KNOWN);
  assert.equal(v.grounded, false);
  assert.ok(v.ungroundedTerms.includes("Aspirin"));
});

test("ids on the allow-list pass", () => {
  const v = groundedness("Per AE-MYOCARDITIS and DRUG-CPI, the path holds.", KNOWN);
  assert.equal(v.grounded, true);
});
