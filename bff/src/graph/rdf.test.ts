/**
 * Canonical RDF/Turtle serialization tests — the W3C/RDF cameo guard.
 *
 * Slice 1d: the data now comes from the CANONICAL reasoner store (asserted +
 * inferred), NOT from Neo4j, so these no longer need a database. The reasoner is
 * in-process (oxigraph WASM), so the suite always runs.
 *
 * Run: `node --import tsx --test src/graph/rdf.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { heroGraphToTurtle, dumpCanonicalTurtle, constructToTurtle } from "./rdf.js";

const NS = "https://vinayagrw.github.io/rnd-trust-graph#";

test("serializes the canonical graph to non-empty Turtle", async () => {
  const ttl = await heroGraphToTurtle();
  assert.ok(ttl.length > 0, "Turtle output should be non-empty");
});

test("emits a @prefix block", async () => {
  const ttl = await heroGraphToTurtle();
  assert.match(ttl, /@prefix/);
});

test("includes the hero adverse-event subject AE-MYOCARDITIS", async () => {
  const ttl = await heroGraphToTurtle();
  assert.ok(ttl.includes(`${NS}AE-MYOCARDITIS`), "should contain the AE-MYOCARDITIS IRI");
});

test("emits the SUSPECTED_IN predicate", async () => {
  const ttl = await heroGraphToTurtle();
  assert.ok(ttl.includes(`${NS}SUSPECTED_IN`), "should contain a SUSPECTED_IN predicate");
});

test("includes the INFERRED CANDIDATE_SIGNAL triples (asserted+inferred dump)", async () => {
  const ttl = await dumpCanonicalTurtle();
  assert.ok(ttl.includes(`${NS}CANDIDATE_SIGNAL`), "should contain inferred CANDIDATE_SIGNAL");
});

test("CONSTRUCT round-trips through the canonical store", async () => {
  const ttl = await constructToTurtle(
    `PREFIX rtg: <${NS}>
     CONSTRUCT { ?d rtg:CANDIDATE_SIGNAL ?pw }
     WHERE { ?d rtg:CANDIDATE_SIGNAL ?pw }`
  );
  assert.ok(ttl.includes("CANDIDATE_SIGNAL"), "CONSTRUCT should return the candidate-signal edges");
});
