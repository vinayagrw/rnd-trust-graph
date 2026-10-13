import { test } from "node:test";
import assert from "node:assert/strict";
import { NOT_IN_GRAPH_MARKER, REFUSAL_SUGGESTIONS } from "@rnd/shared";
import { containsRefusal, refusalSuggestions } from "./refusal.js";
test("detects the NOT_IN_GRAPH marker", () => {
  assert.equal(containsRefusal("NOT_IN_GRAPH: no data on X", "NOT_IN_GRAPH:"), true);
  assert.equal(containsRefusal("The signal is 4.2.", "NOT_IN_GRAPH:"), false);
});
test("offers at least one in-graph suggestion", () => {
  assert.ok(refusalSuggestions().length >= 1);
});
test("bff refusal path stays in parity with the @rnd/shared single source", () => {
  assert.equal(containsRefusal("NOT_IN_GRAPH: x", NOT_IN_GRAPH_MARKER), true);
  assert.deepEqual(refusalSuggestions(), [...REFUSAL_SUGGESTIONS]);
});
