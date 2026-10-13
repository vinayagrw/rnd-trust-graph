/**
 * Reasoner adapter tests (oxigraph backend).
 *
 * Self-contained: an inline Drug→Target→Pathway slice with provenance on the
 * first edge and DELIBERATELY MISSING provenance on a second drug node. Asserts:
 *   1. SPARQL SELECT returns the Drug→Target→Pathway path.
 *   2. entail() materializes an inferred candidate-signal triple
 *      (ASK is false before, true after).
 *   3. validateShacl() returns conforms:false with the provenance-missing node
 *      among the violations.
 *
 * Run: `node --import tsx --test src/reasoner/reasoner.test.ts`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getReasoner } from "./index.js";

const RTG = "https://rnd-trust-graph.example/";

/** Drug→Target→Pathway slice. DRUG-A is fully provenanced; DRUG-B is missing it. */
const DATA_TTL = `
@prefix rtg: <${RTG}> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

rtg:DRUG-A  a rtg:Drug ;
            rtg:hasProvenance "PMID:111" ;
            rtg:targets rtg:TARGET-1 .
rtg:DRUG-B  a rtg:Drug ;
            rtg:targets rtg:TARGET-1 .
rtg:TARGET-1 a rtg:Target ;
             rtg:participatesIn rtg:PATHWAY-X .
rtg:PATHWAY-X a rtg:Pathway .
`;

/** A SHACL shape: every rtg:Drug MUST carry at least one rtg:hasProvenance. */
const SHAPES_TTL = `
@prefix rtg: <${RTG}> .
@prefix sh:  <http://www.w3.org/ns/shacl#> .

rtg:DrugProvenanceShape a sh:NodeShape ;
  sh:targetClass rtg:Drug ;
  sh:property [
    sh:path rtg:hasProvenance ;
    sh:minCount 1 ;
    sh:message "Drug node is missing required provenance" ;
  ] .
`;

/** Forward-chaining rule: a Drug reaching a Pathway through a Target is a
 *  candidate signal. Materializes rtg:candidateSignalFor triples. */
const ENTAIL_RULE = `
PREFIX rtg: <${RTG}>
INSERT {
  ?drug rtg:candidateSignalFor ?pathway .
}
WHERE {
  ?drug rtg:targets ?target .
  ?target rtg:participatesIn ?pathway .
}
`;

test("oxigraph: SELECT returns the Drug→Target→Pathway path", async () => {
  const r = await getReasoner("oxigraph");
  r.load(DATA_TTL);

  const rows = await r.sparqlSelect(`
    PREFIX rtg: <${RTG}>
    SELECT ?drug ?target ?pathway WHERE {
      ?drug a rtg:Drug ;
            rtg:targets ?target .
      ?target rtg:participatesIn ?pathway .
    } ORDER BY ?drug
  `);

  assert.ok(rows.length >= 1, "expected at least one Drug→Target→Pathway row");
  const drugA = rows.find((x) => x.drug === `${RTG}DRUG-A`);
  assert.ok(drugA, "DRUG-A path should be present");
  assert.equal(drugA!.target, `${RTG}TARGET-1`);
  assert.equal(drugA!.pathway, `${RTG}PATHWAY-X`);
});

test("oxigraph: entail() materializes an inferred candidate-signal triple (ASK false→true)", async () => {
  const r = await getReasoner("oxigraph");
  r.load(DATA_TTL);

  const askQuery = `
    PREFIX rtg: <${RTG}>
    ASK { rtg:DRUG-A rtg:candidateSignalFor rtg:PATHWAY-X }
  `;

  const before = await r.sparqlAsk(askQuery);
  assert.equal(before, false, "candidate-signal must NOT exist before entailment");

  r.entail(ENTAIL_RULE);

  const after = await r.sparqlAsk(askQuery);
  assert.equal(after, true, "candidate-signal MUST be materialized after entailment");
});

test("oxigraph: validateShacl() flags the provenance-missing node", async () => {
  const r = await getReasoner("oxigraph");
  r.load(DATA_TTL);

  const report = await r.validateShacl(SHAPES_TTL);

  assert.equal(report.conforms, false, "data must NOT conform (DRUG-B lacks provenance)");
  const focusNodes = report.violations.map((v) => v.focusNode);
  assert.ok(
    focusNodes.includes(`${RTG}DRUG-B`),
    `DRUG-B should be a violation focus node; got ${JSON.stringify(focusNodes)}`,
  );
  // DRUG-A is fully provenanced and must NOT appear as a violation.
  assert.ok(
    !focusNodes.includes(`${RTG}DRUG-A`),
    "DRUG-A is provenanced and must not be flagged",
  );
});
