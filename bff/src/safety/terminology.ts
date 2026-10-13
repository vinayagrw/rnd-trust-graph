/**
 * Terminology resolver — turns an unmapped local code into a current MedDRA /
 * SNOMED concept, so the `unmapped-local-code` remediation writes a REAL mapping
 * (rtg:MAPS_TO a concept) rather than a text label. Production fidelity: this is
 * the seam a live terminology service (UMLS/MedDRA API, a loaded subset) plugs
 * into — the fixture below covers the demo codes; `LiveTerminologyResolver` is the
 * documented production stub.
 *
 * TRUST: resolution is DATA look-up only. The mapping it returns is applied by the
 * authorized safety-writer (safety/ops.ts) as a reversible governed change; it
 * never reaches the read-only agent/MCP path and never fabricates a clinical fact.
 */

/** A resolved terminology concept for a local code. */
export interface ResolvedConcept {
  /** rtg: local id of the concept node the code maps to (created if absent). */
  conceptId: string;
  /** Human label, e.g. "Drug-induced liver injury (MedDRA 10072268)". */
  label: string;
  /** The terminology code, e.g. "10072268". */
  code: string;
  /** Source terminology + version, e.g. "MedDRA v27.1". */
  system: string;
  /** Ontology version stamp, e.g. "2025-09". */
  ontologyVersion: string;
}

export interface TerminologyResolver {
  /** Resolve a local code string to a current concept, or null if unmapped. */
  resolve(localCode: string): ResolvedConcept | null;
}

/**
 * Fixture resolver — a small committed map covering the demo's local codes. The
 * baseline safety.ttl already maps SITE-RASH-01 → CON-RASH; this resolves the
 * UNMAPPED SITE-HEPTOX-07 (SUBJ-206) to a real MedDRA concept so the correction
 * is grounded, not invented.
 */
export class FixtureTerminologyResolver implements TerminologyResolver {
  private readonly map: Record<string, ResolvedConcept> = {
    "SITE-HEPTOX-07": {
      conceptId: "CON-HEPTOX",
      label: "Drug-induced liver injury (MedDRA 10072268)",
      code: "10072268",
      system: "MedDRA v27.1",
      ontologyVersion: "2025-09",
    },
    "SITE-RASH-01": {
      conceptId: "CON-RASH",
      label: "Rash (MedDRA 10037844)",
      code: "10037844",
      system: "MedDRA v27.1",
      ontologyVersion: "2025-09",
    },
  };

  resolve(localCode: string): ResolvedConcept | null {
    return this.map[localCode] ?? null;
  }
}

/**
 * Production stub — a live terminology service (MedDRA/SNOMED API or a loaded
 * subset). Wired by config in a real deployment; throws until implemented so a
 * misconfigured "live" mode fails loudly instead of silently mis-mapping.
 */
export class LiveTerminologyResolver implements TerminologyResolver {
  resolve(_localCode: string): ResolvedConcept | null {
    // TODO(production): call the terminology service (UMLS/MedDRA) and map the
    // best-match concept. Intentionally unimplemented in the demo build.
    throw new Error("LiveTerminologyResolver not configured — set a terminology endpoint");
  }
}

/** The active resolver. Fixture by default; a live deployment swaps this. */
export function getTerminologyResolver(): TerminologyResolver {
  return process.env.TERMINOLOGY_MODE === "live"
    ? new LiveTerminologyResolver()
    : new FixtureTerminologyResolver();
}
