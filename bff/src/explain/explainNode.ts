/**
 * Per-node AI explanation — "the graph supplies the facts, the LLM phrases them."
 *
 * Mirrors narrator.ts discipline exactly: we gather the node's REAL context (its
 * kind/label/attrs/provenance + its 1-hop neighbours + any defect-flag reason),
 * hand the model an explicit allow-list of legal entity IDs, force it to declare
 * which IDs it cited, and ENFORCE (validateGrounding) that every cited ID is in
 * the supplied set. An off-list citation refuses the whole explanation and we drop
 * to a deterministic TEMPLATED fallback assembled from the same real facts.
 *
 * GROUNDING is the whole point: the model may only reference the node + its
 * neighbours we provide; with nothing grounded to say it says so, never invents.
 * FinOps usage is recorded (observability only) under surface 'explain-node'.
 */
import type { GraphNode } from "@rnd/shared";
import { config, liveModeAvailable } from "../config.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { record, estimateTokens } from "../finops/ledger.js";
import { getNodeContext, type NodeContext, type Neighbor } from "../graph/queries.js";
import { validateGrounding, extractJson } from "../narrate/narrator.js";
import { log } from "../log.js";

type Sink = (event: { type: string; [k: string]: unknown }) => void;

/** The four known defect nodes (Beat-1 readiness radar) and WHY each is flagged.
 *  These reasons are part of the grounded facts — the explanation may state them
 *  but the model can never invent a defect for a node that isn't on this list. */
const DEFECT_REASONS: Record<string, string> = {
  "DRUG-ORPHAN":
    "flagged: missing biological target link — fails FAIR Interoperability (no cross-source edge to a Target).",
  "CON-STALE":
    "flagged: stale ontology version — predates the currency cutoff (not 2023 or later).",
  "TGT-NOPROV":
    "flagged: missing provenance — no source system / Attributable record (ALCOA+).",
  "AE-CONFLICT":
    "flagged: conflicting annotation — two source systems disagree (Integrity defect).",
};

/** The defect reason for a node id, or null if it is not one of the 4 known defects. */
export function defectReason(id: string): string | null {
  return DEFECT_REASONS[id] ?? null;
}

/** Render one neighbour as a single grounded fact line (id + rel + direction). */
function neighborLine(n: Neighbor): string {
  const arrow = n.direction === "out" ? `—[${n.relKind}]→` : `←[${n.relKind}]—`;
  return `[${n.node.id}] ${n.node.kind}: ${n.node.label} (this node ${arrow} it)`;
}

/** Every legal entity ID the explanation may cite: the node itself + neighbours. */
export function allowedIdsFor(ctx: NodeContext): string[] {
  return [ctx.node.id, ...ctx.neighbors.map((n) => n.node.id)];
}

/** Deterministic, fact-only fallback — assembled from the real node context,
 *  identical in spirit to the narrator's offline fallback. Never invents. */
export function templatedExplanation(ctx: NodeContext): string {
  const { node, provenance, neighbors } = ctx;
  const parts: string[] = [];
  parts.push(`${node.label} is a ${node.kind} (id ${node.id}).`);
  if (provenance) {
    parts.push(
      `Its provenance is recorded: source system ${provenance.sourceSystem}` +
        (provenance.code ? `, code ${provenance.code}` : "") +
        (provenance.license ? `, license ${provenance.license}` : "") +
        "."
    );
  } else {
    parts.push("It has no recorded provenance.");
  }
  if (neighbors.length > 0) {
    const shown = neighbors.slice(0, 4).map((n) => {
      const verb = n.direction === "out" ? n.relKind : `${n.relKind} (incoming)`;
      return `${n.node.label} (${verb})`;
    });
    parts.push(`It connects to ${shown.join(", ")}.`);
  } else {
    parts.push("It has no connected entities in the graph.");
  }
  const reason = defectReason(node.id);
  if (reason) parts.push(`This node is ${reason}`);
  return parts.join(" ");
}

/** Constrained, citation-forcing prompt — same structural contract as the
 *  narrator's buildStructuredPrompt, scoped to ONE node + its neighbourhood. */
function buildPrompt(ctx: NodeContext, allowed: string[]): string {
  const { node, provenance } = ctx;
  const reason = defectReason(node.id);
  const lines: string[] = [
    "You are a knowledge-graph analyst explaining ONE node to a regulated life-sciences audience (R&D, safety, QA).",
    "In 2-4 concise sentences: lead with what this node is, then its provenance, the entities it connects to,",
    "and — only if it is flagged — why it is a data-quality defect. Be precise and neutral; do not speculate.",
    "",
    "HARD CONSTRAINT: you may ONLY reference entities from the allow-list below. Do NOT",
    "invent or name any entity, fact, study, or defect that is not in the facts provided.",
    "If the facts are too thin to say anything substantive, say so plainly rather than guess.",
    "",
    "Return ONLY a JSON object on a single line, no markdown fences, of the exact shape:",
    `{"narration": "<your explanation>", "citedNodeIds": ["<id>", ...]}`,
    "citedNodeIds MUST be a subset of the allowed IDs and list every node your text refers to.",
    "",
    `Allowed node IDs: ${JSON.stringify(allowed)}`,
    "",
    "FACTS:",
    `Node: [${node.id}] ${node.kind} — ${node.label}`,
  ];
  if (node.attrs) lines.push(`Attributes: ${JSON.stringify(node.attrs)}`);
  if (provenance) {
    lines.push(
      `Provenance: source=${provenance.sourceSystem}` +
        (provenance.code ? `, code=${provenance.code}` : "") +
        (provenance.ontologyVersion ? `, ontologyVersion=${provenance.ontologyVersion}` : "") +
        (provenance.ruleVersion ? `, ruleVersion=${provenance.ruleVersion}` : "") +
        (provenance.timestamp ? `, timestamp=${provenance.timestamp}` : "") +
        (provenance.license ? `, license=${provenance.license}` : "")
    );
  } else {
    lines.push("Provenance: NONE recorded for this node.");
  }
  if (ctx.neighbors.length > 0) {
    lines.push("Connected entities (1-hop neighbours):");
    for (const n of ctx.neighbors) lines.push(`- ${neighborLine(n)}`);
  } else {
    lines.push("Connected entities: none.");
  }
  if (reason) lines.push(`Defect flag: ${reason}`);
  return lines.join("\n");
}

/** Stream a finished string word-by-word for a natural feel (mirrors narrator). */
function streamWords(text: string, sink: Sink): void {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) sink({ type: "token", text: (i ? " " : "") + words[i] });
}

function streamFallback(ctx: NodeContext, sink: Sink, reason: string): void {
  streamWords(templatedExplanation(ctx), sink);
  sink({ type: "done", isFallback: true, reason });
}

/**
 * Orchestrate live-with-fallback for one node explanation. Always emits a stream:
 * - live path: collect → validate citations against the allow-list → only then
 *   stream the grounded explanation + a `citations` event, then done(isFallback:false).
 * - any failure / off-list citation / live-off: deterministic templated fallback,
 *   marked isFallback:true with a reason hint.
 */
export async function explainNode(nodeId: string, sink: Sink): Promise<void> {
  const ctx = await getNodeContext(nodeId);
  if (!ctx) {
    // No such node — nothing grounded to say. Emit a one-line refusal, not a guess.
    sink({ type: "token", text: `No node with id ${nodeId} exists in the graph.` });
    sink({ type: "done", isFallback: true, reason: "empty-output" });
    return;
  }

  if (!liveModeAvailable() || config.narrator.provider !== "claude-code") {
    // Offline (or cloud provider, which this surface doesn't wire) → templated.
    streamFallback(ctx, sink, "disabled");
    return;
  }

  const allowed = allowedIdsFor(ctx);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.narrate.hardTimeoutMs);
  let buf = "";
  const collect: Sink = (e) => {
    if (e.type === "token" && typeof e.text === "string") buf += e.text;
  };
  try {
    const result = await runClaudeCode({
      prompt: buildPrompt(ctx, allowed),
      sink: collect,
      signal: controller.signal,
      model: config.narrate.model,
      idleTimeoutMs: config.narrate.idleTimeoutMs,
      // FinOps: record real token usage from the CLI's terminal result message.
      finopsSurface: "explain-node",
    });
    clearTimeout(timer);
    if (!result.ok) {
      streamFallback(ctx, sink, result.reason ?? "empty-output");
      return;
    }
    // ENFORCED INVARIANT: any cited ID off the allow-list → refuse the whole
    // explanation and fall back to the deterministic, fact-only template.
    const verdict = validateGrounding(allowed, extractJson(buf));
    if (!verdict.ok) {
      if (verdict.reason === "ungrounded") {
        log.warn(`[explain-node] refused ungrounded explanation — off-list: ${verdict.offPath.join(", ")}`);
      }
      streamFallback(ctx, sink, verdict.reason === "ungrounded" ? "ungrounded" : "empty-output");
      return;
    }
    sink({ type: "citations", nodeIds: verdict.citedNodeIds });
    streamWords(verdict.narration, sink);
    sink({ type: "done", isFallback: false });
  } catch {
    clearTimeout(timer);
    streamFallback(ctx, sink, "api-error");
  }
}

export type { GraphNode };
