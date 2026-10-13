/**
 * Client-side graph filtering for the Trust Workbench filters rail.
 *
 * `applyFilters` only ever HIDES nodes the BFF already sent — it never adds a
 * node or edge, so the grounding invariant is preserved. Critically, it always
 * unions the `keep` ids (the grounded `active`/cited highlight) back into the
 * result so a filter can NEVER drop a node the current answer cited (which would
 * otherwise read as "the answer cited a node that isn't there").
 */
import type { GraphPayload } from "@rnd/shared";

/** Readiness bands (mirrors the radar's readinessColor breakpoints). */
export type ReadinessBand = "all" | "high" | "mid" | "low";

export interface GraphFilters {
  /** Allowed node kinds; empty Set = no kind restriction (show all). */
  kinds: Set<string>;
  readinessBand: ReadinessBand;
  verifiedOnly: boolean;
  flaggedOnly: boolean;
}

/** A filter state that restricts nothing — the default. */
export const EMPTY_FILTERS: GraphFilters = {
  kinds: new Set<string>(),
  readinessBand: "all",
  verifiedOnly: false,
  flaggedOnly: false,
};

/** True when the filters would hide nothing (lets callers skip work). */
export function isNoopFilter(f: GraphFilters): boolean {
  return (
    f.kinds.size === 0 &&
    f.readinessBand === "all" &&
    !f.verifiedOnly &&
    !f.flaggedOnly
  );
}

function inBand(score: number | undefined, band: ReadinessBand): boolean {
  if (band === "all") return true;
  if (score == null) return false; // a band filter excludes unscored nodes
  if (band === "high") return score >= 70;
  if (band === "mid") return score >= 40 && score < 70;
  return score < 40; // low
}

/**
 * Return a filtered payload: nodes that pass every active filter, plus any node
 * in `keep` (grounded/active ids that must never be hidden), and the edges whose
 * BOTH endpoints survive.
 */
export function applyFilters(
  graph: GraphPayload,
  filters: GraphFilters,
  readiness: Map<string, number>,
  verified: Set<string>,
  flagged: Set<string>,
  keep: Set<string> = new Set(),
): GraphPayload {
  if (isNoopFilter(filters)) return graph;

  const passes = (id: string, kind: string): boolean => {
    if (keep.has(id)) return true; // never hide a cited/active node
    if (filters.kinds.size > 0 && !filters.kinds.has(kind)) return false;
    if (!inBand(readiness.get(id), filters.readinessBand)) return false;
    if (filters.verifiedOnly && !verified.has(id)) return false;
    if (filters.flaggedOnly && !flagged.has(id)) return false;
    return true;
  };

  const nodes = graph.nodes.filter((n) => passes(n.id, n.kind as string));
  const surviving = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter(
    (e) => surviving.has(e.source) && surviving.has(e.target),
  );
  return { nodes, edges };
}
