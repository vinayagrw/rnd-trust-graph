/**
 * Enforced-grounding unit tests — the trust invariant of "graph reasons, LLM
 * narrates". A narration that cites any node NOT on the path must be refused,
 * never shown. Run: `node --import tsx --test src/narrate/narrator.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGrounding, extractJson } from "./narrator.js";

const ALLOWED = ["AE-MYOCARDITIS", "DRUG-CPI", "TGT-PD1", "STAT-MYO-CPI", "EV-FAERS"];

test("accepts a narration that only cites on-path nodes", () => {
  const v = validateGrounding(ALLOWED, {
    narration: "The drug is suspected in myocarditis.",
    citedNodeIds: ["DRUG-CPI", "AE-MYOCARDITIS"],
  });
  assert.equal(v.ok, true);
});

test("REFUSES a narration that cites an off-path (poisoned) node", () => {
  const v = validateGrounding(ALLOWED, {
    narration: "It is also linked to a fabricated condition.",
    citedNodeIds: ["DRUG-CPI", "AE-INVENTED-9999"], // not on the path
  });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "ungrounded");
  assert.deepEqual(v.ok === false && v.offPath, ["AE-INVENTED-9999"]);
});

test("refuses empty narration", () => {
  const v = validateGrounding(ALLOWED, { narration: "   ", citedNodeIds: [] });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "empty-output");
});

test("refuses unparseable / null model output", () => {
  const v = validateGrounding(ALLOWED, null);
  assert.equal(v.ok, false);
});

test("extractJson tolerates code fences and surrounding prose", () => {
  const raw = 'Sure!\n```json\n{"narration":"hi","citedNodeIds":["DRUG-CPI"]}\n```\nDone.';
  const parsed = extractJson(raw);
  assert.equal(parsed?.narration, "hi");
});
