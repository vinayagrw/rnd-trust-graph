/**
 * Grounded, refuse-if-off-path explanation of ONE subject-safety finding.
 *
 * Mirrors explain/explainNode.ts discipline exactly, but scoped to a SafetyFinding:
 * the facts are the finding's evidence path (built by SHACL over the safety
 * reasoner) PLUS the subject's REAL 1-hop neighbourhood read from Neo4j
 * (getNodeContext) — so this only works because the subjects are now projected
 * into Neo4j. The model is handed an explicit allow-list of legal node IDs (the
 * subject + its neighbours + every node on the evidence path), forced to declare
 * which it cited, and any citation off that list REFUSES the whole explanation and
 * drops to a deterministic, fact-only template. It never invents a fact, a subject,
 * or a risk that the graph did not already flag.
 */
import { config, liveModeAvailable } from "../config.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { getNodeContext, type NodeContext } from "../graph/queries.js";
import { validateGrounding, extractJson } from "../narrate/narrator.js";
import { computeSafetyFindings } from "./service.js";
import { SAFETY_POLICY, type SafetyFinding } from "@rnd/shared";
import { log } from "../log.js";

type Sink = (event: { type: string; [k: string]: unknown }) => void;

/** Every legal node id the explanation may cite: the subject, its 1-hop Neo4j
 *  neighbours, and every real node on the finding's evidence path. */
function allowedIdsFor(finding: SafetyFinding, ctx: NodeContext | null): string[] {
  const ids = new Set<string>([finding.subjectId, ...finding.affectedSubjects]);
  if (ctx) {
    ids.add(ctx.node.id);
    for (const n of ctx.neighbors) ids.add(n.node.id);
  }
  for (const step of finding.path) if (step.nodeId) ids.add(step.nodeId);
  return [...ids];
}

/** Deterministic, fact-only fallback assembled from the finding — never invents.
 *  Used offline and whenever the live model drifts off the allow-list. */
export function templatedSafetyExplanation(finding: SafetyFinding): string {
  const policy = SAFETY_POLICY[finding.riskType];
  const hops = finding.path
    .filter((s) => s.tone === "fact" || s.tone === "gap")
    .map((s) => (s.detail ? `${s.label} (${s.detail})` : s.label))
    .join(" → ");
  return [
    `${finding.subjectLabel} raises a ${policy.severity} ${policy.label.toLowerCase()} risk.`,
    `Why: ${finding.reason}`,
    hops ? `Evidence path: ${hops}.` : "",
    `Safety rule: ${policy.obligation}. ${finding.expected}.`,
    `Source systems affected: ${finding.sourceSystems.join(", ") || "—"}.`,
    `Recommended remediation: ${finding.remediation} (owner: ${finding.owner}).`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Citation-forcing prompt — the same structural contract as explainNode's, seeded
 *  with the safety finding's grounded facts + evidence path. */
function buildSafetyPrompt(finding: SafetyFinding, ctx: NodeContext | null, allowed: string[]): string {
  const policy = SAFETY_POLICY[finding.riskType];
  const lines: string[] = [
    "You are a clinical data-safety analyst explaining ONE patient-safety finding to a regulated life-sciences audience (R&D, pharmacovigilance, QA).",
    "In 2-4 concise sentences: state which subject is affected and the risk, then WHY (the relationship gap the graph found),",
    "then the source systems to fix and the recommended remediation. Be precise and neutral; do not speculate or soften.",
    "",
    "HARD CONSTRAINT: you may ONLY reference entities from the allow-list below. Do NOT",
    "invent or name any subject, prescription, drug, lab, risk, or study not in the facts provided.",
    "",
    "Return ONLY a JSON object on a single line, no markdown fences, of the exact shape:",
    `{"narration": "<your explanation>", "citedNodeIds": ["<id>", ...]}`,
    "citedNodeIds MUST be a subset of the allowed IDs and list every node your text refers to.",
    "",
    `Allowed node IDs: ${JSON.stringify(allowed)}`,
    "",
    "FACTS:",
    `Affected subject: [${finding.subjectId}] ${finding.subjectLabel}` +
      (finding.affectedSubjects.length > 1 ? ` (also: ${finding.affectedSubjects.filter((s) => s !== finding.subjectId).join(", ")})` : ""),
    `Risk: ${policy.label} (severity ${policy.severity}, owner ${policy.owner})`,
    `Why flagged (SHACL ${finding.rule}): ${finding.reason}`,
    `Expected vs actual: ${finding.expected}`,
    `Safety obligation: ${policy.obligation}`,
    `Source systems affected: ${finding.sourceSystems.join(", ") || "none recorded"}`,
    `Recommended remediation: ${finding.remediation}`,
    "Evidence path (each hop):",
    ...finding.path.map((s) => {
      const rel = s.relation ? ` [${s.relation}]` : "";
      const id = s.nodeId ? ` {${s.nodeId}}` : "";
      const detail = s.detail ? ` — ${s.detail}` : "";
      return `- (${s.tone})${rel} ${s.label}${detail}${id}`;
    }),
  ];
  if (ctx && ctx.neighbors.length > 0) {
    lines.push("Subject's connected entities (1-hop, from the graph):");
    for (const n of ctx.neighbors) {
      const arrow = n.direction === "out" ? `—[${n.relKind}]→` : `←[${n.relKind}]—`;
      lines.push(`- [${n.node.id}] ${n.node.kind}: ${n.node.label} (subject ${arrow} it)`);
    }
  }
  return lines.join("\n");
}

function streamWords(text: string, sink: Sink): void {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) sink({ type: "token", text: (i ? " " : "") + words[i] });
}

function streamFallback(finding: SafetyFinding, sink: Sink, reason: string): void {
  streamWords(templatedSafetyExplanation(finding), sink);
  sink({ type: "done", isFallback: true, reason });
}

/**
 * Explain the safety finding for `subjectId`. Always emits a stream:
 * - live path: collect → validate every cited id against the allow-list → only then
 *   stream the grounded explanation + a `citations` event, then done(isFallback:false).
 * - no such finding / any failure / off-list citation / live-off: deterministic
 *   templated fallback (isFallback:true) assembled from the finding's real facts.
 */
export async function explainSafetyFinding(subjectId: string, sink: Sink): Promise<void> {
  const { findings } = await computeSafetyFindings();
  const finding =
    findings.find((f) => f.subjectId === subjectId) ??
    findings.find((f) => f.affectedSubjects.includes(subjectId));
  if (!finding) {
    sink({ type: "token", text: `No safety finding is raised for subject ${subjectId}.` });
    sink({ type: "done", isFallback: true, reason: "empty-output" });
    return;
  }

  // Real Neo4j neighbourhood (null if Neo4j is down or the subject isn't projected).
  const ctx = await getNodeContext(subjectId).catch(() => null);
  const allowed = allowedIdsFor(finding, ctx);

  if (!liveModeAvailable() || config.narrator.provider !== "claude-code") {
    streamFallback(finding, sink, "disabled");
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.narrate.hardTimeoutMs);
  let buf = "";
  const collect: Sink = (e) => {
    if (e.type === "token" && typeof e.text === "string") buf += e.text;
  };
  try {
    const result = await runClaudeCode({
      prompt: buildSafetyPrompt(finding, ctx, allowed),
      sink: collect,
      signal: controller.signal,
      model: config.narrate.model,
      idleTimeoutMs: config.narrate.idleTimeoutMs,
      finopsSurface: "explain-node",
    });
    clearTimeout(timer);
    if (!result.ok) {
      streamFallback(finding, sink, result.reason ?? "empty-output");
      return;
    }
    const verdict = validateGrounding(allowed, extractJson(buf));
    if (!verdict.ok) {
      if (verdict.reason === "ungrounded") {
        log.warn(`[safety-explain] refused ungrounded explanation — off-list: ${verdict.offPath.join(", ")}`);
      }
      streamFallback(finding, sink, verdict.reason === "ungrounded" ? "ungrounded" : "empty-output");
      return;
    }
    sink({ type: "citations", nodeIds: verdict.citedNodeIds });
    streamWords(verdict.narration, sink);
    sink({ type: "done", isFallback: false });
  } catch {
    clearTimeout(timer);
    streamFallback(finding, sink, "api-error");
  }
}
