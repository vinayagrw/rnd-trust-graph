/**
 * Suggested questions for a governed change (audit-log "ask about this change").
 *
 * Given an applied/reverted ChangeSet, produce 3–4 short reviewer questions a
 * human might ask AFTER seeing the change — each answerable from the live,
 * read-only knowledge graph (the change is already reflected there once applied).
 *
 * Two paths, mirroring the narrator's discipline:
 *   - LIVE: ask the local `claude` CLI for the questions, grounded in the change's
 *     target node + a plain-English op summary. The questions are interrogative
 *     prompts (they assert no facts), so the grounding risk is minimal; we still
 *     scope the prompt to the change + node and never feed back model output as
 *     fact. Any parse/empty/timeout failure → the deterministic templates.
 *   - FALLBACK: deterministic, op-type-aware templates derived purely from the
 *     ChangeSet — so the demo always has sensible, grounded-answerable questions
 *     even with live mode off.
 *
 * The questions are answered later by the EXISTING grounded agent (Beat 4 / the
 * read-only /ask bridge) — this module adds NO new answer path, only prompts.
 */
import type { ChangeOp, ChangeSet } from "@rnd/shared";
import { config, liveModeAvailable } from "../config.js";
import { runClaudeCode } from "../llm/claudeCode.js";

export interface SuggestedQuestions {
  questions: string[];
  /** true when the questions came from the live LLM; false = templated fallback. */
  grounded: boolean;
}

/** The node a change is "about" — its target, else the first op's node/source. */
function changeSubject(cs: ChangeSet): string {
  if (cs.targetNodeId) return cs.targetNodeId;
  const op = cs.forwardOps[0];
  if (!op) return "the affected node";
  if ("source" in op) return op.source;
  return op.nodeId;
}

/** Plain-English one-liner for a single op (reused by the prompt + as context). */
export function describeOp(op: ChangeOp): string {
  switch (op.op) {
    case "addEdge":
      return `link ${op.source} —${op.kind}→ ${op.target}`;
    case "removeEdge":
      return `remove the ${op.source} —${op.kind}→ ${op.target} link`;
    case "setProp":
      return `set ${op.nodeId}.${op.prop} = "${op.value}"`;
    case "unsetProp":
      return `clear ${op.nodeId}.${op.prop}`;
    case "addProvenance":
      return `attach provenance to ${op.nodeId}`;
    case "removeProvenance":
      return `remove provenance from ${op.nodeId}`;
    case "setFlagResolved":
      return `resolve the "${op.flag}" flag on ${op.nodeId}`;
    case "clearFlagResolved":
      return `re-open the "${op.flag}" flag on ${op.nodeId}`;
    case "addManualFlag":
      return `raise a manual "${op.flag}" flag on ${op.nodeId}`;
    case "removeManualFlag":
      return `clear the manual "${op.flag}" flag on ${op.nodeId}`;
    case "addEdgeTag":
      return `tag the ${op.source} —${op.kind}→ ${op.target} link as "${op.tag}"`;
    case "removeEdgeTag":
      return `remove the "${op.tag}" tag from the ${op.source} —${op.kind}→ ${op.target} link`;
  }
}

/** A plain-English summary of everything the change's forward ops do. */
export function describeChange(cs: ChangeSet): string {
  return cs.forwardOps.map(describeOp).join("; ");
}

/** Deterministic, grounded-answerable questions from the ChangeSet alone — the
 *  always-available fallback. General graph questions about the subject node plus
 *  one tuned to the dominant op type. */
export function templateQuestions(cs: ChangeSet): string[] {
  const subject = changeSubject(cs);
  const general = [
    `What evidence in the graph supports ${subject}?`,
    `How is ${subject} connected in the graph, and to what?`,
    `For ${subject}: what is known, what is missing, and what is conflicting?`,
  ];
  const op = cs.forwardOps[0];
  let specific: string | null = null;
  if (op) {
    switch (op.op) {
      case "addEdge":
        specific = `What does ${op.source} connect to now, and through what relationship?`;
        break;
      case "removeEdge":
        specific = `What is ${op.source} still connected to in the graph?`;
        break;
      case "setProp":
      case "unsetProp":
        specific = `What are the current properties of ${op.nodeId} in the graph?`;
        break;
      case "setFlagResolved":
      case "clearFlagResolved":
        specific = `Why was ${op.nodeId} flagged for "${op.flag}", and is the issue resolved in the graph?`;
        break;
      case "addManualFlag":
      case "removeManualFlag":
        specific = `Why might a reviewer flag ${op.nodeId}, and what evidence is there?`;
        break;
      case "addProvenance":
      case "removeProvenance":
        specific = `What is the provenance of ${op.nodeId} in the graph?`;
        break;
    }
  }
  // Lead with the op-specific question; keep the set to four.
  return (specific ? [specific, ...general] : general).slice(0, 4);
}

/** Grounded prompt: the change + its subject node, asking for graph-answerable
 *  reviewer questions as a bare JSON array of strings. */
function buildPrompt(cs: ChangeSet): string {
  const subject = changeSubject(cs);
  return [
    "You help a reviewer inspect a governed change to a knowledge graph.",
    "Suggest 3-4 SHORT questions the reviewer might ask next about the affected",
    "node, each answerable ONLY by reading the live knowledge graph (its nodes,",
    "edges, and properties). Reference the node by its id. Do NOT ask about the",
    "change log, audit metadata, who approved it, or anything not in the graph.",
    "",
    `Affected node: ${subject}`,
    `Change "${cs.title}": ${describeChange(cs)}`,
    cs.description ? `Detail: ${cs.description}` : "",
    "",
    'Return ONLY a JSON array of strings on a single line, e.g. ["...","..."].',
    "No prose, no markdown fences.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Best-effort parse of a JSON string array from model text (tolerates stray
 *  prose / code fences). Returns null if no clean array of non-empty strings. */
export function parseQuestionArray(text: string): string[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const qs = parsed
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 4);
    return qs.length > 0 ? qs : null;
  } catch {
    return null;
  }
}

/** Produce suggested questions for a change — live with a templated fallback. */
export async function suggestQuestions(cs: ChangeSet): Promise<SuggestedQuestions> {
  if (!liveModeAvailable()) {
    return { questions: templateQuestions(cs), grounded: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.narrate.hardTimeoutMs);
  let buf = "";
  try {
    const result = await runClaudeCode({
      prompt: buildPrompt(cs),
      sink: (e) => {
        if (e.type === "token" && typeof e.text === "string") buf += e.text;
      },
      signal: controller.signal,
      model: config.narrate.model,
      idleTimeoutMs: config.narrate.idleTimeoutMs,
      finopsSurface: "narrate",
    });
    clearTimeout(timer);
    if (!result.ok) return { questions: templateQuestions(cs), grounded: false };
    const qs = parseQuestionArray(buf);
    if (!qs) return { questions: templateQuestions(cs), grounded: false };
    return { questions: qs, grounded: true };
  } catch {
    clearTimeout(timer);
    return { questions: templateQuestions(cs), grounded: false };
  }
}
