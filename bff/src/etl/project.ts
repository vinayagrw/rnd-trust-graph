/**
 * RDF → Neo4j projection (slice 1d).
 *
 * Makes RDF the source of truth and Neo4j a *projection cache*: we build the
 * canonical reasoner (asserted dataset + ontology, then entailment to fixpoint —
 * see reasoner/service.ts) and project the asserted **and inferred** graph into
 * Neo4j. The viz canvas, fast traversal, and the read-only Cypher MCP all read
 * Neo4j; this module keeps that cache in lock-step with the canonical store.
 *
 * ── Cache parity (HARD CONSTRAINT) ─────────────────────────────────────────
 * The resulting Neo4j graph is label / property / relationship-type identical to
 * what the legacy CSV ETL (01..03_*.cypher) produced, so getFullGraph /
 * getProvenance / resolveEntity and the Cypher MCP return identical results —
 * PLUS the newly inferred CANDIDATE_SIGNAL relationships now appear too.
 *
 * Mapping (recovered from etl/rdf/generate.ts, which inverted the CSV→RDF map):
 *   • RDF class (rdf:type local name)         → Neo4j node LABEL   (identity map:
 *       the CSV `kind` column == rdf:type local name == apoc.merge.node label).
 *   • RDF predicate (UPPER_SNAKE local name)  → Neo4j relationship TYPE (identity
 *       map: edgePredicate(type) = `rtg:${type}`; CANDIDATE_SIGNAL included).
 *   • Node datatype props                     → Neo4j node properties, same names
 *       the cypher SET used (label, code, vocab, ontologyVersion, sourceSystem,
 *       license, timestamp; gender/birthdate for Patient).
 *
 * ── Lossy fields the RDF generator DROPPED (must be carried verbatim) ───────
 * generate.ts is intentionally lossy in two spots that the Neo4j read paths
 * depend on, so projecting from RDF *alone* would silently break parity:
 *   1. `attrsRaw` — the legacy ETL stored the CSV `attrs` column verbatim on each
 *      node; queries.ts parseAttrs() reads it for node.attrs and resolveEntity
 *      cross-refs (rxnorm/efo/setid/ensembl). The generator only promoted a
 *      SUBSET of attr keys to typed predicates (and dropped modality, tissue,
 *      signature, phase, datatype, core, rxnorm, ensembl), so `attrsRaw` cannot
 *      be reconstructed from RDF byte-for-byte.
 *   2. edge provenance (sourceSystem/license/timestamp/ruleVersion) — the
 *      generator emits bare triples `rtg:src rtg:TYPE rtg:dst .` with no edge
 *      reification, but getFullGraph reads provenance off each relationship.
 * Both come from the SAME CSVs the legacy ETL used, so we read them here for the
 * ASSERTED triples and attach them during the MERGE. INFERRED edges
 * (CANDIDATE_SIGNAL) have no CSV row and therefore no provenance — correct, since
 * they are materialized by the reasoner, not sourced from any system.
 *
 * Idempotent: every node/edge MERGEs on its identity (no CREATE), so re-running
 * is a no-op beyond re-SETting the same values.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { write } from "../neo4j.js";
import { buildCanonicalReasoner, buildSafetyReasoner, NS } from "../reasoner/service.js";
import type { Reasoner } from "../reasoner/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = join(here, "..", "..", "..", "data", "import");

const PREFIXES = `PREFIX rtg: <${NS}>`;

/** Short-form an `rtg:` IRI back to its local id; pass anything else through. */
const short = (iri: string): string => (iri.startsWith(NS) ? iri.slice(NS.length) : iri);

// ── tiny CSV reader (mirrors generate.ts: no quoted-comma fields here) ───────
function parseCsv(file: string): Record<string, string>[] {
  const raw = readFileSync(join(IMPORT_DIR, file), "utf-8").replace(/\r\n/g, "\n").trim();
  const lines = raw.split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      // attrs is the LAST column and may contain ';' (never ','); re-join overflow.
      row[h.trim()] =
        i === headers.length - 1 ? cells.slice(i).join(",").trim() : (cells[i] ?? "").trim();
    });
    return row;
  });
}

/** The verbatim CSV `attrs` string per node id (drives Neo4j `attrsRaw`). */
function loadAttrsRawById(): Map<string, string> {
  const byId = new Map<string, string>();
  for (const file of ["nodes.csv", "nodes_noise.csv"]) {
    for (const row of parseCsv(file)) byId.set(row.id, row.attrs ?? "");
  }
  return byId;
}

/** Per-edge provenance keyed by `${src}|${type}|${dst}` (drives relationship props). */
interface EdgeProv {
  sourceSystem: string;
  license: string;
  timestamp: string;
  ruleVersion: string;
}
function loadEdgeProv(): Map<string, EdgeProv> {
  const byKey = new Map<string, EdgeProv>();
  for (const e of parseCsv("edges.csv")) {
    byKey.set(`${e.src}|${e.type}|${e.dst}`, {
      sourceSystem: e.source_system ?? "",
      license: e.license ?? "",
      timestamp: e.timestamp ?? "",
      ruleVersion: e.rule_version ?? "",
    });
  }
  return byKey;
}

// ── projection ──────────────────────────────────────────────────────────────

/** A typed node read from the canonical store, shaped for the Neo4j MERGE. */
interface ProjectedNode {
  id: string;
  label: string; // Neo4j label = RDF class local name
  props: Record<string, string | null>;
}

/**
 * Read every typed subject from the canonical store with the node properties the
 * legacy cypher SET. We enumerate the asserted datatype props per node; Patient
 * carries gender/birthdate instead of code/vocab/ontologyVersion, exactly as the
 * legacy ETL split them — the OPTIONALs below cover both shapes in one query.
 */
async function readNodes(r: Reasoner, attrsRawById: Map<string, string>): Promise<ProjectedNode[]> {
  const rows = await r.sparqlSelect(`${PREFIXES}
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?s ?kind ?label ?code ?vocab ?ontologyVersion ?sourceSystem ?license
           ?timestamp ?gender ?birthdate WHERE {
      ?s a ?kindIri .
      FILTER(STRSTARTS(STR(?s), "${NS}"))
      FILTER(STRSTARTS(STR(?kindIri), "${NS}"))
      BIND(STRAFTER(STR(?kindIri), "${NS}") AS ?kind)
      OPTIONAL { ?s rdfs:label ?label }
      OPTIONAL { ?s rtg:code ?code }
      OPTIONAL { ?s rtg:vocab ?vocab }
      OPTIONAL { ?s rtg:ontologyVersion ?ontologyVersion }
      OPTIONAL { ?s rtg:sourceSystem ?sourceSystem }
      OPTIONAL { ?s dcterms:license ?license }
      OPTIONAL { ?s rtg:timestamp ?timestamp }
      OPTIONAL { ?s rtg:gender ?gender }
      OPTIONAL { ?s rtg:birthdate ?birthdate }
    }`);

  return rows.map((row) => {
    const id = short(row.s);
    const props: Record<string, string | null> = {
      label: row.label ?? id,
      code: row.code ?? null,
      vocab: row.vocab ?? null,
      ontologyVersion: row.ontologyVersion ?? null,
      sourceSystem: row.sourceSystem ?? null,
      license: row.license ?? null,
      timestamp: row.timestamp ?? null,
      gender: row.gender ?? null,
      birthdate: row.birthdate ?? null,
      // Verbatim CSV attrs (RDF-lossy) — empty string for nodes with no attrs,
      // matching the legacy ETL which SET attrsRaw = row.attrs ('' when blank).
      attrsRaw: attrsRawById.get(id) ?? null,
    };
    return { id, label: row.kind, props };
  });
}

/** An edge read from the canonical store (asserted + inferred). */
interface ProjectedEdge {
  src: string;
  type: string;
  dst: string;
  prov?: EdgeProv;
}

/** Read every rtg: predicate triple between two rtg: subjects (the graph edges). */
async function readEdges(r: Reasoner, edgeProv: Map<string, EdgeProv>): Promise<ProjectedEdge[]> {
  // Data edges are exactly the rtg:UPPER_SNAKE predicates between two rtg: data
  // IRIs. Scoping ?p to the rtg: namespace excludes the OWL/RDFS T-Box triples
  // (rdfs:domain/range/subClassOf, owl:propertyChainAxiom) that share rtg:
  // subjects/objects but are schema, not graph edges. rdf:type is already
  // excluded (it is not in the rtg: namespace).
  const rows = await r.sparqlSelect(`${PREFIXES}
    SELECT ?s ?p ?o WHERE {
      ?s ?p ?o .
      FILTER(isIRI(?o))
      FILTER(STRSTARTS(STR(?s), "${NS}"))
      FILTER(STRSTARTS(STR(?p), "${NS}"))
      FILTER(STRSTARTS(STR(?o), "${NS}"))
    }`);
  return rows.map((row) => {
    const src = short(row.s);
    const type = short(row.p);
    const dst = short(row.o);
    return { src, type, dst, prov: edgeProv.get(`${src}|${type}|${dst}`) };
  });
}

/**
 * Project the asserted + inferred canonical graph into Neo4j, label/property/
 * relationship-type identical to the legacy CSV ETL, plus the inferred
 * CANDIDATE_SIGNAL edges. Idempotent (MERGE-only). Returns the canonical reasoner
 * so callers can reuse it (e.g. for verification) without rebuilding.
 */
export async function projectCanonicalToNeo4j(): Promise<{
  reasoner: Reasoner;
  nodeCount: number;
  edgeCount: number;
  inferredCount: number;
}> {
  const reasoner = await buildCanonicalReasoner();
  const attrsRawById = loadAttrsRawById();
  const edgeProv = loadEdgeProv();

  const nodes = await readNodes(reasoner, attrsRawById);
  const edges = await readEdges(reasoner, edgeProv);

  // ── Nodes: MERGE on id, apply the label, SET the carried props. ───────────
  // apoc.create.addLabels keeps this idempotent without needing a per-label
  // Cypher template; the label string comes from the RDF class local name.
  for (const n of nodes) {
    await write(
      `MERGE (x { id: $id })
       SET x += $props
       WITH x CALL apoc.create.addLabels(x, [$label]) YIELD node
       RETURN node`,
      { id: n.id, props: pruneNulls(n.props), label: n.label }
    );
  }

  // ── Edges: MERGE the relationship by type, SET per-edge provenance. ────────
  // apoc.merge.relationship lets the type be a runtime string (Cypher cannot
  // parameterize a rel type), and MERGE keeps re-runs idempotent. Inferred edges
  // (no CSV row) get no provenance props, which is the correct ALCOA+ reading.
  let inferredCount = 0;
  for (const e of edges) {
    const props = e.prov
      ? {
          sourceSystem: e.prov.sourceSystem,
          license: e.prov.license,
          timestamp: e.prov.timestamp,
          ruleVersion: e.prov.ruleVersion,
        }
      : {};
    if (!e.prov) inferredCount += 1;
    await write(
      `MATCH (s { id: $src })
       MATCH (t { id: $dst })
       CALL apoc.merge.relationship(s, $type, {}, $props, t, {}) YIELD rel
       RETURN rel`,
      { src: e.src, dst: e.dst, type: e.type, props }
    );
  }

  return { reasoner, nodeCount: nodes.length, edgeCount: edges.length, inferredCount };
}

/** Drop null-valued keys so Neo4j never stores explicit nulls (matches legacy). */
function pruneNulls(props: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (v !== null) out[k] = v;
  return out;
}

// ── UC4 subject-safety projection ────────────────────────────────────────────
//
// The safety radar (Use Case 4) reasons on its OWN store (buildSafetyReasoner);
// here we project that SAME graph into Neo4j so the subjects are real, queryable
// nodes — traversable by the read-only Cypher /ask agent and explainable by the
// grounded LLM (getNodeContext). Every projected node also gets a `:Safety` marker
// label so the FAIR canvas (getFullGraph) can exclude them and stay visually
// byte-identical. Provenance lives inline on each safety node (unlike the FAIR
// edges), so no CSV recovery is needed; safety edges are bare triples (no edge
// provenance), which is correct — they are curated relationships, not sourced rows.

/** The marker label every projected safety node carries (for canvas exclusion). */
const SAFETY_MARKER = "Safety";

/** Read every typed safety node with the datatype props we project to Neo4j. */
async function readSafetyNodes(r: Reasoner): Promise<ProjectedNode[]> {
  const rows = await r.sparqlSelect(`${PREFIXES}
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?s ?kind ?label ?code ?sourceSystem ?license ?timestamp
           ?enrolmentId ?status ?ontologyVersion ?requiresRecentLab WHERE {
      ?s a ?kindIri .
      FILTER(STRSTARTS(STR(?s), "${NS}"))
      FILTER(STRSTARTS(STR(?kindIri), "${NS}"))
      BIND(STRAFTER(STR(?kindIri), "${NS}") AS ?kind)
      OPTIONAL { ?s rdfs:label ?label }
      OPTIONAL { ?s rtg:code ?code }
      OPTIONAL { ?s rtg:sourceSystem ?sourceSystem }
      OPTIONAL { ?s dcterms:license ?license }
      OPTIONAL { ?s rtg:timestamp ?timestamp }
      OPTIONAL { ?s rtg:enrolmentId ?enrolmentId }
      OPTIONAL { ?s rtg:status ?status }
      OPTIONAL { ?s rtg:ontologyVersion ?ontologyVersion }
      OPTIONAL { ?s rtg:requiresRecentLab ?requiresRecentLab }
    }`);
  return rows.map((row) => {
    const id = short(row.s);
    const props: Record<string, string | null> = {
      label: row.label ?? id,
      code: row.code ?? null,
      sourceSystem: row.sourceSystem ?? null,
      license: row.license ?? null,
      timestamp: row.timestamp ?? null,
      enrolmentId: row.enrolmentId ?? null,
      status: row.status ?? null,
      ontologyVersion: row.ontologyVersion ?? null,
      requiresRecentLab: row.requiresRecentLab ?? null,
    };
    return { id, label: row.kind, props };
  });
}

/** Read every rtg: predicate triple between two rtg: subjects (safety edges).
 *  Bare curated triples → no per-edge provenance (matches the safety A-Box). */
async function readSafetyEdges(r: Reasoner): Promise<{ src: string; type: string; dst: string }[]> {
  const rows = await r.sparqlSelect(`${PREFIXES}
    SELECT ?s ?p ?o WHERE {
      ?s ?p ?o .
      FILTER(isIRI(?o))
      FILTER(STRSTARTS(STR(?s), "${NS}"))
      FILTER(STRSTARTS(STR(?p), "${NS}"))
      FILTER(STRSTARTS(STR(?o), "${NS}"))
    }`);
  return rows.map((row) => ({ src: short(row.s), type: short(row.p), dst: short(row.o) }));
}

/**
 * Project the subject-safety graph into Neo4j, tagged with the `:Safety` marker
 * label so it is invisible to the FAIR canvas. Idempotent (MERGE-only). This is
 * what makes the safety radar Neo4j-backed rather than a static in-process store.
 */
export async function projectSafetyToNeo4j(): Promise<{ nodeCount: number; edgeCount: number }> {
  const reasoner = await buildSafetyReasoner();
  const nodes = await readSafetyNodes(reasoner);
  const edges = await readSafetyEdges(reasoner);

  for (const n of nodes) {
    await write(
      `MERGE (x { id: $id })
       SET x += $props
       WITH x CALL apoc.create.addLabels(x, [$label, $marker]) YIELD node
       RETURN node`,
      { id: n.id, props: pruneNulls(n.props), label: n.label, marker: SAFETY_MARKER }
    );
  }
  for (const e of edges) {
    await write(
      `MATCH (s { id: $src })
       MATCH (t { id: $dst })
       CALL apoc.merge.relationship(s, $type, {}, {}, t, {}) YIELD rel
       RETURN rel`,
      { src: e.src, dst: e.dst, type: e.type }
    );
  }
  return { nodeCount: nodes.length, edgeCount: edges.length };
}
