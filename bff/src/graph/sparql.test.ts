/**
 * Read-only SPARQL guard tests (slice 1d).
 *
 * The reasoner is in-process (oxigraph WASM), so these always run — no DB needed.
 * Run: `node --import tsx --test src/graph/sparql.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sparqlSelectReadOnly,
  assertReadOnlySparql,
  SparqlWriteRejectedError,
} from "./sparql.js";

const NS = "https://vinayagrw.github.io/rnd-trust-graph#";

test("allows a SELECT and returns rows", async () => {
  const res = await sparqlSelectReadOnly(
    `PREFIX rtg: <${NS}>
     SELECT ?d ?pw WHERE { ?d rtg:CANDIDATE_SIGNAL ?pw } LIMIT 5`
  );
  assert.equal(res.kind, "select");
  if (res.kind === "select") {
    assert.ok(res.rows.length >= 3, "should see the inferred candidate-signal rows");
  }
});

test("allows an ASK and returns a boolean", async () => {
  const res = await sparqlSelectReadOnly(
    `PREFIX rtg: <${NS}>
     ASK { rtg:DRUG-CPI rtg:CANDIDATE_SIGNAL rtg:PW-CHECKPOINT }`
  );
  assert.equal(res.kind, "ask");
  if (res.kind === "ask") assert.equal(res.boolean, true);
});

test("rejects an INSERT", async () => {
  await assert.rejects(
    () =>
      sparqlSelectReadOnly(
        `PREFIX rtg: <${NS}> INSERT DATA { rtg:X rtg:Y rtg:Z }`
      ),
    SparqlWriteRejectedError
  );
});

test("rejects a DELETE", async () => {
  await assert.rejects(
    () =>
      sparqlSelectReadOnly(
        `PREFIX rtg: <${NS}> DELETE WHERE { ?s ?p ?o }`
      ),
    SparqlWriteRejectedError
  );
});

test("rejects DROP / CLEAR / LOAD via the guard directly", () => {
  assert.throws(() => assertReadOnlySparql("DROP GRAPH <x>"), SparqlWriteRejectedError);
  assert.throws(() => assertReadOnlySparql("CLEAR ALL"), SparqlWriteRejectedError);
  assert.throws(() => assertReadOnlySparql("LOAD <http://x/>"), SparqlWriteRejectedError);
});

test("does NOT false-trip on a forbidden keyword inside a string literal or comment", () => {
  // 'INSERT' here is data, not an operation — must be allowed.
  assert.doesNotThrow(() =>
    assertReadOnlySparql(
      `SELECT ?s WHERE { ?s rdfs:label "we should INSERT nothing" }  # DELETE is fine in a comment`
    )
  );
});
