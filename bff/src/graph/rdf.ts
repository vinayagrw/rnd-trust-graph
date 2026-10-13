/**
 * Canonical RDF/Turtle serialization for the W3C/RDF surface.
 *
 * Slice 1d makes RDF the source of truth, so `GET /api/rdf` no longer serializes
 * Neo4j on the fly — its data now comes from the CANONICAL reasoner store
 * (asserted + inferred triples; the CANDIDATE_SIGNAL entailments are included).
 * The exported function name/signature `heroGraphToTurtle(): Promise<string>` is
 * UNCHANGED so server.ts compiles untouched; only the data source changed. A
 * `dumpCanonicalTurtle()` alias and a `constructToTurtle()` helper (for the
 * read-only SPARQL endpoint's CONSTRUCT/DESCRIBE forms) are added alongside.
 *
 * Serialization respects the no-edit constraint on reasoner/{index,oxigraph}.ts:
 * we dump the canonical store through its public SELECT surface (projecting the
 * object's datatype/lang/IRI-ness so literals round-trip faithfully) rather than
 * reaching into the private oxigraph Store. For CONSTRUCT/DESCRIBE we load the
 * already-materialized canonical Turtle into a scratch oxigraph store and run the
 * user's query there — this is a SERIALIZATION step over the canonical dump, not
 * a re-run of the dataset load/entailment pipeline (that lives only in
 * reasoner/service.ts).
 */
import * as oxi from "oxigraph";
import { getCanonicalReasoner, NS } from "../reasoner/service.js";
import type { Reasoner } from "../reasoner/index.js";

const TURTLE = "text/turtle";
const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
const RDF_LANGSTRING = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";

const PREFIXES = `@prefix rtg:     <${NS}> .
@prefix rdf:     <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
@prefix prov:    <http://www.w3.org/ns/prov#> .
@prefix dcterms: <http://purl.org/dc/terms/> .
`;

/** Escape a string for a Turtle quoted literal (RFC-compliant subset). */
function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** Render one (s,p,o) row from the dump SELECT into a single N-Triples-style line. */
function tripleLine(row: Record<string, string>): string {
  const s = `<${row.s}>`;
  const p = `<${row.p}>`;
  const o = objectTerm(row);
  return `${s} ${p} ${o} .`;
}

/** Render the object term from the dump SELECT projection (IRI vs typed/lang literal). */
function objectTerm(row: Record<string, string>): string {
  if (row.oIsIri === "true") return `<${row.o}>`;
  const lex = `"${escapeLiteral(row.o ?? "")}"`;
  if (row.oLang) return `${lex}@${row.oLang}`;
  const dt = row.oDatatype;
  if (!dt || dt === XSD_STRING || dt === RDF_LANGSTRING) return lex;
  return `${lex}^^<${dt}>`;
}

/**
 * Dump the WHOLE canonical store (asserted + inferred) to Turtle via the public
 * SELECT surface — faithful for IRIs and typed/lang literals. Used by GET /api/rdf.
 */
export async function dumpCanonicalTurtle(): Promise<string> {
  const reasoner = await getCanonicalReasoner();
  return serializeAllTriples(reasoner);
}

/**
 * Serialize the DATA graph (the `rtg:` application triples, asserted + inferred)
 * of a reasoner's store to Turtle. We scope to subjects in the rtg: namespace so
 * the dump is the trust graph itself — not the OWL T-Box plumbing (rdf:List
 * blank nodes for the propertyChainAxiom, owl:* declarations) that also lives in
 * the canonical store. Object IRIs outside rtg: (e.g. xsd: datatypes on literals)
 * are still emitted; only blank-node/owl machinery is excluded.
 */
async function serializeAllTriples(reasoner: Reasoner): Promise<string> {
  const rows = await reasoner.sparqlSelect(`
    SELECT ?s ?p ?o
           (isIRI(?o) AS ?oIsIri)
           (DATATYPE(?o) AS ?oDatatype)
           (LANG(?o) AS ?oLang)
    WHERE {
      ?s ?p ?o .
      FILTER(isIRI(?s) && STRSTARTS(STR(?s), "${NS}"))
      FILTER(!isBlank(?o))
    }
    ORDER BY ?s ?p ?o`);
  const header = [
    "# R&D Trust Graph — canonical RDF (asserted + inferred), serialized as Turtle.",
    "# Source of truth: data/rdf/*.ttl materialized by reasoner/service.ts (the",
    "# CANDIDATE_SIGNAL property-chain entailments are included). Dumped via SPARQL.",
  ].join("\n");
  const body = rows.map(tripleLine).join("\n");
  return `${PREFIXES}\n${header}\n\n${body}\n`;
}

/**
 * Serialize the canonical hero subgraph to Turtle for `GET /api/rdf`.
 *
 * Signature preserved for server.ts. The data now comes from the canonical store
 * (asserted + inferred) rather than an on-the-fly Neo4j serialization. We return
 * the FULL canonical dump (a superset of the former hero scope) so the W3C/RDF
 * cameo shows the real reasoned graph, including the inferred CANDIDATE_SIGNAL
 * edges — which is the whole point of the rebuild.
 */
export async function heroGraphToTurtle(): Promise<string> {
  return dumpCanonicalTurtle();
}

/**
 * Run a read-only CONSTRUCT/DESCRIBE against the canonical graph and return
 * Turtle. We load the already-materialized canonical dump into a scratch
 * oxigraph store and execute the query there (a serialization step over the
 * canonical Turtle — NOT a re-run of the dataset load/entailment, which lives
 * only in reasoner/service.ts). oxigraph returns the constructed quads, which we
 * dump straight back to Turtle.
 */
export async function constructToTurtle(query: string): Promise<string> {
  const reasoner = await getCanonicalReasoner();
  const canonicalTurtle = await serializeAllTriples(reasoner);

  const store = new oxi.Store();
  store.load(canonicalTurtle, { format: TURTLE });
  const quads = store.query(query);
  if (!Array.isArray(quads) || (quads.length > 0 && typeof quads[0] === "boolean")) {
    throw new Error("constructToTurtle: query did not return a graph (CONSTRUCT/DESCRIBE)");
  }
  // Materialize the constructed quads in a fresh store, then dump to Turtle.
  const out = new oxi.Store();
  for (const q of quads as oxi.Quad[]) out.add(q);
  return PREFIXES + "\n" + out.dump({ format: TURTLE, from_graph_name: oxi.defaultGraph() });
}
