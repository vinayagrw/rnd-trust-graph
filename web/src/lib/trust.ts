/**
 * Trust-encoding derivations for the live graph lens.
 *
 * Both helpers derive trust signals PURELY from payloads the BFF already sends —
 * they never invent a fact:
 *   - human-verified  ← the real HUMAN_APPROVED edges in /api/graph (a reviewer
 *                        promotion written by the authorized HITL writer).
 *   - low-confidence  ← the readiness scores served by /api/risk (below a band).
 */
import type { GraphPayload } from "@rnd/shared";

/**
 * Node ids a human reviewer has verified: both endpoints of every HUMAN_APPROVED
 * edge in the payload. Derived from real edges only — an empty set until a
 * governed HITL approval adds such an edge (which then surfaces in /api/graph).
 */
export function verifiedNodeIds(graph: GraphPayload): Set<string> {
  const s = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind === "HUMAN_APPROVED") {
      s.add(e.source);
      s.add(e.target);
    }
  }
  return s;
}

/**
 * Node ids whose readiness sits below `threshold` (default 40 — the radar's
 * red band). Sourced from the /api/risk readiness Map; nodes without a readiness
 * score simply aren't included (absence ≠ low confidence).
 */
export function lowConfidenceIds(readiness: Map<string, number>, threshold = 40): Set<string> {
  const s = new Set<string>();
  for (const [id, v] of readiness) {
    if (v < threshold) s.add(id);
  }
  return s;
}
