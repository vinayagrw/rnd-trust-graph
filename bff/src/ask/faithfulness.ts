/**
 * Faithfulness scoring (F1) + per-claim hallucination tracing (F4).
 *
 * SCORING ONLY — same non-negotiable discipline as the FinOps ledger: this module
 * runs AFTER the grounded agent has produced an answer. It reads the served answer
 * text and the attributes of the nodes the answer actually cited, and reports how
 * well the answer is traceable to that cited evidence. It NEVER edits the answer,
 * NEVER adds an agent tool, and NEVER writes. A low score surfaces a visible
 * low-confidence stamp upstream; it never silently suppresses an answer.
 *
 * The core (`scoreFaithfulness`) is deterministic and pure so it is unit-testable:
 * a fabricated claim (named entities/figures absent from the cited evidence) drops
 * the score and lands in `unsupportedClaims`. An optional LLM judge can refine the
 * verdict, but the deterministic core is always the floor and the fallback.
 */
import type {
  GraphNode,
  FaithfulnessResult,
  FaithfulnessBand,
  ClaimTrace,
} from "@rnd/shared";

/** Words too common to count as evidence overlap. Kept deliberately small —
 *  over-pruning would let a fabricated claim look "supported" by filler. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "have", "has",
  "are", "was", "were", "which", "while", "their", "there", "these", "those",
  "between", "within", "about", "also", "than", "then", "they", "them", "its",
  "via", "per", "but", "not", "all", "any", "can", "may", "one", "two", "three",
  "based", "shows", "show", "found", "links", "link", "linked", "answer",
  "graph", "node", "nodes", "evidence", "data", "value", "values",
]);

/** Node-id token, e.g. AE-MYOCARDITIS, STAT-MYO-CPI, LIT-PMID-20694011. */
const NODE_ID_RE = /[A-Z]{2,}-[A-Z0-9-]+/g;
/** A number with optional decimal, e.g. 12, 7.8, 0.001. */
const NUMBER_RE = /\d+(?:\.\d+)?/g;
/** A "word" salient enough to carry meaning (>=4 letters). */
const WORD_RE = /[a-z]{4,}/g;

/** Fixed band cutoffs for the score (0..1). Gate threshold is separate (config). */
function bandFor(score: number): FaithfulnessBand {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
}

/** Salient tokens (the things that make a claim checkable): node ids, numbers,
 *  and content words. Returned per-category so matching uses the right vocab. */
function salientTokens(text: string): { ids: string[]; numbers: string[]; words: string[] } {
  const ids = (text.match(NODE_ID_RE) ?? []).map((s) => s.toLowerCase());
  const lower = text.toLowerCase();
  // Strip the id tokens before scanning numbers/words so an id's digits don't
  // double-count as standalone numbers.
  const withoutIds = lower.replace(NODE_ID_RE, " ");
  const numbers = withoutIds.match(NUMBER_RE) ?? [];
  const words = (withoutIds.match(WORD_RE) ?? []).filter((w) => !STOPWORDS.has(w));
  return { ids, numbers, words };
}

/** The evidence vocabulary one cited node contributes (id parts, label words,
 *  kind, and every attr key/value), bucketed by category for precise matching. */
function nodeVocab(node: GraphNode): { ids: Set<string>; numbers: Set<string>; words: Set<string> } {
  const ids = new Set<string>();
  const numbers = new Set<string>();
  const words = new Set<string>();
  // The full id and its hyphen-separated parts.
  ids.add(node.id.toLowerCase());
  for (const part of node.id.toLowerCase().split("-")) if (part) ids.add(part);
  const bag = [node.label ?? "", node.kind ?? ""];
  if (node.attrs) {
    for (const [k, v] of Object.entries(node.attrs)) bag.push(String(k), String(v));
  }
  if (node.provenance) {
    bag.push(node.provenance.sourceSystem ?? "", node.provenance.code ?? "");
  }
  const text = bag.join(" ").toLowerCase();
  for (const n of text.match(NUMBER_RE) ?? []) numbers.add(n);
  for (const w of text.match(WORD_RE) ?? []) if (!STOPWORDS.has(w)) words.add(w);
  // Some labels carry codes like "(49436004)" — already captured as numbers.
  return { ids, numbers, words };
}

/** Split an answer into atomic claims (sentence-ish). Trims fences/bullets. */
export function extractClaims(answer: string): string[] {
  return answer
    .replace(/```[\s\S]*?```/g, " ") // drop code fences (Cypher echoes etc.)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s*\-•\d.)]+/, "").trim())
    .filter((s) => s.length >= 8); // ignore tiny fragments / headers, keep short claims like "PRR is 7.8."
}

/** Does this claim's salient vocab intersect the cited evidence? Returns the ids
 *  of nodes that supplied a match (best-effort, for the per-claim trace). */
function traceClaim(
  claim: string,
  perNode: { id: string; vocab: ReturnType<typeof nodeVocab> }[]
): { salient: boolean; supportingNodeIds: string[] } {
  const tok = salientTokens(claim);
  const salient = tok.ids.length + tok.numbers.length + tok.words.length > 0;
  if (!salient) return { salient: false, supportingNodeIds: [] };
  const supporting = new Set<string>();
  for (const { id, vocab } of perNode) {
    const hit =
      tok.ids.some((t) => vocab.ids.has(t)) ||
      tok.numbers.some((t) => vocab.numbers.has(t)) ||
      tok.words.some((t) => vocab.words.has(t));
    if (hit) supporting.add(id);
  }
  return { salient: true, supportingNodeIds: [...supporting] };
}

/**
 * Context-recall (F2, deterministic): of the salient entities NAMED IN THE
 * QUESTION, what fraction appear in the cited evidence? A RAGAS-style "did we
 * retrieve the right facts?" proxy. Pure + unit-testable. A question with no
 * checkable entities recalls 1 (nothing to miss).
 */
export function contextRecall(question: string, citedNodes: GraphNode[]): number {
  const tok = salientTokens(question);
  const total = tok.ids.length + tok.numbers.length + tok.words.length;
  if (total === 0) return 1;
  const vocabs = citedNodes.map((n) => nodeVocab(n));
  let covered = 0;
  for (const t of tok.ids) if (vocabs.some((v) => v.ids.has(t))) covered += 1;
  for (const t of tok.numbers) if (vocabs.some((v) => v.numbers.has(t))) covered += 1;
  for (const t of tok.words) if (vocabs.some((v) => v.words.has(t))) covered += 1;
  return Math.round((covered / total) * 100) / 100;
}

/**
 * Deterministic faithfulness score (pure, unit-tested). A claim that carries
 * named entities/figures but shares NONE of them with the cited evidence is
 * "unsupported"; a claim with no checkable tokens is treated as neutral (it can
 * neither confirm nor fabricate). Score = supported / evidence-bearing claims.
 */
export function scoreFaithfulness(answer: string, citedNodes: GraphNode[]): FaithfulnessResult {
  const citedNodeIds = citedNodes.map((n) => n.id);
  const perNode = citedNodes.map((n) => ({ id: n.id, vocab: nodeVocab(n) }));
  const claims = extractClaims(answer);

  const traces: ClaimTrace[] = [];
  let evidenceBearing = 0;
  let supported = 0;
  const unsupportedClaims: string[] = [];

  for (const claim of claims) {
    const { salient, supportingNodeIds } = traceClaim(claim, perNode);
    if (!salient) {
      traces.push({ claim, supported: true, supportingNodeIds: [] });
      continue;
    }
    evidenceBearing += 1;
    const isSupported = supportingNodeIds.length > 0;
    if (isSupported) supported += 1;
    else unsupportedClaims.push(claim);
    traces.push({ claim, supported: isSupported, supportingNodeIds });
  }

  // No cited evidence at all, or no checkable claims → score is undefined-ish;
  // report 0 when there ARE claims but nothing to cite (can't be grounded), else
  // 1 when there is simply nothing checkable to contradict.
  const score =
    evidenceBearing === 0
      ? citedNodes.length === 0 && claims.length > 0
        ? 0
        : 1
      : Math.round((supported / evidenceBearing) * 100) / 100;

  return {
    score,
    band: bandFor(score),
    method: "deterministic",
    unsupportedClaims,
    citedNodeIds,
    claims: traces,
  };
}
