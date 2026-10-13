/**
 * SKOS terminology surface (GET /api/terminology).
 *
 * Honest doc-gap fill: we parse the hand-authored SKOS thesaurus
 * (data/skos/thesaurus.ttl) into JSON — prefLabel / altLabel (synonyms) and
 * broader / narrower (hierarchy). This is real, version-controlled vocabulary
 * data, NOT a live OWL reasoner. A small purpose-built Turtle reader is used so
 * we add no new dependency (the file shape is constrained and known).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface SkosConcept {
  id: string; // local name, e.g. "CON-MYOCARDITIS"
  prefLabel: string;
  altLabels: string[];
  broader: string[];
  narrower: string[];
  notation?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
// bff/src/graph -> repo root data/skos/thesaurus.ttl
const THESAURUS = join(here, "..", "..", "..", "data", "skos", "thesaurus.ttl");

/** Strip a leading rtg: prefix and surrounding quotes from a Turtle token. */
function clean(token: string): string {
  return token.trim().replace(/^rtg:/, "").replace(/^"|"(@\w+)?$/g, "");
}

/**
 * Minimal Turtle reader tuned to thesaurus.ttl: split on subject blocks
 * terminated by " .", then pick out the skos predicates we serve. Handles the
 * `;`-separated predicate-object lists and repeated altLabel/broader/narrower.
 */
export function parseThesaurus(turtle: string): SkosConcept[] {
  const concepts: SkosConcept[] = [];
  // Each subject block ends with a line that is just " ." (statement terminator).
  // Normalise newlines and split on a period that closes a statement.
  const blocks = turtle
    .split(/\.\s*\n/)
    .map((b) => b.trim())
    .filter((b) => /a\s+skos:Concept\b(?!Scheme)/.test(b));

  for (const block of blocks) {
    const idMatch = block.match(/rtg:(\S+)\s+a\s+skos:Concept\b(?!Scheme)/);
    if (!idMatch) continue;
    const id = idMatch[1];

    const pref = block.match(/skos:prefLabel\s+"([^"]+)"/);
    const altLabels = [...block.matchAll(/skos:altLabel\s+"([^"]+)"/g)].map((m) => m[1]);
    const broader = [...block.matchAll(/skos:broader\s+rtg:(\S+?)\s*[;.]/g)].map((m) =>
      clean(m[1])
    );
    const narrower = [...block.matchAll(/skos:narrower\s+rtg:(\S+?)\s*[;.]/g)].map((m) =>
      clean(m[1])
    );
    const notation = block.match(/skos:notation\s+"([^"]+)"/);

    concepts.push({
      id,
      prefLabel: pref ? pref[1] : id,
      altLabels,
      broader,
      narrower,
      notation: notation ? notation[1] : undefined,
    });
  }
  return concepts;
}

/** Load + parse the on-disk thesaurus. Returns [] if the file is missing. */
export function getTerminology(): SkosConcept[] {
  try {
    const turtle = readFileSync(THESAURUS, "utf-8");
    return parseThesaurus(turtle);
  } catch {
    return [];
  }
}
