/**
 * HITL change-op executor.
 *
 * Each ChangeOp is applied (forward) and undone (inverse) over BOTH projections
 * in lock-step:
 *   - the Neo4j projection, via the AUTHORIZED direct-driver write() (bff/src/neo4j.ts).
 *     This is INDEPENDENT of the agent's read-only MCP allow-list — the agent has
 *     no tool that can reach write(), so governed HITL writes never touch the
 *     read-only agent/MCP path (enforced.ts / the MCP --read-only flag / the
 *     /api/sparql write-guard all stay untouched).
 *   - the canonical RDF store, via SPARQL update (reasoner.update()), so the
 *     RDF-first reasoner the demo reads from stays consistent with Neo4j.
 *
 * Flag ops (setFlagResolved/clearFlagResolved) are the ONE exception: they touch
 * neither projection's data — they only flip the runtime overlay (overlay.ts),
 * because SHACL flags are computed from the static TTL and must stay reversible
 * without editing baseline ETL output.
 *
 * The inverse of an op is computed by the pending-scenario authors and stored on
 * the ChangeSet; this module just executes whatever ops it is handed. Applying
 * forwardOps then later applying inverseOps therefore restores byte-identical
 * prior state (the round-trip the tests assert).
 */
import type { ChangeOp, Provenance } from "@rnd/shared";
import { write } from "../neo4j.js";
import { getCanonicalReasoner, NS } from "../reasoner/service.js";
import {
  markFlagResolved,
  clearFlagResolved,
  markManualFlag,
  clearManualFlag,
  markEdgeTag,
  clearEdgeTag,
} from "./overlay.js";

const PREFIXES = `
PREFIX rtg:  <${NS}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dcterms: <http://purl.org/dc/terms/>
PREFIX prov: <http://www.w3.org/ns/prov#>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>`;

/** Escape a string literal for safe interpolation into a SPARQL/Cypher value. */
function sparqlStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Identifiers (node ids, edge kinds, prop names) are interpolated into SPARQL
 *  IRIs / predicates and back-ticked Cypher rel-types/props, which sparqlStr does
 *  NOT cover. Today every op is curated (pending.ts), so this is unreachable from
 *  user input — but validating keeps the no-injection invariant if a future code
 *  path ever builds ops from a request. Allows the shape all real ids use. */
const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
function assertSafeIdent(value: string, what: string): void {
  if (!SAFE_IDENT_RE.test(value)) {
    throw new Error(`HITL op rejected: unsafe ${what} "${value}"`);
  }
}

/** The scalar fields the ETL projects as TOP-LEVEL Neo4j properties (see
 *  project.ts readNodes). A setProp on one of these must edit the real top-level
 *  property — NOT the attrsRaw token — or the Neo4j projection (dossier code /
 *  ontologyVersion, resolveEntity's n.code match) silently lags the RDF store.
 *  Any other prop (e.g. status) lives inside attrsRaw. */
const TOP_LEVEL_PROPS = new Set([
  "label",
  "code",
  "vocab",
  "ontologyVersion",
  "sourceSystem",
  "license",
  "timestamp",
  "gender",
  "birthdate",
]);

/** The provenance triad triples for a node (used by add/removeProvenance). The
 *  exact predicates the dataset/SHACL use, so adding them satisfies the
 *  NodeProvenanceShape and clears the missing-provenance flag at the source. */
function provenanceTriples(nodeId: string, p: Provenance): string {
  const lines = [
    `rtg:${nodeId} rtg:sourceSystem "${sparqlStr(p.sourceSystem)}" .`,
    `rtg:${nodeId} rtg:timestamp "${sparqlStr(p.timestamp)}"^^xsd:dateTime .`,
    `rtg:${nodeId} dcterms:license "${sparqlStr(p.license)}" .`,
    `rtg:${nodeId} prov:wasDerivedFrom "${sparqlStr(p.sourceSystem)}" .`,
  ];
  if (p.ontologyVersion) lines.push(`rtg:${nodeId} rtg:ontologyVersion "${sparqlStr(p.ontologyVersion)}" .`);
  return lines.join("\n      ");
}

/**
 * Set a scalar property on a Neo4j node, mirroring the ETL representation.
 * Top-level projected fields (TOP_LEVEL_PROPS) are SET directly via APOC (so the
 * round-trip is byte-identical and the real property is updated). Curation props
 * the ETL keeps INSIDE `attrsRaw` (k=v;k2=v2, e.g. `status`) are edited in place
 * in that string rather than introducing a top-level property the inverse could
 * never cleanly remove.
 */
async function setNeo4jProp(nodeId: string, prop: string, value: string): Promise<void> {
  if (TOP_LEVEL_PROPS.has(prop)) {
    // Plain SET (no APOC dependency — APOC may be absent in the demo Neo4j). The
    // value is a bound parameter; the prop name is validated by assertSafeIdent in
    // applyOp before it is back-ticked here.
    await write(`MATCH (n { id: $id }) SET n.\`${prop}\` = $value`, { id: nodeId, value });
    return;
  }
  await write(
    `MATCH (n { id: $id })
     WITH n, coalesce(n.attrsRaw, '') AS raw
     WITH n,
       [pair IN split(raw, ';') WHERE pair <> '' AND NOT pair STARTS WITH $prefix] AS kept
     WITH n, kept + [$pair] AS parts
     SET n.attrsRaw = reduce(s = '', i IN range(0, size(parts) - 1) |
       CASE WHEN i = 0 THEN parts[i] ELSE s + ';' + parts[i] END)`,
    { id: nodeId, prefix: `${prop}=`, pair: `${prop}=${value}` }
  );
}

/** Remove a property (inverse of setProp when the prop did not exist before).
 *  Top-level projected fields are REMOVE-d directly; others have their token
 *  stripped from the attrsRaw "k=v;..." string. */
async function unsetNeo4jProp(nodeId: string, prop: string): Promise<void> {
  if (TOP_LEVEL_PROPS.has(prop)) {
    await write(`MATCH (n { id: $id }) REMOVE n.\`${prop}\``, { id: nodeId });
    return;
  }
  await write(
    `MATCH (n { id: $id })
     WITH n, coalesce(n.attrsRaw, '') AS raw
     WITH n,
       [pair IN split(raw, ';') WHERE pair <> '' AND NOT pair STARTS WITH $prefix] AS parts
     SET n.attrsRaw = reduce(s = '', i IN range(0, size(parts) - 1) |
       CASE WHEN i = 0 THEN parts[i] ELSE s + ';' + parts[i] END)`,
    { id: nodeId, prefix: `${prop}=` }
  );
}

/** Apply ONE op forward. Returns after both projections are mutated. */
export async function applyOp(op: ChangeOp): Promise<void> {
  const r = await getCanonicalReasoner();
  // Validate every interpolated identifier up front. Node ids / edge kinds / prop
  // names are concatenated into SPARQL IRIs+predicates and back-ticked into Cypher
  // rel-types/props, which sparqlStr (value-only) does not cover. Ops are curated
  // today, so this never fires — it keeps the no-injection invariant if a future
  // path ever builds ops from request data.
  if (op.op === "addEdge" || op.op === "removeEdge") {
    assertSafeIdent(op.source, "node id");
    assertSafeIdent(op.target, "node id");
    assertSafeIdent(op.kind, "edge kind");
  } else if (op.op === "setProp" || op.op === "unsetProp") {
    assertSafeIdent(op.nodeId, "node id");
    assertSafeIdent(op.prop, "prop name");
  } else if (op.op === "addProvenance" || op.op === "removeProvenance") {
    assertSafeIdent(op.nodeId, "node id");
  }
  switch (op.op) {
    case "addEdge": {
      await r.update(`${PREFIXES}
      INSERT DATA { rtg:${op.source} rtg:${op.kind} rtg:${op.target} }`);
      await write(
        `MATCH (a { id: $src }), (b { id: $dst })
         MERGE (a)-[:\`${op.kind}\`]->(b)`,
        { src: op.source, dst: op.target }
      );
      return;
    }
    case "removeEdge": {
      await r.update(`${PREFIXES}
      DELETE DATA { rtg:${op.source} rtg:${op.kind} rtg:${op.target} }`);
      await write(
        `MATCH (a { id: $src })-[e:\`${op.kind}\`]->(b { id: $dst }) DELETE e`,
        { src: op.source, dst: op.target }
      );
      return;
    }
    case "setProp": {
      await r.update(`${PREFIXES}
      DELETE { rtg:${op.nodeId} rtg:${op.prop} ?old }
      INSERT { rtg:${op.nodeId} rtg:${op.prop} "${sparqlStr(op.value)}" }
      WHERE  { OPTIONAL { rtg:${op.nodeId} rtg:${op.prop} ?old } }`);
      await setNeo4jProp(op.nodeId, op.prop, op.value);
      return;
    }
    case "unsetProp": {
      await r.update(`${PREFIXES}
      DELETE DATA { rtg:${op.nodeId} rtg:${op.prop} "${sparqlStr(op.value)}" }`);
      await unsetNeo4jProp(op.nodeId, op.prop);
      return;
    }
    case "addProvenance": {
      await r.update(`${PREFIXES}
      INSERT DATA { ${provenanceTriples(op.nodeId, op.provenance)} }`);
      await write(
        `MATCH (n { id: $id })
         SET n.sourceSystem = $sourceSystem, n.timestamp = $timestamp,
             n.license = $license, n.ontologyVersion = $ontologyVersion`,
        {
          id: op.nodeId,
          sourceSystem: op.provenance.sourceSystem,
          timestamp: op.provenance.timestamp,
          license: op.provenance.license,
          ontologyVersion: op.provenance.ontologyVersion ?? null,
        }
      );
      return;
    }
    case "removeProvenance": {
      await r.update(`${PREFIXES}
      DELETE DATA { ${provenanceTriples(op.nodeId, op.provenance)} }`);
      await write(
        `MATCH (n { id: $id })
         REMOVE n.sourceSystem, n.timestamp, n.license, n.ontologyVersion`,
        { id: op.nodeId }
      );
      return;
    }
    case "setFlagResolved": {
      // Overlay-only: SHACL flags come from the static TTL; resolving is a
      // reversible runtime suppression, never a baseline edit.
      markFlagResolved(op.nodeId, op.flag);
      return;
    }
    case "clearFlagResolved": {
      clearFlagResolved(op.nodeId, op.flag);
      return;
    }
    case "addManualFlag": {
      // Overlay-only ADDITIVE flag (mirror of setFlagResolved): a human reviewer
      // raises a flag on a node. No graph data touched, so the baseline stays
      // byte-identical and removeManualFlag is an exact inverse.
      assertSafeIdent(op.nodeId, "node id");
      markManualFlag(op.nodeId, op.flag, op.reason);
      return;
    }
    case "removeManualFlag": {
      assertSafeIdent(op.nodeId, "node id");
      clearManualFlag(op.nodeId, op.flag);
      return;
    }
    case "addEdgeTag": {
      // Overlay-only ADDITIVE edge tag (mirror of addManualFlag): a reviewer tags
      // an edge. No graph data touched, so the baseline stays byte-identical and
      // removeEdgeTag is an exact inverse.
      assertSafeIdent(op.source, "node id");
      assertSafeIdent(op.target, "node id");
      assertSafeIdent(op.kind, "edge kind");
      markEdgeTag(op.source, op.kind, op.target, op.tag, op.reason);
      return;
    }
    case "removeEdgeTag": {
      assertSafeIdent(op.source, "node id");
      assertSafeIdent(op.target, "node id");
      assertSafeIdent(op.kind, "edge kind");
      clearEdgeTag(op.source, op.kind, op.target, op.tag);
      return;
    }
  }
}

/** Apply a list of ops forward, in order. */
export async function applyOps(ops: ChangeOp[]): Promise<void> {
  for (const op of ops) await applyOp(op);
}
