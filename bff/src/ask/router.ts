/**
 * F3 — Adaptive retrieval routing + "why this strategy" trace.
 *
 * A small, HONEST router. It classifies a question as vector-resolve /
 * cypher-traversal / hybrid from lexical cues, and gathers REAL candidate seed
 * node ids — lexical label matches plus, for the vector/hybrid strategies, the
 * semantic kNN neighbours of the top match (the existing `resolveNode` path). The
 * seeds are handed to the agent labelled "candidates to verify"; they are NOT
 * citations and can only become one if the agent's own read-only Cypher returns
 * them in a row (the rows-only citation guard in agent.ts is untouched). The router
 * never writes, never adds a tool, and never weakens grounding — it only chooses an
 * approach and seeds real candidates.
 */
import type { RouteDecision, RetrievalStrategy } from "@rnd/shared";
import { getFullGraph } from "../graph/queries.js";
import { resolveNode } from "../graph/resolve.js";
import { log } from "../log.js";

/** Similarity / "looks like" cues → the vector path is worth seeding. */
const SIM_CUES =
  /\b(similar|look(s|ed)? like|resembl\w*|nearest|closest|comparable|related to|same (kind|type)|cluster\w*|like this)\b/i;
/** Relational / "why is X linked to Y" cues → a Cypher traversal. */
const REL_CUES =
  /\b(why|how|cause\w*|mechanism|pathway|link\w*|connect\w*|relationship|\bpath\b|evidence|support\w*|lead\w* to|associat\w*|between)\b/i;

/** Pure classification (unit-tested). Mixed cues → hybrid; neither → default to a
 *  graph traversal (the safest general approach over a knowledge graph). */
export function classify(question: string): RetrievalStrategy {
  const sim = SIM_CUES.test(question);
  const rel = REL_CUES.test(question);
  if (sim && rel) return "hybrid";
  if (sim) return "vector-resolve";
  if (rel) return "cypher-traversal";
  return "cypher-traversal";
}

const ID_RE = /[A-Z]{2,}-[A-Z0-9-]+/g;
const TOKEN_RE = /[a-z0-9]{4,}/g;

function rationaleFor(strategy: RetrievalStrategy, seeds: number): string {
  const tail = seeds
    ? ` Seeded ${seeds} candidate node${seeds === 1 ? "" : "s"} to verify against the graph.`
    : " No candidate seeds matched; the agent will explore from the schema.";
  switch (strategy) {
    case "vector-resolve":
      return `The question asks for similarity, so semantic kNN over the concept embeddings is the better entry point.${tail}`;
    case "hybrid":
      return `The question mixes similarity with a relational link, so both semantic seeding and a graph traversal apply.${tail}`;
    default:
      return `The question asks about relationships, so a read-only Cypher traversal is the right approach.${tail}`;
  }
}

/** Classify the question and gather real candidate seeds. Best-effort + guarded:
 *  a graph/vector failure degrades to "no seeds" rather than throwing. */
export async function routeQuery(question: string): Promise<RouteDecision> {
  log.debug("enter");
  const strategy = classify(question);
  const seeds = new Set<string>();

  // Explicit node-id mentions are always candidate seeds.
  for (const m of question.match(ID_RE) ?? []) seeds.add(m);

  // Lexical label matches: nodes whose label/id share salient tokens with the Q.
  let topLexical: string | undefined;
  try {
    const graph = await getFullGraph("all");
    const tokens = question.toLowerCase().match(TOKEN_RE) ?? [];
    if (tokens.length) {
      const scored = graph.nodes
        .map((n) => {
          const hay = `${n.label} ${n.id}`.toLowerCase();
          return { id: n.id, hits: tokens.filter((t) => hay.includes(t)).length };
        })
        .filter((s) => s.hits > 0)
        .sort((a, b) => b.hits - a.hits);
      topLexical = scored[0]?.id;
      for (const s of scored.slice(0, 5)) seeds.add(s.id);
    }
  } catch {
    /* no graph → no lexical seeds */
  }

  // For vector/hybrid, expand from the top lexical match via real kNN neighbours.
  if ((strategy === "vector-resolve" || strategy === "hybrid") && topLexical) {
    try {
      const res = await resolveNode(topLexical, 3);
      for (const m of res.matches) seeds.add(m.concept.id);
    } catch {
      /* the vector index may not cover this node — seeds stay lexical-only */
    }
  }

  const seedNodeIds = [...seeds].slice(0, 8);
  return { strategy, rationale: rationaleFor(strategy, seedNodeIds.length), seedNodeIds };
}
