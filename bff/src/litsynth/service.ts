/**
 * F7 — Literature evidence synthesis (source-ranked, inline-cited).
 *
 * SYNTHESIS OVER SERVED EVIDENCE ONLY. This is the narrator discipline applied to
 * literature: we fetch the relevant `LiteratureAbstract` nodes read-only, rank them
 * by source class, and pass ONLY those abstracts to a structured synth that MUST
 * cite by node id. Every inline `[LIT-PMID-…]` citation is then enforced ⊆ the
 * supplied ids (reusing `validateGrounding`); an off-list citation refuses the whole
 * narrative and we fall back to a deterministic template that merely restates the
 * served summaries. The model never sees anything but the abstracts we hand it, and
 * it can never cite a paper that is not in the supplied set. Read-only; no writes,
 * no agent tool, no new answer source — an evidence-summary layer beside `/ask`.
 */
import type { GraphNode, LiteratureSynthesis, RankedAbstract } from "@rnd/shared";
import { config, liveModeAvailable } from "../config.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { getFullGraph } from "../graph/queries.js";
import { validateGrounding, extractJson } from "../narrate/narrator.js";
import { log } from "../log.js";

type Sink = (event: { type: string; [k: string]: unknown }) => void;

/** A literature node id, used to scan a narrative for inline citations. */
const LIT_ID_RE = /LIT-PMID-[0-9]+/g;

/** Source-class tiers (lower = stronger evidence class). Deterministic + honest:
 *  regulatory > trial registry > peer-reviewed journal > other. The demo corpus is
 *  all PubMed (Journal), so the effective tie-break is recency. */
function sourceTier(source: string): { tier: number; tierLabel: string } {
  const s = source.toLowerCase();
  if (/fda|ema|regulator|label|smpc/.test(s)) return { tier: 1, tierLabel: "Regulatory" };
  if (/clinicaltrials|trial|nct|registry/.test(s)) return { tier: 2, tierLabel: "Clinical trial" };
  if (/pubmed|medline|journal|doi/.test(s)) return { tier: 3, tierLabel: "Journal" };
  return { tier: 4, tierLabel: "Other" };
}

/** Year out of an ISO-ish timestamp (e.g. "2026-06-10T00:00:00Z" → 2026). */
function yearOf(ts?: string): number | undefined {
  if (!ts) return undefined;
  const m = ts.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

/** Source-rank a set of literature nodes (pure, unit-tested). Sort by tier asc,
 *  then year desc, then id asc for stability; assign 1-based `rank`. */
export function rankSources(nodes: GraphNode[]): RankedAbstract[] {
  const mapped: Omit<RankedAbstract, "rank">[] = nodes.map((n) => {
    const source = n.provenance?.sourceSystem ?? "unknown";
    const { tier, tierLabel } = sourceTier(source);
    const summary = String(n.attrs?.summary ?? "").trim();
    return {
      nodeId: n.id,
      title: n.label,
      summary,
      source,
      tier,
      tierLabel,
      year: yearOf(n.provenance?.timestamp),
    };
  });
  mapped.sort(
    (a, b) =>
      a.tier - b.tier ||
      (b.year ?? 0) - (a.year ?? 0) ||
      a.nodeId.localeCompare(b.nodeId),
  );
  return mapped.map((m, i) => ({ ...m, rank: i + 1 }));
}

/** Gather the literature nodes relevant to a focus node and/or a free-text topic.
 *  - focusNodeId: keep abstracts that MENTIONS the focus (or the focus itself if it
 *    is a LiteratureAbstract).
 *  - topic: keep abstracts whose title/summary contains a salient topic token.
 *  - neither: all literature nodes. Capped at `limit` after ranking. */
export async function gatherAbstracts(
  focusNodeId?: string,
  topic?: string,
  limit = 6,
): Promise<RankedAbstract[]> {
  const graph = await getFullGraph("all");
  const lit = graph.nodes.filter((n) => n.kind === "LiteratureAbstract");

  let selected = lit;
  if (focusNodeId) {
    const mentioning = new Set(
      graph.edges
        .filter((e) => e.kind === "MENTIONS" && e.target === focusNodeId)
        .map((e) => e.source),
    );
    const byFocus = lit.filter((n) => mentioning.has(n.id) || n.id === focusNodeId);
    if (byFocus.length) selected = byFocus;
  } else if (topic && topic.trim()) {
    const tokens = topic.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    if (tokens.length) {
      const byTopic = lit.filter((n) => {
        const hay = `${n.label} ${String(n.attrs?.summary ?? "")}`.toLowerCase();
        return tokens.some((t) => hay.includes(t));
      });
      if (byTopic.length) selected = byTopic;
    }
  }

  return rankSources(selected).slice(0, limit);
}

/** The structured-synthesis prompt: the model may ONLY cite from the allow-list and
 *  must return a single-line JSON object. Mirrors the narrator's hard-constraint
 *  contract so `validateGrounding` can enforce it. */
function buildSynthPrompt(ranked: RankedAbstract[]): string {
  const allowed = ranked.map((r) => r.nodeId);
  const sources = ranked
    .map(
      (r) =>
        `${r.rank}. [${r.nodeId}] (${r.tierLabel}${r.year ? `, ${r.year}` : ""}) ${r.title}: ${r.summary}`,
    )
    .join("\n");
  return [
    "You are a biomedical evidence summarizer. Synthesize ONLY the abstracts below.",
    "",
    "HARD CONSTRAINT: you may ONLY reference the abstracts in the allow-list. Do not",
    "invent findings, papers, numbers, or entities that are not in the supplied text.",
    "Cite every claim inline using the bracketed node id of its source, e.g. [LIT-PMID-27959767].",
    "",
    "Return ONLY a JSON object on a single line, no markdown fences, of the exact shape:",
    `{"narrative": "<3-4 sentence synthesis with inline [LIT-PMID-…] citations>", "citedNodeIds": ["<id>", ...]}`,
    "Every inline [LIT-PMID-…] id and every entry of citedNodeIds MUST be in the allow-list.",
    "",
    `Allowed node IDs: ${JSON.stringify(allowed)}`,
    "Abstracts (ranked by source):",
    sources,
  ].join("\n");
}

/** Deterministic, fabrication-proof fallback: restate the served summaries with
 *  their ids. Never invents — every sentence is a supplied abstract. */
function fallbackSynthesis(ranked: RankedAbstract[]): LiteratureSynthesis {
  if (!ranked.length) {
    return {
      narrative: "No literature abstracts are available for this topic in the graph.",
      citedNodeIds: [],
      ranked,
      isFallback: true,
    };
  }
  const lead =
    ranked.length === 1
      ? "One source in the graph speaks to this:"
      : `${ranked.length} sources in the graph, ranked by source class, speak to this:`;
  const body = ranked.map((r) => `[${r.nodeId}] ${r.summary}`).join(" ");
  return {
    narrative: `${lead} ${body}`.trim(),
    citedNodeIds: ranked.map((r) => r.nodeId),
    ranked,
    isFallback: true,
  };
}

/** Run the structured synth through the local CLI and ENFORCE grounding twice:
 *  (1) validateGrounding on citedNodeIds, (2) an inline scan so any [LIT-PMID-…] in
 *  the narrative text that is off the allow-list refuses the whole thing. On any
 *  failure we return the deterministic fallback — never an ungrounded narrative. */
async function synthesizeLive(
  ranked: RankedAbstract[],
  signal: AbortSignal,
): Promise<LiteratureSynthesis> {
  let buf = "";
  const collect: Sink = (e) => {
    if (e.type === "token" && typeof e.text === "string") buf += e.text;
  };
  const result = await runClaudeCode({
    prompt: buildSynthPrompt(ranked),
    sink: collect,
    signal,
    model: config.narrate.model,
    idleTimeoutMs: config.narrate.idleTimeoutMs,
    finopsSurface: "litsynth",
  });
  if (!result.ok) return fallbackSynthesis(ranked);
  return groundOrFallback(buf, ranked);
}

/** Pure grounding enforcement (unit-tested): given the model's raw text and the
 *  ranked abstracts, return a grounded synthesis, or the deterministic fallback if
 *  EITHER the JSON citedNodeIds OR any inline [LIT-PMID-…] is off the allow-list.
 *  This is the structural guarantee — an off-list paper can never be surfaced. */
export function groundOrFallback(raw: string, ranked: RankedAbstract[]): LiteratureSynthesis {
  const allowed = ranked.map((r) => r.nodeId);
  const allowedSet = new Set(allowed);
  // (1) JSON-level grounding: citedNodeIds must be a subset of the allow-list.
  // The synth contract names the prose field `narrative`; the shared
  // validateGrounding reads `narration`, so adapt the key before validating.
  const parsed = extractJson(raw) as { narrative?: unknown; citedNodeIds?: unknown } | null;
  const verdict = validateGrounding(allowed, {
    narration: parsed?.narrative,
    citedNodeIds: parsed?.citedNodeIds,
  });
  if (!verdict.ok) {
    if (verdict.reason === "ungrounded") {
      log.warn(`[litsynth] refused — off-list citedNodeIds: ${verdict.offPath.join(", ")}`);
    }
    return fallbackSynthesis(ranked);
  }
  // (2) Inline grounding: every LIT-PMID token IN THE NARRATIVE must be allow-listed.
  const inline = verdict.narration.match(LIT_ID_RE) ?? [];
  const offInline = inline.filter((id) => !allowedSet.has(id));
  if (offInline.length > 0) {
    log.warn(`[litsynth] refused — off-list inline citations: ${offInline.join(", ")}`);
    return fallbackSynthesis(ranked);
  }
  // Union the JSON-declared cites with the inline ones actually present.
  const cited = [...new Set([...verdict.citedNodeIds, ...inline])].filter((id) => allowedSet.has(id));
  return { narrative: verdict.narration, citedNodeIds: cited, ranked, isFallback: false };
}

/** Produce a literature synthesis for a focus node and/or topic (non-streaming;
 *  the streaming wrapper below reuses it). Deterministic fallback when the live LLM
 *  is unavailable, so this never fabricates and never throws. */
export async function synthesizeLiterature(
  input: { focusNodeId?: string; topic?: string },
  signal?: AbortSignal,
): Promise<LiteratureSynthesis> {
  const ranked = await gatherAbstracts(input.focusNodeId, input.topic);
  if (!ranked.length) return fallbackSynthesis(ranked);

  const isClaudeCode = config.narrator.provider === "claude-code";
  if (!liveModeAvailable() || !isClaudeCode) return fallbackSynthesis(ranked);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.narrate.hardTimeoutMs);
  // If the caller's signal aborts, propagate.
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await synthesizeLive(ranked, controller.signal);
  } catch {
    return fallbackSynthesis(ranked);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Stream a literature synthesis for the SSE route: emit the ranked source list
 *  first (so the UI can show provenance immediately), then the validated citations,
 *  then the narrative word-by-word, then done. Mirrors `narrate()`'s shape. */
export async function streamLiteratureSynthesis(
  input: { focusNodeId?: string; topic?: string },
  sink: Sink,
  signal?: AbortSignal,
): Promise<void> {
  const synth = await synthesizeLiterature(input, signal);
  sink({ type: "ranked", ranked: synth.ranked });
  sink({ type: "citations", nodeIds: synth.citedNodeIds });
  const words = synth.narrative.split(" ");
  for (let i = 0; i < words.length; i++) {
    sink({ type: "token", text: (i ? " " : "") + words[i] });
  }
  sink({ type: "done", isFallback: synth.isFallback });
}
