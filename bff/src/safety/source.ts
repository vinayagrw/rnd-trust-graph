/**
 * Safety data source — where the subject-safety A-Box comes from. Production
 * fidelity: the radar reasons over a graph loaded from a SOURCE, and this is the
 * documented seam between the committed demo fixture and a live clinical feed
 * (a CSV export, a FHIR bundle, a CTMS extract). The reasoner + SHACL detection,
 * the corrective writer, and the trend are all source-agnostic — only this
 * adapter changes when a deployment points at real (governed, de-identified) data.
 *
 * TRUST: a source only PROVIDES the graph to load; it never bypasses SHACL
 * detection, the authorized writer, or the FAIR-canvas isolation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SAFETY_TTL_PATH = join(here, "..", "..", "..", "data", "rdf", "safety.ttl");

export interface SafetySource {
  /** A short, human id for the source (shown in diagnostics). */
  readonly id: string;
  /** Return the subject-safety graph as a Turtle document to load into the reasoner. */
  loadTurtle(): Promise<string> | string;
}

/** The committed demo fixture (data/rdf/safety.ttl). Deterministic, PHI-free. */
export class FixtureSafetySource implements SafetySource {
  readonly id = "fixture:safety.ttl";
  loadTurtle(): string {
    return readFileSync(SAFETY_TTL_PATH, "utf-8");
  }
}

/**
 * Production stub — a live feed (CSV/FHIR/CTMS export mapped to the rtg: vocab).
 * Wired by config in a real deployment; throws until implemented so a
 * misconfigured "live" mode fails loudly instead of silently loading nothing.
 */
export class LiveSafetySource implements SafetySource {
  readonly id = "live:configured-feed";
  loadTurtle(): Promise<string> {
    // TODO(production): pull the governed, de-identified subject feed and map it
    // to the rtg: safety vocabulary. Intentionally unimplemented in the demo.
    return Promise.reject(
      new Error("LiveSafetySource not configured — set a safety data feed endpoint"),
    );
  }
}

/** The active source. Fixture by default; a live deployment swaps this. */
export function getSafetySource(): SafetySource {
  return process.env.SAFETY_SOURCE_MODE === "live"
    ? new LiveSafetySource()
    : new FixtureSafetySource();
}
