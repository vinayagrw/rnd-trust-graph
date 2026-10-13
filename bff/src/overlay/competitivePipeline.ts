/**
 * F8 — competitive-pipeline overlay (synthetic, grounding-safe).
 *
 * A curated, CLEARLY-SYNTHETIC set of competitor pipeline nodes that COMPETES_WITH
 * our real drugs/targets. This payload is served from its OWN endpoint
 * (GET /api/overlay/competitive) and merged CLIENT-SIDE only — it is NEVER written
 * to Neo4j or the RDF store, so its ids never enter `loadValidNodeIds()` and the
 * grounded agent can never cite one. Every node carries `synthetic: true` so the
 * canvas renders it distinctly (dashed) and it can't be mistaken for real evidence.
 * The baseline graph/TTL stays byte-identical; this is a labelled visual overlay.
 */
import type { CompetitiveOverlay, GraphEdge, GraphNode } from "@rnd/shared";

/** All overlay node ids share this prefix so they're trivially identifiable (and
 *  trivially assertable as absent from the grounding allow-list in tests). */
export const COMPETITIVE_ID_PREFIX = "EXT-PIPE-";

interface Rival {
  id: string;
  label: string;
  competesWith: string; // a REAL node id (our drug/target)
  sponsor: string;
  phase: string;
}

const RIVALS: Rival[] = [
  {
    id: "EXT-PIPE-RIVAL-PD1",
    label: "Competitor anti-PD-1 (synthetic)",
    competesWith: "DRUG-CPI",
    sponsor: "Synthetic Pharma A",
    phase: "Phase 3",
  },
  {
    id: "EXT-PIPE-RIVAL-VEGFR",
    label: "Competitor VEGFR inhibitor (synthetic)",
    competesWith: "DRUG-VEGFR",
    sponsor: "Synthetic Pharma B",
    phase: "Phase 2",
  },
  {
    id: "EXT-PIPE-RIVAL-BTK",
    label: "Competitor BTK inhibitor (synthetic)",
    competesWith: "DRUG-BTK",
    sponsor: "Synthetic Pharma C",
    phase: "Phase 3",
  },
  {
    id: "EXT-PIPE-RIVAL-JAK1",
    label: "Competitor JAK1 inhibitor (synthetic)",
    competesWith: "TGT-JAK1",
    sponsor: "Synthetic Pharma D",
    phase: "Phase 1",
  },
];

/** Build the synthetic competitive overlay. Pure + deterministic (no I/O). */
export function getCompetitiveOverlay(): CompetitiveOverlay {
  const nodes: GraphNode[] = RIVALS.map((r) => ({
    id: r.id,
    kind: "ExternalPipeline",
    label: r.label,
    synthetic: true,
    attrs: { sponsor: r.sponsor, phase: r.phase, status: "synthetic-overlay" },
    provenance: {
      sourceSystem: "Synthetic competitive overlay (illustrative, not real data)",
      timestamp: "",
      license: "synthetic",
    },
  }));
  const edges: GraphEdge[] = RIVALS.map((r) => ({
    id: `${r.id}-COMPETES_WITH-${r.competesWith}`,
    source: r.id,
    target: r.competesWith,
    kind: "COMPETES_WITH",
    label: "competes with",
  }));
  return { synthetic: true, nodes, edges };
}
