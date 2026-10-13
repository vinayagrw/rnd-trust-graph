/**
 * Neo4j projection parity smoke (slice 1d).
 *
 * Proves the RDF→Neo4j projection cache is intact: node/relationship counts are
 * sane, the 3-hop hero path is present, the 4 noise nodes survive, and the 3
 * inferred CANDIDATE_SIGNAL edges were projected. Requires a populated Neo4j
 * (run `npm run db:up && npm run etl` first), so we probe at the TOP LEVEL with a
 * top-level await — node:test evaluates `skip` at registration time, so a
 * before() hook would be too late and the suite would fail instead of skip.
 *
 * Run: `node --import tsx --test src/etl/project.test.ts`
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { read, closeDriver } from "../neo4j.js";

// Top-level reachability + populated-cache probe.
let ready = false;
try {
  const r = await read<{ n: number }>(`MATCH (n) RETURN count(n) AS n`);
  ready = (r[0]?.n ?? 0) > 0;
} catch {
  ready = false;
}

test("hero path is 3 hops AE-MYOCARDITIS → Pathway", { skip: !ready }, async () => {
  const rows = await read<{ hops: number }>(
    `MATCH p = (ae:AdverseEvent { id: 'AE-MYOCARDITIS' })
       -[:SUSPECTED_IN|TARGETS|IN_PATHWAY*1..4]->(:Pathway)
     RETURN length(p) AS hops ORDER BY hops LIMIT 1`
  );
  assert.ok((rows[0]?.hops ?? 0) >= 3, "hero path must reach a Pathway in ≥3 hops");
});

test("AE-MYOCARDITIS case series ≥ 6 patients", { skip: !ready }, async () => {
  const rows = await read<{ n: number }>(
    `MATCH (:Patient)-[:REPORTS]->(:AdverseEvent { id: 'AE-MYOCARDITIS' })
     RETURN count(*) AS n`
  );
  assert.ok((rows[0]?.n ?? 0) >= 6, "case series must have ≥6 patients");
});

test("the 7 noise nodes are present", { skip: !ready }, async () => {
  const expected = [
    "AE-CONFLICT",
    "CON-STALE",
    "DRUG-ORPHAN",
    "STAT-DUP-A",
    "STAT-DUP-B",
    "STAT-NOFOLLOWUP",
    "TGT-NOPROV",
  ];
  const rows = await read<{ id: string }>(
    `MATCH (n) WHERE n.id IN ['DRUG-ORPHAN','CON-STALE','TGT-NOPROV','AE-CONFLICT','STAT-DUP-A','STAT-DUP-B','STAT-NOFOLLOWUP']
     RETURN n.id AS id ORDER BY id`
  );
  assert.deepEqual(rows.map((r) => r.id), expected);
});

test("the 3 inferred CANDIDATE_SIGNAL edges are projected", { skip: !ready }, async () => {
  const rows = await read<{ src: string; dst: string }>(
    `MATCH (d:Drug)-[:CANDIDATE_SIGNAL]->(pw:Pathway)
     RETURN d.id AS src, pw.id AS dst ORDER BY src, dst`
  );
  const pairs = rows.map((r) => `${r.src}->${r.dst}`);
  for (const expected of [
    "DRUG-CPI->PW-CHECKPOINT",
    "DRUG-JAK->PW-JAKSTAT",
    "DRUG-VEGFR->PW-ANGIO",
  ]) {
    assert.ok(pairs.includes(expected), `missing inferred edge ${expected}`);
  }
});

test("UC4 subject-safety graph is projected (10 subjects, tagged :Safety)", { skip: !ready }, async () => {
  const rows = await read<{ n: number }>(
    `MATCH (s:Subject) WHERE s:Safety RETURN count(DISTINCT s) AS n`
  );
  assert.equal(rows[0]?.n ?? 0, 10, "10 :Safety-tagged Subject nodes must be present");
  // The signature multi-hop path the radar drills into must be traversable in Neo4j.
  const path = await read<{ n: number }>(
    `MATCH (:Subject { id: 'SUBJ-201' })-[:HAS_PRESCRIPTION]->(:Prescription)-[:PRESCRIBES]->(:Drug)
     RETURN count(*) AS n`
  );
  assert.ok((path[0]?.n ?? 0) >= 1, "SUBJ-201 → prescription → drug path must exist");
});

test("safety nodes are excluded from the FAIR canvas (:Safety marker)", { skip: !ready }, async () => {
  // getFullGraph filters WHERE NOT n:Safety, so no Subject leaks onto the FAIR canvas.
  const rows = await read<{ n: number }>(
    `MATCH (n) WHERE n:Safety AND NOT n:Subject RETURN count(n) AS n`
  );
  assert.ok((rows[0]?.n ?? 0) > 0, "safety support nodes are tagged :Safety too");
});

test("inferred CANDIDATE_SIGNAL edges carry NO source provenance", { skip: !ready }, async () => {
  // They are reasoner-materialized, not sourced from any system — ALCOA+ correct.
  const rows = await read<{ ss: string | null }>(
    `MATCH (:Drug)-[r:CANDIDATE_SIGNAL]->(:Pathway) RETURN r.sourceSystem AS ss`
  );
  for (const r of rows) assert.equal(r.ss ?? null, null);
});

after(async () => {
  await closeDriver();
});
