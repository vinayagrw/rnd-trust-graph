/**
 * Reasoner adapter — a backend-agnostic interface over an RDF store that can run
 * SPARQL, apply forward-chaining entailment rules (SPARQL INSERT…WHERE), and run
 * SHACL validation.
 *
 * Phase 1b goal: provide TWO interchangeable backends behind a single config
 * toggle so the rest of the BFF can reason over RDF without caring whether it is
 * an in-process WASM store (oxigraph) or a JVM sidecar (Apache Jena Fuseki):
 *
 *   - "oxigraph" (DEFAULT): in-process, zero-ops, ships in the demo. Uses the
 *     oxigraph WASM store for SPARQL/Update and shacl-engine + rdf-ext for SHACL.
 *   - "fuseki": an HTTP client to a Jena Fuseki SPARQL endpoint (FUSEKI_URL),
 *     for environments that already run a triplestore. Interface-complete; throws
 *     a clear "fuseki backend unavailable" error if no sidecar is reachable.
 *
 * The backend is resolved from the `getReasoner(backend?)` argument, else from
 * REASONER_BACKEND in the admin config, else defaults to "oxigraph". This file
 * deliberately does NOT wire into server.ts / risk.ts / queries.ts — that is a
 * later slice. It exposes the module + factory only.
 */
import { getConfig } from "../config/adminConfig.js";

/** A single SPARQL SELECT solution row: variable name → bound term's lexical value. */
export type SparqlRow = Record<string, string>;

/** One SHACL constraint violation, flattened to the few fields a UI needs. */
export interface ShaclViolation {
  /** IRI/blank-node id of the node that failed a constraint. */
  focusNode: string;
  /** Human-readable constraint message (sh:resultMessage / sh:message). */
  message: string;
  /** Property path the violation is about, when the constraint is path-scoped. */
  path?: string;
}

/** Result of a SHACL validation run. */
export interface ShaclReport {
  conforms: boolean;
  violations: ShaclViolation[];
}

/** The two supported backends. */
export type ReasonerBackend = "oxigraph" | "fuseki";

/**
 * Backend-agnostic reasoner. Implementations may be sync (oxigraph, in-process)
 * or async (fuseki, over HTTP); every method therefore returns `T | Promise<T>`
 * and callers should `await` uniformly.
 */
export interface Reasoner {
  /** Which backend this instance is. */
  readonly backend: ReasonerBackend;

  /** Load a Turtle document into the store (additive; call repeatedly to merge). */
  load(ttl: string): Promise<void> | void;

  /** Run a SPARQL SELECT and return solution rows. */
  sparqlSelect(query: string): Promise<SparqlRow[]> | SparqlRow[];

  /** Run a SPARQL ASK and return its boolean. */
  sparqlAsk(query: string): Promise<boolean> | boolean;

  /**
   * Apply one or more forward-chaining entailment rules. Each rule is a SPARQL
   * Update (typically `INSERT { … } WHERE { … }`) that materializes inferred
   * triples into the same store. Rules run in order, once (single pass).
   */
  entail(rules: string[] | string): Promise<void> | void;

  /**
   * Apply a single SPARQL Update (INSERT/DELETE … [WHERE …]) to the store. Used
   * by the authorized HITL writer to mutate the canonical RDF projection in
   * lock-step with the Neo4j projection. Distinct from `entail` only by intent:
   * `entail` materializes inference, `update` records a governed human edit.
   * NOT reachable from any HTTP read path — /api/sparql rejects updates up front.
   */
  update(sparql: string): Promise<void> | void;

  /** Validate the loaded data against a SHACL shapes graph (Turtle). */
  validateShacl(shapesTtl: string): Promise<ShaclReport>;

  /**
   * Serialize the CURRENT store contents (including any governed `update()`s) back
   * to a Turtle string. Used by the safety radar to run its sh:sparql SHACL over
   * the LIVE graph rather than the static file, so a corrective `update()` is
   * reflected in the next validation. Datatypes (xsd:dateTime, xsd:boolean) are
   * preserved so datatype-sensitive shapes still evaluate correctly.
   */
  dump(): Promise<string> | string;
}

/** Normalize a string|string[] rule argument to an array. */
export function toRuleArray(rules: string[] | string): string[] {
  return Array.isArray(rules) ? rules : [rules];
}

/**
 * Resolve the effective backend: explicit arg wins, else REASONER_BACKEND from
 * the (env-overridable) admin config, else "oxigraph".
 */
export function resolveBackend(backend?: ReasonerBackend): ReasonerBackend {
  if (backend) return backend;
  const fromEnv = process.env.REASONER_BACKEND;
  if (fromEnv === "oxigraph" || fromEnv === "fuseki") return fromEnv;
  return getConfig().reasonerBackend;
}

/**
 * Factory: build a fresh Reasoner for the resolved backend. The oxigraph and
 * fuseki modules are imported lazily so that selecting one backend never forces
 * the other's (heavier) dependencies to load.
 */
export async function getReasoner(backend?: ReasonerBackend): Promise<Reasoner> {
  const resolved = resolveBackend(backend);
  if (resolved === "fuseki") {
    const { FusekiReasoner } = await import("./fuseki.js");
    return new FusekiReasoner();
  }
  const { OxigraphReasoner } = await import("./oxigraph.js");
  return new OxigraphReasoner();
}
