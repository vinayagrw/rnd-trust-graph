/**
 * F3 — adaptive routing classification table (pure, no Neo4j). Asserts the lexical
 * router maps similarity questions to the vector path, relational questions to a
 * Cypher traversal, mixed to hybrid, and an ambiguous question to the safe default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./router.js";

test("classify routes similarity questions to vector-resolve", () => {
  assert.equal(classify("Which images look like this lesion?"), "vector-resolve");
  assert.equal(classify("Find nodes similar to AE-MYOCARDITIS"), "vector-resolve");
  assert.equal(classify("What is the nearest concept to this profile?"), "vector-resolve");
});

test("classify routes relational questions to cypher-traversal", () => {
  assert.equal(classify("Why is the checkpoint inhibitor linked to myocarditis?"), "cypher-traversal");
  assert.equal(classify("How does the drug cause the adverse event?"), "cypher-traversal");
  assert.equal(classify("What evidence supports the signal?"), "cypher-traversal");
});

test("classify routes mixed similarity+relational questions to hybrid", () => {
  assert.equal(
    classify("What drugs are similar to this one and why are they linked to the same AE?"),
    "hybrid",
  );
});

test("classify defaults an ambiguous question to a graph traversal", () => {
  assert.equal(classify("Tell me about the dataset"), "cypher-traversal");
});
