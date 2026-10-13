/**
 * Authorized safety-writer — the seam that lets a governed correction actually
 * CLEAR a safety finding and move the score.
 *
 * Each SafetyChangeOp is applied over BOTH:
 *   - the dedicated SAFETY reasoner (reasoner.update() — the in-memory RDF store
 *     the SHACL detection reads via dump()), then invalidateSafetyShacl() so the
 *     next validation runs over the mutated graph and the fixed shape stops firing;
 *   - the `:Safety`-tagged Neo4j projection (direct-driver write()), so the safety
 *     canvas stays consistent.
 *
 * TRUST BOUNDARY (mirrors hitl/ops.ts): this uses the AUTHORIZED direct driver +
 * reasoner.update() only. The read-only agent/MCP path is untouched — the agent
 * has no tool that reaches write(); the /api/sparql write-guard and the MCP
 * --read-only flag are unaffected. It touches ONLY safety nodes/relations, never a
 * FAIR (canonical) triple, so the FAIR canvas stays byte-identical. Every op has an
 * exact inverse, so a revert restores byte-identical prior state.
 */
import type { SafetyChangeOp } from "@rnd/shared";
import { write } from "../neo4j.js";
import { getSafetyReasoner, NS } from "../reasoner/service.js";
import { invalidateSafetyShacl } from "./service.js";

const PREFIXES = `
PREFIX rtg:  <${NS}>
PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>`;

/** Escape a string literal for safe interpolation into SPARQL/Cypher values. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Ids, relation kinds, prop names, class labels are interpolated into SPARQL
 *  IRIs/predicates and back-ticked Cypher rel-types/labels/props, which esc()
 *  (value-only) does not cover — validate their shape so no injection is possible.
 *  Ops are curated in remediate.ts today; this keeps the invariant if a future
 *  path ever builds them from request data. */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
function assertSafeIdent(value: string, what: string): void {
  if (!SAFE_IDENT_RE.test(value)) {
    throw new Error(`safety op rejected: unsafe ${what} "${value}"`);
  }
}

/** Build a SPARQL literal — typed when a datatype (xsd local name) is given. */
function literal(value: string, datatype?: string): string {
  if (datatype) {
    assertSafeIdent(datatype, "datatype");
    return `"${esc(value)}"^^xsd:${datatype}`;
  }
  return `"${esc(value)}"`;
}

/** Validate every interpolated identifier on an op up front. */
function assertOpSafe(op: SafetyChangeOp): void {
  switch (op.op) {
    case "addEdge":
    case "removeEdge":
      assertSafeIdent(op.source, "node id");
      assertSafeIdent(op.target, "node id");
      assertSafeIdent(op.kind, "relation kind");
      return;
    case "setProp":
    case "unsetProp":
      assertSafeIdent(op.nodeId, "node id");
      assertSafeIdent(op.prop, "prop name");
      return;
    case "ensureNode":
    case "deleteNode":
      assertSafeIdent(op.nodeId, "node id");
      assertSafeIdent(op.label, "class label");
      return;
  }
}

/** Apply ONE op to the safety reasoner (RDF store) only. In-process, no Neo4j —
 *  this is what actually moves the SHACL findings + the score, so it is hermetic. */
async function applyReasonerOp(op: SafetyChangeOp): Promise<void> {
  const r = await getSafetyReasoner();
  switch (op.op) {
    case "addEdge":
      await r.update(`${PREFIXES}
        INSERT DATA { rtg:${op.source} rtg:${op.kind} rtg:${op.target} }`);
      return;
    case "removeEdge":
      await r.update(`${PREFIXES}
        DELETE DATA { rtg:${op.source} rtg:${op.kind} rtg:${op.target} }`);
      return;
    case "setProp":
      await r.update(`${PREFIXES}
        DELETE { rtg:${op.nodeId} rtg:${op.prop} ?old }
        INSERT { rtg:${op.nodeId} rtg:${op.prop} ${literal(op.value, op.datatype)} }
        WHERE  { OPTIONAL { rtg:${op.nodeId} rtg:${op.prop} ?old } }`);
      return;
    case "unsetProp":
      await r.update(`${PREFIXES}
        DELETE DATA { rtg:${op.nodeId} rtg:${op.prop} ${literal(op.value, op.datatype)} }`);
      return;
    case "ensureNode":
      await r.update(`${PREFIXES}
        INSERT DATA {
          rtg:${op.nodeId} a rtg:${op.label} ${op.nodeLabel ? `; rdfs:label "${esc(op.nodeLabel)}"` : ""} .
        }`);
      return;
    case "deleteNode":
      // Remove the node's type + label triples (the exact inverse of ensureNode).
      await r.update(`${PREFIXES}
        DELETE { rtg:${op.nodeId} a rtg:${op.label} . rtg:${op.nodeId} rdfs:label ?l }
        WHERE  { OPTIONAL { rtg:${op.nodeId} rdfs:label ?l } }`);
      return;
  }
}

/** Mirror ONE op into the `:Safety` Neo4j projection (best-effort). Keeps the
 *  safety canvas consistent; NOT the score's source of truth (that is the reasoner
 *  + SHACL), so a Neo4j hiccup logs and continues rather than failing the apply. */
async function mirrorNeo4jOp(op: SafetyChangeOp): Promise<void> {
  switch (op.op) {
    case "addEdge":
      await write(
        `MATCH (a:Safety { id: $src }), (b:Safety { id: $dst })
         MERGE (a)-[:\`${op.kind}\`]->(b)`,
        { src: op.source, dst: op.target },
      );
      return;
    case "removeEdge":
      await write(
        `MATCH (a:Safety { id: $src })-[e:\`${op.kind}\`]->(b:Safety { id: $dst }) DELETE e`,
        { src: op.source, dst: op.target },
      );
      return;
    case "setProp":
      await write(`MATCH (n:Safety { id: $id }) SET n.\`${op.prop}\` = $value`, {
        id: op.nodeId,
        value: op.value,
      });
      return;
    case "unsetProp":
      await write(`MATCH (n:Safety { id: $id }) REMOVE n.\`${op.prop}\``, { id: op.nodeId });
      return;
    case "ensureNode":
      await write(
        `MERGE (x { id: $id }) SET x:Safety:\`${op.label}\`${op.nodeLabel ? ", x.label = $label" : ""}`,
        op.nodeLabel ? { id: op.nodeId, label: op.nodeLabel } : { id: op.nodeId },
      );
      return;
    case "deleteNode":
      await write(`MATCH (x:Safety { id: $id }) DETACH DELETE x`, { id: op.nodeId });
      return;
  }
}

/**
 * Apply ops to the safety reasoner ONLY (no Neo4j) and invalidate the SHACL cache.
 * Hermetic — the fast tests use this to prove a finding clears + the score moves
 * without a live database. Returns after all ops are materialized.
 */
export async function applySafetyReasonerOps(ops: SafetyChangeOp[]): Promise<void> {
  for (const op of ops) {
    assertOpSafe(op);
    await applyReasonerOp(op);
  }
  invalidateSafetyShacl();
}

/**
 * Apply ops over BOTH the safety reasoner (source of truth for the score) and the
 * `:Safety` Neo4j projection (best-effort mirror for the canvas). The reasoner
 * mutation happens first and always; a Neo4j mirror failure is logged, not fatal.
 */
export async function applySafetyOps(ops: SafetyChangeOp[]): Promise<void> {
  await applySafetyReasonerOps(ops);
  for (const op of ops) {
    try {
      await mirrorNeo4jOp(op);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[safety-writer] neo4j mirror skipped for ${op.op}: ${detail}`);
    }
  }
}
