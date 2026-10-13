/**
 * CSV -> RDF generator. Reads data/import/*.csv and emits the FULL R&D Trust
 * Graph dataset as Turtle (data/rdf/dataset.generated.ttl), making RDF the
 * CANONICAL source of truth.
 *
 *   tsx src/etl/rdf/generate.ts            (from bff/)
 *
 * Every triple carries PROV-O provenance: rtg:sourceSystem, an ISO-8601
 * rtg:timestamp / prov:generatedAtTime, dcterms:license, and (where coded)
 * rtg:ontologyVersion. The vocabulary matches data/rdf/hero.ttl EXACTLY
 * (UPPER_SNAKE relation IRIs, rtg: namespace, PROV-O wasDerivedFrom).
 *
 * The deliberate "noise" nodes (data/import/nodes_noise.csv) are emitted with
 * their defects intact, so they — and ONLY they — violate the SHACL shapes:
 *   DRUG-ORPHAN      no TARGETS link  + license "unknown"
 *   CON-STALE        ontologyVersion 2019-01 (< 2023)
 *   TGT-NOPROV       no sourceSystem / timestamp / license
 *   AE-CONFLICT      shares code OAE_0001489 with AE-MYOCARDITIS (conflicting)
 *   STAT-DUP-A/-B    two SignalStats share code FAERS-DUP-0001 (duplicate record)
 *   STAT-NOFOLLOWUP  escalated SignalStat with no REVIEWED_BY follow-up edge
 *
 * Idempotent: pure function of the CSVs, regenerable on every run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = join(here, "..", "..", "..", "..", "data", "import");
const OUT_FILE = join(here, "..", "..", "..", "..", "data", "rdf", "dataset.generated.ttl");

const NS = "https://vinayagrw.github.io/rnd-trust-graph#";
const ONTOLOGY_VERSION_MIN = 2023; // generator self-check floor (informational)

// --- tiny CSV reader (no quoted-comma fields in this dataset) ---------------
function parseCsv(file: string): Record<string, string>[] {
  const raw = readFileSync(join(IMPORT_DIR, file), "utf-8").replace(/\r\n/g, "\n").trim();
  const lines = raw.split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    // attrs is always the LAST column and may itself contain ';' (never ',').
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      // Re-join any overflow into the final column (defensive; data has no stray commas).
      row[h.trim()] =
        i === headers.length - 1 ? cells.slice(i).join(",").trim() : (cells[i] ?? "").trim();
    });
    return row;
  });
}

// --- Turtle helpers ---------------------------------------------------------
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const iri = (id: string) => `rtg:${id}`;
const str = (s: string) => `"${esc(s)}"`;
const dt = (s: string) => `"${s}"^^xsd:dateTime`;
const dec = (s: string) => `"${s}"^^xsd:decimal`;

/** Parse "k=v;k2=v2" attrs into a record. */
function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

/** xsd:decimal-typed attr keys on SignalStat / GeneticAssociation. */
const DECIMAL_ATTRS = new Set(["prr", "ror", "chi2", "cases", "records", "otScore"]);
/** attr keys we emit as first-class datatype properties (others skipped). */
const ATTR_PROPS: Record<string, string> = {
  class: "rtg:class",
  symbol: "rtg:symbol",
  prr: "rtg:prr",
  ror: "rtg:ror",
  chi2: "rtg:chi2",
  ci: "rtg:ci",
  cases: "rtg:cases",
  records: "rtg:records",
  otScore: "rtg:otScore",
  efo: "rtg:efo",
  section: "rtg:section",
  summary: "rtg:summary",
  url: "rtg:url",
  status: "rtg:status", // curation status, e.g. "refuted" (used by the conflict shape)
};

/** Edge type (UPPER_SNAKE) -> predicate IRI. Identity map: same vocabulary. */
const edgePredicate = (type: string) => `rtg:${type}`;

function nodeTriples(row: Record<string, string>): string {
  const lines: string[] = [];
  lines.push(`${iri(row.id)} a rtg:${row.kind} ;`);
  const body: string[] = [];
  if (row.label) body.push(`    rdfs:label ${str(row.label)}`);
  if (row.code) body.push(`    rtg:code ${str(row.code)}`);
  if (row.vocab) body.push(`    rtg:vocab ${str(row.vocab)}`);

  // PROV-O provenance triad. Emitted ONLY when present in the CSV — TGT-NOPROV
  // has blank source_system/license/timestamp, so it stays defective on purpose.
  if (row.source_system) {
    body.push(`    prov:wasDerivedFrom ${str(row.source_system)}`);
    body.push(`    rtg:sourceSystem ${str(row.source_system)}`);
  }
  if (row.ontology_version) body.push(`    rtg:ontologyVersion ${str(row.ontology_version)}`);
  if (row.timestamp) {
    body.push(`    rtg:timestamp ${dt(row.timestamp)}`);
    body.push(`    prov:generatedAtTime ${dt(row.timestamp)}`);
  }
  if (row.license) body.push(`    dcterms:license ${str(row.license)}`);

  // Typed attributes (k=v;...).
  const attrs = parseAttrs(row.attrs ?? "");
  for (const [k, v] of Object.entries(attrs)) {
    const pred = ATTR_PROPS[k];
    if (!pred || v === "") continue;
    body.push(`    ${pred} ${DECIMAL_ATTRS.has(k) ? dec(v) : str(v)}`);
  }

  lines.push(body.join(" ;\n") + " .");
  return lines.join("\n");
}

function patientTriples(row: Record<string, string>): string {
  const body: string[] = [`${iri(row.id)} a rtg:Patient ;`];
  const parts: string[] = [];
  if (row.label) parts.push(`    rdfs:label ${str(row.label)}`);
  if (row.gender) parts.push(`    rtg:gender ${str(row.gender)}`);
  if (row.birthdate) parts.push(`    rtg:birthdate ${str(row.birthdate)}`);
  if (row.source_system) {
    parts.push(`    prov:wasDerivedFrom ${str(row.source_system)}`);
    parts.push(`    rtg:sourceSystem ${str(row.source_system)}`);
  }
  if (row.timestamp) {
    parts.push(`    rtg:timestamp ${dt(row.timestamp)}`);
    parts.push(`    prov:generatedAtTime ${dt(row.timestamp)}`);
  }
  if (row.license) parts.push(`    dcterms:license ${str(row.license)}`);
  body.push(parts.join(" ;\n") + " .");
  return body.join("\n");
}

function main(): void {
  const nodes = parseCsv("nodes.csv");
  const noise = parseCsv("nodes_noise.csv");
  const patients = parseCsv("patients.csv");
  const edges = parseCsv("edges.csv");

  // Generator self-check: warn (do not fail) if a NON-noise node looks stale, so
  // the deliberate CON-STALE remains the only currency violation in the output.
  const noiseIds = new Set(noise.map((n) => n.id));
  for (const n of nodes) {
    const yr = Number((n.ontology_version || "").slice(0, 4));
    if (yr && yr < ONTOLOGY_VERSION_MIN && !noiseIds.has(n.id)) {
      console.warn(`⚠ unexpected stale ontologyVersion on ${n.id}: ${n.ontology_version}`);
    }
  }

  const out: string[] = [];
  out.push("# =============================================================================");
  out.push("# R&D Trust Graph — FULL dataset, generated from data/import/*.csv.");
  out.push("# DO NOT EDIT BY HAND — regenerate via: tsx src/etl/rdf/generate.ts");
  out.push("# Canonical RDF source of truth. Vocabulary matches data/rdf/ontology.ttl.");
  out.push(`# Generated at ${new Date().toISOString()}`);
  out.push("# =============================================================================");
  out.push("");
  out.push("@prefix rtg:     <https://vinayagrw.github.io/rnd-trust-graph#> .");
  out.push("@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .");
  out.push("@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .");
  out.push("@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .");
  out.push("@prefix prov:    <http://www.w3.org/ns/prov#> .");
  out.push("@prefix dcterms: <http://purl.org/dc/terms/> .");
  out.push("");

  out.push("# ---- Nodes (curated hero dataset) ------------------------------------------");
  for (const n of nodes) out.push(nodeTriples(n) + "\n");

  out.push("# ---- Noise nodes (deliberate SHACL violators for the readiness radar) ------");
  for (const n of noise) out.push(nodeTriples(n) + "\n");

  out.push("# ---- Patients (synthetic Synthea subjects, PHI-free) -----------------------");
  for (const p of patients) out.push(patientTriples(p) + "\n");

  out.push("# ---- Edges -----------------------------------------------------------------");
  for (const e of edges) {
    out.push(`${iri(e.src)} ${edgePredicate(e.type)} ${iri(e.dst)} .`);
  }
  out.push("");

  writeFileSync(OUT_FILE, out.join("\n"), "utf-8");
  const triples =
    nodes.length + noise.length + patients.length + edges.length;
  console.log(`✅ Wrote ${OUT_FILE}`);
  console.log(
    `   ${nodes.length} curated nodes, ${noise.length} noise nodes, ${patients.length} patients, ${edges.length} edges (≈${triples} subjects/edges).`
  );
}

main();
