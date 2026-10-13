/**
 * ETL runner — builds the R&D Trust Graph from the curated hero CSVs.
 * Idempotent (everything MERGEs on id), so re-running is safe.
 *
 *   npm run etl   (from repo root)  |  tsx src/etl/run.ts (from bff/)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { read, write, healthcheck, closeDriver } from "../neo4j.js";
import { seedVectors } from "./vector_seed.js";
import { projectCanonicalToNeo4j, projectSafetyToNeo4j } from "./project.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Split a .cypher file into individual statements (terminator = ';').
 *  Safe here because our scripts never use ';' inside string literals. */
function statements(file: string): string[] {
  const raw = readFileSync(join(here, file), "utf-8");
  // Strip // line comments first so a ';' inside a comment can't split a stmt.
  // Quote-aware and ignores '://' (e.g. file:// URLs) so only real comments go.
  const sql = raw
    .split("\n")
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'") inStr = !inStr;
        if (!inStr && c === "/" && line[i + 1] === "/" && line[i - 1] !== ":") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
  return sql
    .split(";")
    .map((s) => s.trim())
    // Keep only statements that have real content once // comments are stripped.
    .filter((s) => s.replace(/\/\/.*$/gm, "").trim().length > 0);
}

async function runFile(file: string): Promise<void> {
  console.log(`\n▶ ${file}`);
  for (const stmt of statements(file)) {
    await write(stmt);
  }
}

async function verify(): Promise<void> {
  const counts = await read<{ label: string; n: number }>(
    `MATCH (n) UNWIND labels(n) AS label
     RETURN label, count(*) AS n ORDER BY label`
  );
  console.log("\n📊 Node counts by label:");
  for (const c of counts) console.log(`   ${c.label.padEnd(18)} ${c.n}`);

  const rels = await read<{ type: string; n: number }>(
    `MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY type`
  );
  console.log("\n🔗 Relationship counts by type:");
  for (const r of rels) console.log(`   ${r.type.padEnd(18)} ${r.n}`);

  // Hero-path assertion — the wow must always be present.
  const path = await read<{ hops: number }>(
    `MATCH p = (ae:AdverseEvent { id: 'AE-MYOCARDITIS' })
       -[:SUSPECTED_IN|TARGETS|IN_PATHWAY*1..4]->(:Pathway)
     RETURN length(p) AS hops LIMIT 1`
  );
  if (path[0]?.hops >= 3) {
    console.log(`\n✅ Hero path present (${path[0].hops} hops to Pathway).`);
  } else {
    console.error("\n❌ Hero path MISSING — demo would fail. Check ETL.");
    process.exitCode = 1;
  }

  // Inferred-edge assertion — the projected reasoner output must be in the cache.
  const inferred = await read<{ n: number }>(
    `MATCH (:Drug)-[r:CANDIDATE_SIGNAL]->(:Pathway) RETURN count(r) AS n`
  );
  if ((inferred[0]?.n ?? 0) >= 3) {
    console.log(`\n✅ Inferred CANDIDATE_SIGNAL edges present (${inferred[0].n}).`);
  } else {
    console.error("\n❌ Inferred CANDIDATE_SIGNAL edges MISSING — projection failed.");
    process.exitCode = 1;
  }

  // UC4 subject-safety assertion — the radar's assessed inventory must be present.
  const subjects = await read<{ n: number }>(
    `MATCH (s:Subject) RETURN count(DISTINCT s) AS n`
  );
  if ((subjects[0]?.n ?? 0) === 10) {
    console.log(`\n✅ UC4 subject-safety graph present (${subjects[0].n} subjects).`);
  } else {
    console.error(
      `\n❌ UC4 subjects MISSING/uneven (${subjects[0]?.n ?? 0}, expected 10) — safety projection failed.`
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (!(await healthcheck())) {
    console.error("❌ Neo4j unreachable. Run `npm run db:up` first.");
    process.exit(1);
  }
  // Schema (constraints + native vector index) still comes from cypher — it is
  // ALCOA+ "Consistent" plumbing, not data.
  await runFile("01_schema.cypher");

  // RDF is now the source of truth: build the canonical reasoner (asserted
  // dataset + ontology, entailment to fixpoint) and PROJECT the asserted +
  // inferred graph into Neo4j. This replaces the legacy CSV-direct node/edge
  // load (02/03_*.cypher) — Neo4j is a projection cache. The projection is
  // label/property/relationship-type identical to the old load and additionally
  // materializes the inferred CANDIDATE_SIGNAL edges. See etl/project.ts.
  console.log("\n▶ project canonical RDF (asserted + inferred) → Neo4j");
  const { nodeCount, edgeCount, inferredCount } = await projectCanonicalToNeo4j();
  console.log(
    `   projected ${nodeCount} nodes, ${edgeCount} edges (${inferredCount} inferred CANDIDATE_SIGNAL).`
  );

  // UC4 subject-safety graph — projected into the SAME Neo4j (tagged :Safety) so
  // the subjects are real, queryable/explainable nodes; the FAIR canvas excludes
  // them. Isolated store, so this cannot change the FAIR projection above.
  console.log("\n▶ project UC4 subject-safety RDF → Neo4j (:Safety)");
  const safety = await projectSafetyToNeo4j();
  console.log(`   projected ${safety.nodeCount} safety nodes, ${safety.edgeCount} edges.`);

  console.log("\n▶ vector seed (Beat 3 embeddings)");
  await seedVectors();
  await verify();
  await closeDriver();
  console.log("\n🎉 ETL complete.\n");
}

main().catch(async (e) => {
  console.error(e);
  await closeDriver();
  process.exit(1);
});
