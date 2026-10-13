/**
 * Groundedness verifier — a lightweight guardrail signal, NOT perfect NLP.
 *
 * The narrator already enforces grounding structurally (the model must declare
 * which node IDs it cited, validated against the path's allow-list). This is a
 * second, text-level net: given free-text and the set of known node labels/ids,
 * it extracts candidate entity mentions and flags any that don't correspond to
 * something the graph actually holds. Useful as a cheap re-validation check the
 * eval/QA harness can run over any generated answer.
 *
 * Deliberately heuristic — it errs toward catching invented proper nouns, and
 * may miss exotic phrasings. Treat `grounded:false` as "review", not "reject".
 */

/** Common English words that capitalise at sentence start but are not entities,
 *  so we don't flag them as ungrounded mentions. */
const STOPWORDS = new Set([
  "the", "a", "an", "this", "that", "these", "those", "it", "its", "is", "are",
  "was", "were", "and", "or", "but", "if", "then", "so", "to", "of", "in", "on",
  "for", "with", "by", "from", "as", "at", "we", "they", "graph", "path",
  // Common sentence-leading / connective words that capitalise but aren't entities.
  "per", "via", "also", "only", "every", "no", "not", "all", "both", "here",
  "there", "where", "when", "which", "starting", "supported",
]);

/** Extract candidate entity mentions from text:
 *   - quoted strings:            "Aspirin", 'PD-1'
 *   - ALL-CAPS-DASH ids:         AE-MYOCARDITIS, DRUG-CPI, PD-1
 *   - Capitalised multiword:     Atrial Fibrillation, Checkpoint Pathway
 *  This is intentionally generous; false candidates are filtered by the
 *  allow-list match below. */
function extractCandidates(text: string): string[] {
  const found = new Set<string>();

  // Quoted strings (single or double).
  for (const m of text.matchAll(/["']([^"']{2,})["']/g)) found.add(m[1].trim());

  // ALL-CAPS / dashed identifiers (AE-MYOCARDITIS, DRUG-CPI, PD-1, PRR).
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)) found.add(m[0].trim());

  // Capitalised words / multiword phrases (Atrial Fibrillation). Single
  // capitalised words that are stopwords/sentence-starters are dropped below.
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g)) found.add(m[0].trim());

  return [...found].filter((c) => c && !STOPWORDS.has(c.toLowerCase()));
}

/**
 * @param text  free-text answer/narration to check.
 * @param knownLabelsAndIds  node labels + ids the graph actually holds (the allow-list).
 * @returns grounded=true when no candidate mention is unaccounted for.
 */
export function groundedness(
  text: string,
  knownLabelsAndIds: string[]
): { grounded: boolean; ungroundedTerms: string[] } {
  // Case-insensitive substring match in BOTH directions: a candidate is grounded
  // if it appears inside any known string, or any known string appears inside it
  // (so "PD-1" matches a "...PD-1..." label and vice-versa).
  const known = knownLabelsAndIds.map((k) => k.toLowerCase());
  const isGrounded = (cand: string): boolean => {
    const c = cand.toLowerCase();
    return known.some((k) => k.includes(c) || c.includes(k));
  };

  const ungroundedTerms = extractCandidates(text).filter((c) => !isGrounded(c));
  return { grounded: ungroundedTerms.length === 0, ungroundedTerms };
}
