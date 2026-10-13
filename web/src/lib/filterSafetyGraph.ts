/**
 * Client-side filtering for the UC4 patient-safety subgraph (SafetyRadarBeat).
 *
 * The FAIR-canvas analog is `filterGraph.ts`; this is its safety-native sibling.
 * The FAIR rail's four dimensions do NOT all map here: safety subject nodes carry
 * no per-node `readiness` and there is no human-verified set, so those two would
 * hide everything / do nothing. The dimensions that ARE grounded in the safety
 * findings are used instead: node kind, SHACL **severity** (P0/P1/P2), **risk
 * type**, and unsafe/flagged.
 *
 * Like `applyFilters`, this only ever HIDES nodes the BFF already sent — it never
 * adds a node or edge, so the grounding invariant holds. It always unions the
 * `keep` ids (the open finding's evidence path) back in, so a filter can NEVER
 * drop a node the currently-lit path traverses.
 */
import type { GraphPayload, RiskSeverity, SafetyRiskType } from "@rnd/shared";

export interface SafetyGraphFilters {
  /** Allowed node kinds; empty Set = no kind restriction (show all). */
  kinds: Set<string>;
  /** SHACL severity band; "all" = no severity restriction. */
  severity: "all" | RiskSeverity;
  /** Risk type; "all" = no risk-type restriction. */
  riskType: "all" | SafetyRiskType;
  /** Show only unsafe (flagged) subjects. */
  flaggedOnly: boolean;
}

/** A filter state that restricts nothing — the default. */
export const EMPTY_SAFETY_FILTERS: SafetyGraphFilters = {
  kinds: new Set<string>(),
  severity: "all",
  riskType: "all",
  flaggedOnly: false,
};

/** True when the filters would hide nothing (lets callers skip work). */
export function isNoopSafetyFilter(f: SafetyGraphFilters): boolean {
  return (
    f.kinds.size === 0 &&
    f.severity === "all" &&
    f.riskType === "all" &&
    !f.flaggedOnly
  );
}

/**
 * Return a filtered payload: nodes that pass every active filter, plus any node in
 * `keep` (the open finding's path — never hidden), and the edges whose BOTH
 * endpoints survive.
 *
 * `severityById` / `riskTypesById` / `flagged` are derived from the served
 * findings; nodes absent from those maps (context nodes — drugs, labs, concepts)
 * are, like the FAIR band filter's unscored nodes, excluded once a severity or
 * risk-type band is chosen, so the graph narrows to the implicated subjects.
 */
export function applySafetyFilters(
  graph: GraphPayload,
  filters: SafetyGraphFilters,
  severityById: Map<string, RiskSeverity>,
  riskTypesById: Map<string, Set<SafetyRiskType>>,
  flagged: Set<string>,
  keep: Set<string> = new Set(),
): GraphPayload {
  if (isNoopSafetyFilter(filters)) return graph;

  const passes = (id: string, kind: string): boolean => {
    if (keep.has(id)) return true; // never hide a node on the lit evidence path
    if (filters.kinds.size > 0 && !filters.kinds.has(kind)) return false;
    if (filters.severity !== "all" && severityById.get(id) !== filters.severity) {
      return false;
    }
    if (
      filters.riskType !== "all" &&
      !(riskTypesById.get(id)?.has(filters.riskType) ?? false)
    ) {
      return false;
    }
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
