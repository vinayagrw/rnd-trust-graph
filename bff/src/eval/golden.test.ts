/**
 * Text2Cypher golden execution-accuracy harness.
 *
 * GxP/QA asks "how do you monitor and re-validate that the system still returns
 * the right answers over the live graph?" — this is that harness. Each check
 * runs canonical Cypher (derived from scripts/verify.cypher) against the LIVE
 * Neo4j and asserts the EXACT expected value. Runnable in CI.
 *
 * The whole suite SKIPS cleanly (does not fail) when Neo4j is unreachable, so a
 * laptop without the DB up still passes CI. The driver carries its own timeout,
 * so the `RETURN 1` probe in `before` cannot hang the run.
 *
 * Run: `node --import tsx --test src/eval/golden.test.ts`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { read, closeDriver } from "../neo4j.js";

// Reachability probe at MODULE LOAD (top-level await) — NOT in a before() hook.
// node:test evaluates each test's `{ skip }` option at registration time, which
// runs before before() hooks; probing here means `skip` reflects the real DB
// state. DB down → every check skips cleanly (CI stays green on a bare laptop).
let neo4jUp = false;
try {
  await read("RETURN 1 AS ok"); // driver carries its own timeout; cannot hang
  neo4jUp = true;
} catch {
  neo4jUp = false;
}

after(async () => {
  await closeDriver();
});

// 1. The hero AE has a 6-patient case series. (verify.cypher #3)
test("hero AE-MYOCARDITIS is reported by exactly 6 distinct patients", { skip: !neo4jUp }, async () => {
  const rows = await read<{ cases: number }>(
    `MATCH (p:Patient)-[:REPORTS]->(:AdverseEvent { id:'AE-MYOCARDITIS' })
     RETURN count(DISTINCT p) AS cases`
  );
  assert.equal(rows[0]?.cases, 6);
});

// 2. The deterministic mechanism path exists: AE -> Drug -> Target -> Pathway. (verify.cypher #2)
test("mechanism path AE→Drug→Target→Pathway resolves to DRUG-CPI with 3 hops", { skip: !neo4jUp }, async () => {
  const rows = await read<{ hops: number; drug: string }>(
    `MATCH p = (:AdverseEvent { id:'AE-MYOCARDITIS' })-[:SUSPECTED_IN]->(d:Drug)
               -[:TARGETS]->(:BiologicalTarget)-[:IN_PATHWAY]->(:Pathway)
     RETURN length(p) AS hops, d.id AS drug`
  );
  assert.equal(rows[0]?.hops, 3);
  assert.equal(rows[0]?.drug, "DRUG-CPI");
});

// 3. The SignalStat carries the canonical disproportionality value PRR 4.2.
//    PRR is stored in attrsRaw as "prr=4.2;ror=...;..." — extract and assert exactly.
test("SignalStat STAT-MYO-CPI carries PRR 4.2", { skip: !neo4jUp }, async () => {
  const rows = await read<{ attrs: string }>(
    `MATCH (s:SignalStat { id:'STAT-MYO-CPI' }) RETURN s.attrsRaw AS attrs`
  );
  const prr = rows[0]?.attrs?.match(/prr=([\d.]+)/)?.[1];
  assert.equal(prr, "4.2");
});

// 4. The signal is supported by source evidence (SUPPORTED_BY → Evidence). (verify.cypher #4-relative)
test("STAT-MYO-CPI is SUPPORTED_BY at least 2 evidence sources", { skip: !neo4jUp }, async () => {
  const rows = await read<{ ev: number }>(
    `MATCH (:SignalStat { id:'STAT-MYO-CPI' })-[:SUPPORTED_BY]->(e:Evidence)
     RETURN count(e) AS ev`
  );
  assert.equal(rows[0]?.ev, 2); // EV-FAERS + EV-PMID
});
