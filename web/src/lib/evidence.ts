/**
 * Known / Missing / Conflicting classification — the single source of truth shared
 * by the in-thread EvidenceLedger, the citation chips, the coverage/conflict header
 * and the AnswerCanvas. Grounded-by-construction: it classifies ONLY real cited
 * nodes using the graph's OWN defect markers (the documented noise nodes the radar
 * flags) — it never fabricates a gap.
 */
import type { GraphNode, GraphPayload } from "@rnd/shared";

const CONFLICT_IDS = new Set(["AE-CONFLICT"]);
const GAP_IDS = new Set(["TGT-NOPROV", "DRUG-ORPHAN", "CON-STALE"]);

export function isConflict(n: GraphNode): boolean {
  return CONFLICT_IDS.has(n.id) || /conflict|refuted|contradict/i.test(`${n.id} ${n.label}`);
}
export function isGap(n: GraphNode): boolean {
  return GAP_IDS.has(n.id) || /no[-_ ]?prov|orphan|stale|unmapped/i.test(`${n.id} ${n.label}`);
}

/** The classification bucket a cited node falls into. */
export type EvidenceKind = "known" | "missing" | "conflicting";
export function classify(n: GraphNode): EvidenceKind {
  if (isConflict(n)) return "conflicting";
  if (isGap(n)) return "missing";
  return "known";
}

/** Tone (colour) per bucket — shared so chips, ledger and header never diverge. */
export const EVIDENCE_TONE: Record<EvidenceKind, string> = {
  known: "#2dd4bf",
  missing: "#d29922",
  conflicting: "#f85149",
};

export interface EvidenceBuckets {
  known: GraphNode[];
  missing: GraphNode[];
  conflicting: GraphNode[];
}

export function classifyCited(cited: GraphNode[]): EvidenceBuckets {
  return {
    conflicting: cited.filter(isConflict),
    missing: cited.filter((n) => !isConflict(n) && isGap(n)),
    known: cited.filter((n) => !isConflict(n) && !isGap(n)),
  };
}

/** Coverage = known / total cited, 0..1. A banded, honest signal (not false
 *  precision): it answers "how much of what the answer leaned on is solid?" */
export function coverage(b: EvidenceBuckets): number {
  const total = b.known.length + b.missing.length + b.conflicting.length;
  return total === 0 ? 0 : b.known.length / total;
}

/** Resolve cited ids against the real payload, dropping unknown ids (never
 *  fabricated) — the same intersection GroundedDiagrams performs. */
export function resolveCited(citedNodeIds: string[], graph: GraphPayload): GraphNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return citedNodeIds
    .map((id) => byId.get(id))
    .filter((n): n is GraphNode => Boolean(n));
}
