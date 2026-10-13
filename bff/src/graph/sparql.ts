/**
 * Read-only SPARQL over the canonical reasoner (slice 1d).
 *
 * Backs a future `POST /api/sparql`: callers may run SELECT / ASK / CONSTRUCT /
 * DESCRIBE against the asserted + inferred canonical store, but NOTHING that
 * mutates it. SPARQL Update / graph-management keywords (INSERT, DELETE, LOAD,
 * CLEAR, DROP, CREATE, plus ADD/MOVE/COPY) are rejected up front with a clear
 * error — defense in depth for an endpoint that accepts arbitrary query text.
 *
 * The reasoner store is a read-mostly singleton (built once, entailed once); a
 * SELECT/ASK/CONSTRUCT/DESCRIBE has no side effects, so sharing it is safe.
 */
import { getCanonicalReasoner } from "../reasoner/service.js";
import type { SparqlRow } from "../reasoner/index.js";

/** Forbidden SPARQL-Update / graph-management keywords (whole-word, any case). */
const FORBIDDEN = [
  "INSERT",
  "DELETE",
  "LOAD",
  "CLEAR",
  "DROP",
  "CREATE",
  "ADD",
  "MOVE",
  "COPY",
  // SPARQL federation — blocked as defense-in-depth: SERVICE can fan a query out
  // to arbitrary remote endpoints (SSRF) even though it doesn't mutate the store.
  "SERVICE",
] as const;

/**
 * Strip SPARQL comments and string literals so a forbidden keyword inside a
 * comment or a quoted value can't trip the guard (and, conversely, a real
 * keyword can't hide behind one). SPARQL has only `#` line comments.
 */
function stripCommentsAndStrings(query: string): string {
  // Remove <IRI> refs FIRST — a `#` inside an IRI (the rtg: hash namespace ends
  // in `#`) must NOT be mistaken for the start of a `#` line comment.
  const noIris = query.replace(/<[^>]*>/g, "<>");
  const noComments = noIris.replace(/#[^\n\r]*/g, " ");
  return noComments
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/'''[\s\S]*?'''/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

/** Thrown when a query contains a write/update operation. Carries a clear message. */
export class SparqlWriteRejectedError extends Error {
  constructor(keyword: string) {
    super(
      `Read-only SPARQL endpoint: '${keyword}' (and any UPDATE/INSERT/DELETE/LOAD/` +
        `CLEAR/DROP/CREATE operation) is not permitted. Use SELECT, ASK, CONSTRUCT, or DESCRIBE.`
    );
    this.name = "SparqlWriteRejectedError";
  }
}

/** Reject (throw) if the query body contains any forbidden update keyword. */
export function assertReadOnlySparql(query: string): void {
  const sanitized = stripCommentsAndStrings(query);
  for (const kw of FORBIDDEN) {
    // Whole-word, case-insensitive — `\b` so a property like `created` or a var
    // `?insertedAt` doesn't false-trip, but a real `INSERT DATA` does.
    if (new RegExp(`\\b${kw}\\b`, "i").test(sanitized)) {
      throw new SparqlWriteRejectedError(kw);
    }
  }
}

/** A read-only SPARQL result, discriminated by query form. */
export type ReadOnlySparqlResult =
  | { kind: "select"; rows: SparqlRow[] }
  | { kind: "ask"; boolean: boolean }
  | { kind: "graph"; turtle: string };

/** Identify SELECT/ASK/CONSTRUCT/DESCRIBE, skipping PREFIX/BASE and comments. */
function detectQueryForm(query: string): "SELECT" | "ASK" | "CONSTRUCT" | "DESCRIBE" {
  const sanitized = stripCommentsAndStrings(query);
  const m = sanitized.match(/\b(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i);
  return (m?.[1]?.toUpperCase() ?? "SELECT") as
    | "SELECT"
    | "ASK"
    | "CONSTRUCT"
    | "DESCRIBE";
}

/**
 * Run a read-only SPARQL query against the canonical reasoner. Rejects any
 * UPDATE/INSERT/DELETE/LOAD/CLEAR/DROP/CREATE first (comment- and string-stripped,
 * case-insensitive), then dispatches by query form:
 *   • ASK                  → { kind: "ask", boolean }
 *   • CONSTRUCT / DESCRIBE → { kind: "graph", turtle }
 *   • SELECT (default)     → { kind: "select", rows }
 *
 * CONSTRUCT/DESCRIBE are serialized to Turtle via the reasoner's CONSTRUCT path
 * (the public sparqlSelect maps SELECT bindings; for graph forms we serialize the
 * returned quads), so the endpoint returns RDF for graph queries and a binding
 * table for SELECT/ASK — exactly what a SPARQL client expects.
 */
export async function sparqlSelectReadOnly(query: string): Promise<ReadOnlySparqlResult> {
  assertReadOnlySparql(query);
  const reasoner = await getCanonicalReasoner();
  const form = detectQueryForm(query);

  if (form === "ASK") {
    return { kind: "ask", boolean: await reasoner.sparqlAsk(query) };
  }
  if (form === "CONSTRUCT" || form === "DESCRIBE") {
    const { constructToTurtle } = await import("./rdf.js");
    return { kind: "graph", turtle: await constructToTurtle(query) };
  }
  return { kind: "select", rows: await reasoner.sparqlSelect(query) };
}
