/**
 * Beat 3 — multimodal resolve. Takes a PathologyImage / OmicsProfile node,
 * reads its pre-computed embedding, and runs a REAL cosine-kNN against the
 * Neo4j native vector index to find the ontology Concept it grounds to.
 * onPath = that concept maps (RESOLVES_TO) to a node already on the hero path.
 */
import { read } from "../neo4j.js";
import type { ResolveResult, ResolveMatch, GraphNode } from "@rnd/shared";

const HERO_PATH_NODE_IDS = new Set([
  "AE-MYOCARDITIS",
  "DRUG-CPI",
  "TGT-PDCD1",
  "PW-CHECKPOINT",
  "STAT-MYO-CPI",
  "EV-FAERS",
  "EV-PMID",
]);

export async function resolveNode(nodeId: string, k = 3): Promise<ResolveResult> {
  // db.index.vector.queryNodes is the CURRENT procedure (not "SEARCH ... IN").
  const rows = await read<{
    cid: string;
    label: string;
    score: number;
    onPath: boolean;
  }>(
    `MATCH (src { id: $nodeId })
     WHERE src.embedding IS NOT NULL
     CALL db.index.vector.queryNodes('concept_embeddings', $k, src.embedding)
     YIELD node AS concept, score
     OPTIONAL MATCH (concept)-[:RESOLVES_TO]->(onPathNode)
     RETURN concept.id AS cid, concept.label AS label, score AS score,
            count(onPathNode) > 0 AS onPath
     ORDER BY score DESC`,
    { nodeId, k }
  );

  const matches: ResolveMatch[] = rows.map((r) => {
    const concept: GraphNode = { id: r.cid, kind: "Concept", label: r.label };
    return {
      concept,
      score: Number(r.score),
      onPath: Boolean(r.onPath) || HERO_PATH_NODE_IDS.has(r.cid),
    };
  });

  return { sourceNodeId: nodeId, matches };
}
