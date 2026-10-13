/**
 * Beat 1 — FAIR / ALCOA+ readiness scoring.
 *
 * Slice 1c: the inference moved onto the native RDF reasoner. The defects are no
 * longer detected by hand-coded JS over Neo4j rows — they are now reported by
 * SHACL (with the sh:sparql extension) over the canonical RDF graph, and the
 * nodes enumerated with SPARQL. "The graph reasons" — this module just reshapes
 * the reasoner's output into the @rnd/shared RiskReport / GatedConclusion the
 * server already serves. The readiness formula (base − penalty·flags) and the
 * gate semantics (deductive → auto-accept, statistical → human-review) are
 * preserved byte-for-byte at the API boundary; the gated conclusions now also
 * carry a real inference trace (the derivation chain behind each conclusion).
 *
 * These thin wrappers keep risk.ts's public signatures so server.ts is unchanged.
 */
import {
  getFairConformance,
  getGatedConclusions as getGatedConclusionsFromReasoner,
} from "../reasoner/service.js";
import type { RiskReport, GatedConclusion } from "@rnd/shared";

/** FAIR / ALCOA+ readiness, sourced from the canonical reasoner (SHACL+SPARQL). */
export async function getRiskReport(): Promise<RiskReport> {
  return getFairConformance();
}

/**
 * HITL surface: the deductive conclusion is an OWL/rule ENTAILMENT (auto-accept);
 * the statistical one is a threshold, now reasoner-reported, routed to a human.
 * Each carries a real inference trace; the extra `trace` field is additive and
 * assignable to GatedConclusion, so the API contract is unchanged.
 */
export async function getGatedConclusions(): Promise<GatedConclusion[]> {
  return getGatedConclusionsFromReasoner();
}
