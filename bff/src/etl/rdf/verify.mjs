/**
 * Standalone in-process verifier for the canonical RDF dataset (Phase 1a).
 *
 *   node src/etl/rdf/verify.mjs        (from bff/, after `tsx src/etl/rdf/generate.ts`)
 *
 * Loads data/rdf/dataset.generated.ttl into an Oxigraph Store (SPARQL) and into
 * rdf-ext datasets (SHACL via shacl-engine), then ASSERTS:
 *   (a) live SHACL flags EXACTLY {DRUG-ORPHAN, CON-STALE, TGT-NOPROV, AE-CONFLICT};
 *   (b) the hero path AE-MYOCARDITIS →SUSPECTED_IN→ DRUG-CPI →TARGETS→ TGT-PDCD1
 *       →IN_PATHWAY→ PW-CHECKPOINT exists (3 hops);
 *   (c) the AE-MYOCARDITIS case series (REPORTS) is >= 6;
 *   (d) the candidate-signal rule (Drug TARGETS Target IN_PATHWAY Pathway ⟹
 *       rtg:CANDIDATE_SIGNAL) materializes via SPARQL INSERT...WHERE.
 *
 * Exit code 0 iff every assertion passes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import * as oxi from "oxigraph";
import rdf from "rdf-ext";
import ParserN3 from "@rdfjs/parser-n3";
import { Validator } from "shacl-engine";
import { validations as sparqlValidations, targetResolvers as sparqlTargetResolvers } from "shacl-engine/sparql.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "..", "..", "..", "data");
const ttlPath = join(DATA_DIR, "rdf", "dataset.generated.ttl");
const shapesPath = join(DATA_DIR, "shacl", "shapes.ttl");

const NS = "https://vinayagrw.github.io/rnd-trust-graph#";
const dataTtl = readFileSync(ttlPath, "utf-8");
const shapesTtl = readFileSync(shapesPath, "utf-8");

// --- helpers ----------------------------------------------------------------
const short = (iri) => (iri.startsWith(NS) ? iri.slice(NS.length) : iri);
async function toDataset(ttl) {
  return rdf.dataset().import(new ParserN3({ factory: rdf }).import(Readable.from(ttl)));
}

let failures = 0;
function assert(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
async function main() {
  // Load into Oxigraph for SPARQL.
  const store = new oxi.Store();
  store.load(dataTtl, { format: "text/turtle" });

  // ===== (a) SHACL — exactly the 4 noise nodes flag =========================
  const shapesDs = await toDataset(shapesTtl);
  const dataDs = await toDataset(dataTtl);
  const validator = new Validator(shapesDs, {
    factory: rdf,
    validations: sparqlValidations,
    targetResolvers: sparqlTargetResolvers,
  });
  const report = await validator.validate({ dataset: dataDs });

  const flagged = new Set();
  for (const r of report.results) {
    const fn = r.focusNode;
    if (fn && fn.value) flagged.add(short(fn.value));
  }
  const expected = [
    "AE-CONFLICT",
    "CON-STALE",
    "DRUG-ORPHAN",
    "STAT-DUP-A",
    "STAT-DUP-B",
    "STAT-NOFOLLOWUP",
    "TGT-NOPROV",
  ];
  const got = [...flagged].sort();
  assert(
    "(a) SHACL flags EXACTLY the 7 noise nodes",
    JSON.stringify(got) === JSON.stringify(expected),
    `conforms=${report.conforms}; flagged={${got.join(", ")}}`
  );

  // ===== (b) hero path = 3 hops ============================================
  const heroRows = store.query(`
    PREFIX rtg: <${NS}>
    ASK {
      rtg:AE-MYOCARDITIS rtg:SUSPECTED_IN rtg:DRUG-CPI .
      rtg:DRUG-CPI       rtg:TARGETS      rtg:TGT-PDCD1 .
      rtg:TGT-PDCD1      rtg:IN_PATHWAY   rtg:PW-CHECKPOINT .
    }`);
  // Count the hops along the pinned chain via a property-path length query.
  const hopRows = store.query(`
    PREFIX rtg: <${NS}>
    SELECT (COUNT(*) AS ?hops) WHERE {
      VALUES (?a ?p ?b) {
        (rtg:AE-MYOCARDITIS rtg:SUSPECTED_IN rtg:DRUG-CPI)
        (rtg:DRUG-CPI       rtg:TARGETS      rtg:TGT-PDCD1)
        (rtg:TGT-PDCD1      rtg:IN_PATHWAY   rtg:PW-CHECKPOINT)
      }
      ?a ?p ?b .
    }`);
  const hops = Number(hopRows[0]?.get("hops")?.value ?? 0);
  assert("(b) hero path AE→DRUG→TGT→PW exists with 3 hops", heroRows === true && hops === 3, `hops=${hops}`);

  // ===== (c) AE-MYOCARDITIS case series >= 6 ===============================
  const caseRows = store.query(`
    PREFIX rtg: <${NS}>
    SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE {
      ?p rtg:REPORTS rtg:AE-MYOCARDITIS .
    }`);
  const cases = Number(caseRows[0]?.get("n")?.value ?? 0);
  assert("(c) AE-MYOCARDITIS case series >= 6", cases >= 6, `cases=${cases}`);

  // ===== (d) candidate-signal rule materializes via INSERT...WHERE =========
  const beforeRows = store.query(`
    PREFIX rtg: <${NS}>
    SELECT (COUNT(*) AS ?n) WHERE { ?d rtg:CANDIDATE_SIGNAL ?pw }`);
  const before = Number(beforeRows[0]?.get("n")?.value ?? 0);

  store.update(`
    PREFIX rtg: <${NS}>
    INSERT { ?drug rtg:CANDIDATE_SIGNAL ?pathway }
    WHERE {
      ?drug   rtg:TARGETS    ?target .
      ?target rtg:IN_PATHWAY ?pathway .
    }`);

  const afterRows = store.query(`
    PREFIX rtg: <${NS}>
    SELECT ?drug ?pathway WHERE { ?drug rtg:CANDIDATE_SIGNAL ?pathway } ORDER BY ?drug`);
  const after = afterRows.length;
  const cpiDerived = store.query(`
    PREFIX rtg: <${NS}>
    ASK { rtg:DRUG-CPI rtg:CANDIDATE_SIGNAL rtg:PW-CHECKPOINT }`);
  assert(
    "(d) candidate-signal rule materializes (DRUG TARGETS·IN_PATHWAY ⟹ CANDIDATE_SIGNAL)",
    before === 0 && after > 0 && cpiDerived === true,
    `before=${before}, after=${after}, DRUG-CPI→PW-CHECKPOINT entailed=${cpiDerived}`
  );
  if (after > 0) {
    const sample = afterRows
      .slice(0, 5)
      .map((r) => `${short(r.get("drug").value)}→${short(r.get("pathway").value)}`)
      .join(", ");
    console.log(`       derived: ${sample}${after > 5 ? `, … (${after} total)` : ""}`);
  }

  // --- summary --------------------------------------------------------------
  console.log("");
  if (failures === 0) {
    console.log("ALL ASSERTIONS PASS ✅");
    process.exit(0);
  } else {
    console.error(`${failures} ASSERTION(S) FAILED ❌`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
