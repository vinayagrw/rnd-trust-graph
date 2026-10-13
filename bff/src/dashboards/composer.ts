/**
 * Dashboard composer — LLM-primary, template-safety-net.
 *
 * Runs AFTER a grounded answer has settled. The LLM chooses WHICH widgets to show
 * and over WHICH cited nodes; it never supplies data. Two hard guarantees make this
 * safe regardless of what the model returns:
 *
 *   1. The composer — not the model — sets the grounding root (`citedNodeIds`) to
 *      the answer's REAL citations, and filters every `widget.nodeIds` down to that
 *      set. The model literally cannot reference a node the answer did not cite.
 *   2. The assembled spec is validated by `validateSpec` (Zod `.strict()` + grounding
 *      refinement) before it is returned. On ANY failure — parse error, bad or empty
 *      widgets, timeout, or live mode unavailable — the deterministic template
 *      `templateDashboard` is returned instead. The caller always gets a valid spec.
 *
 * Latency note: this is a second one-shot LLM call on top of the answer. It is only
 * attempted when live mode is available; otherwise the template is returned
 * immediately. The local CLI is slow (10–25s) — the `LLM_PROVIDER=api` path is the
 * documented latency lever, and the frontend reveals widgets progressively so the
 * wait is masked.
 */
import { randomUUID } from "node:crypto";
import type { DashboardSpec, DashboardWidget, GraphNode } from "@rnd/shared";
import { liveModeAvailable, config } from "../config.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { extractCompleteObjects } from "../llm/partialJson.js";
import { log } from "../log.js";
import { validateSpec } from "./schema.js";
import { templateDashboard } from "./template.js";

/** Hard cap on the composer LLM call — independent of the idle watchdog so a slow
 *  model can never stall the response; we drop to the template instead. */
const COMPOSE_TIMEOUT_MS = 30_000;

const KNOWN_KINDS = new Set<DashboardWidget["kind"]>([
  "citation-chips",
  "coverage-header",
  "evidence-ledger",
  "evidence-subgraph",
  "stat-chart",
  "hero-flow",
  "metric",
]);

export interface ComposeInput {
  question: string;
  /** The grounded answer text — context for the model's title/intent choices. */
  answerText: string;
  /** The REAL cited nodes (already intersected with the live graph). */
  citedNodes: Pick<GraphNode, "id" | "kind" | "label">[];
  strategy?: string;
}

/** Compose a grounded dashboard for a settled answer. Never throws; always returns
 *  a valid `DashboardSpec` (LLM-composed when possible, else the template). */
export async function composeDashboard(input: ComposeInput): Promise<DashboardSpec> {
  const templateOf = () =>
    templateDashboard({ question: input.question, citedNodes: input.citedNodes, strategy: input.strategy });

  // No citations ⇒ nothing to ground on. (The caller already gates on this, but be
  // defensive — an empty dashboard must never be emitted.)
  if (input.citedNodes.length === 0) return templateOf();

  // Live mode off ⇒ skip the slow LLM call entirely and paint the template.
  if (!liveModeAvailable()) return templateOf();

  try {
    const raw = await runComposerLlm(input);
    if (!raw) return templateOf();
    return composeFromModelText(raw, input);
  } catch (err) {
    log.warn(`[dashboards] compose failed (${err instanceof Error ? err.message : String(err)}) — using template`);
    return templateOf();
  }
}

/**
 * Pure (LLM-free) assembly: parse the model's raw text, inject the composer-owned
 * grounding root, filter to the real cited set, validate, and return the spec — or
 * the deterministic template on any failure. Exported so the grounding guarantees
 * can be tested deterministically without spawning the CLI.
 */
export function composeFromModelText(raw: string, input: ComposeInput): DashboardSpec {
  const templateOf = () =>
    templateDashboard({ question: input.question, citedNodes: input.citedNodes, strategy: input.strategy });
  const spec = assembleSpec(raw, input);
  if (!spec) return templateOf();
  const result = validateSpec(spec);
  if (!result.ok) {
    log.warn(`[dashboards] composed spec rejected (${result.error}) — using template`);
    return templateOf();
  }
  return result.spec;
}

/** Drive one one-shot LLM completion and return its raw text (or null on failure). */
function runComposerLlm(input: ComposeInput): Promise<string | null> {
  const prompt = buildComposerPrompt(input);
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
  // Unref so the timer never keeps the process alive on its own.
  (hardStop as unknown as { unref?: () => void }).unref?.();

  let text = "";
  return runClaudeCode({
    prompt,
    sink: (event) => {
      if (event.type === "token" && typeof event.text === "string") text += event.text;
    },
    signal: controller.signal,
    // Pure text completion — NO tools (the answer already did the graph work).
    allowedTools: undefined,
    maxTurns: 1,
    idleTimeoutMs: COMPOSE_TIMEOUT_MS,
    emitToolTrace: false,
    model: config.narrator.model,
    finopsSurface: "dashboard",
  })
    .then((res) => (res.ok && text.trim() ? text : null))
    .finally(() => clearTimeout(hardStop));
}

/** The composer instruction. Constrained hard: JSON only, fixed widget kinds, only
 *  the listed cited ids, and an explicit ban on emitting any value/number/url/markup
 *  (the schema enforces this structurally too — belt and braces). */
function buildComposerPrompt(input: ComposeInput): string {
  const nodeLines = input.citedNodes
    .slice(0, 40)
    .map((n) => `  - ${n.id} [${n.kind}] ${String(n.label).replace(/\s+/g, " ").slice(0, 60)}`)
    .join("\n");
  return [
    "You compose a small DASHBOARD LAYOUT for a grounded answer in a knowledge-graph app.",
    "You choose WHICH widgets to show and over WHICH cited nodes — you never provide data;",
    "the app computes every number, chart, and diagram itself.",
    "",
    "Return ONLY a JSON object, no prose, no markdown fences, matching exactly:",
    '{ "title": string, "intent": string, "widgets": [',
    '  { "id": string, "kind": KIND, "title"?: string, "nodeIds"?: string[], "metric"?: METRIC, "span"?: 1|2 }',
    "] }",
    "",
    "KIND is one of: citation-chips | coverage-header | evidence-ledger | evidence-subgraph | stat-chart | hero-flow | metric.",
    "METRIC (only for kind:metric) is one of: faithfulness | cited-count | coverage.",
    "Rules: 3–6 widgets; every nodeIds entry MUST be one of the cited ids listed below;",
    "use stat-chart only if a SignalStat node is cited; do NOT invent numbers, URLs, HTML, or ids;",
    "do NOT add any field beyond those shown; do NOT emit an approval/HITL widget.",
    "",
    `Question: ${input.question}`,
    `Answer (for titling only): ${input.answerText.replace(/\s+/g, " ").slice(0, 500)}`,
    "Cited nodes:",
    nodeLines,
    "",
    "JSON:",
  ].join("\n");
}

/** Filter ONE candidate widget to the inert, grounded contract: known kind,
 *  nodeIds ⊆ cited set, metric only on a metric tile. Returns the clean widget
 *  or null. This is the SINGLE grounding filter — the full assemble and the
 *  streaming path both call it, so a partial can never widen grounding. */
export function filterWidget(w: unknown, citedSet: Set<string>): DashboardWidget | null {
  if (!w || typeof w !== "object") return null;
  const kind = (w as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind as DashboardWidget["kind"])) return null;
  const widget: DashboardWidget = { id: safeId((w as { id?: unknown }).id), kind: kind as DashboardWidget["kind"] };
  const title = (w as { title?: unknown }).title;
  if (typeof title === "string" && title.trim()) widget.title = title.slice(0, 120);
  const nodeIds = (w as { nodeIds?: unknown }).nodeIds;
  if (Array.isArray(nodeIds)) {
    const filtered = nodeIds.filter((id): id is string => typeof id === "string" && citedSet.has(id));
    if (filtered.length) widget.nodeIds = filtered.slice(0, 64);
  }
  const metric = (w as { metric?: unknown }).metric;
  if (widget.kind === "metric") {
    if (metric === "faithfulness" || metric === "cited-count" || metric === "coverage") widget.metric = metric;
    else return null;
  }
  const span = (w as { span?: unknown }).span;
  if (span === 1 || span === 2) widget.span = span;
  return widget;
}

/** Recover every FULLY-CLOSED widget object from a growing `widgets:[…]` buffer.
 *  A widget whose closing brace has not yet arrived is never returned (draw-
 *  nothing preserved). Tolerates a leading `{ "title": …, "widgets": [` prefix
 *  and trailing partial content. Thin wrapper over the shared brace-balanced
 *  scanner (`../llm/partialJson.js`), which the generative composer also uses. */
export function extractCompleteWidgets(buffer: string): unknown[] {
  return extractCompleteObjects(buffer, "widgets");
}

/** Compose a dashboard with GENUINE token-streaming: emits `onDelta` with a
 *  one-widget partial spec the instant each widget closes, then returns the final
 *  reconciled spec (idempotent — the caller's lineage store de-dupes by id). On
 *  no-cites / live-off / any failure, returns the template and emits NO delta. */
export async function composeDashboardStreaming(
  input: ComposeInput,
  onDelta: (spec: DashboardSpec) => void,
): Promise<DashboardSpec> {
  const templateOf = () =>
    templateDashboard({ question: input.question, citedNodes: input.citedNodes, strategy: input.strategy });
  if (input.citedNodes.length === 0 || !liveModeAvailable()) return templateOf();

  const citedSet = new Set(input.citedNodes.map((n) => n.id));
  const groundingRoot = input.citedNodes.map((n) => n.id);
  const emittedIds = new Set<string>();
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
  (hardStop as unknown as { unref?: () => void }).unref?.();
  let buffer = "";
  const flush = () => {
    for (const raw of extractCompleteWidgets(buffer)) {
      if (emittedIds.size >= 8) break; // match assembleSpec's 8-widget cap (trust-sidecar parity)
      const fw = filterWidget(raw, citedSet);
      if (!fw || emittedIds.has(fw.id)) continue;
      emittedIds.add(fw.id);
      // Grounding root re-injected on EVERY partial — composer-owned, never the model's.
      onDelta({ version: 1, title: "Evidence dashboard", intent: input.question.slice(0, 400), widgets: [fw], citedNodeIds: groundingRoot, source: "llm" });
    }
  };
  try {
    const res = await runClaudeCode({
      prompt: buildComposerPrompt(input),
      sink: (event) => {
        if (event.type === "token" && typeof event.text === "string") { buffer += event.text; flush(); }
      },
      signal: controller.signal,
      allowedTools: undefined,
      maxTurns: 1,
      idleTimeoutMs: COMPOSE_TIMEOUT_MS,
      emitToolTrace: false,
      streamPartial: true,
      model: config.narrator.model,
      finopsSurface: "dashboard",
    });
    clearTimeout(hardStop);
    // Final reconciliation from the whole buffer (idempotent; same validate+template net).
    return res.ok && buffer.trim() ? composeFromModelText(buffer, input) : templateOf();
  } catch {
    clearTimeout(hardStop);
    return templateOf();
  }
}

/** Parse the model's raw text and assemble a candidate spec with the composer-owned
 *  grounding root injected. Returns null if no JSON object could be recovered. */
function assembleSpec(raw: string, input: ComposeInput): DashboardSpec | null {
  const obj = extractJsonObject(raw);
  if (!obj || typeof obj !== "object") return null;

  const citedSet = new Set(input.citedNodes.map((n) => n.id));
  const modelWidgets = Array.isArray((obj as { widgets?: unknown }).widgets)
    ? ((obj as { widgets: unknown[] }).widgets as unknown[])
    : [];

  const widgets: DashboardWidget[] = [];
  for (const w of modelWidgets) {
    const fw = filterWidget(w, citedSet);
    if (fw) widgets.push(fw);
    if (widgets.length >= 8) break;
  }

  if (widgets.length === 0) return null;

  const modelTitle = (obj as { title?: unknown }).title;
  return {
    version: 1,
    title: typeof modelTitle === "string" && modelTitle.trim() ? modelTitle.slice(0, 120) : "Evidence dashboard",
    intent: input.question.slice(0, 400),
    widgets,
    // GROUNDING ROOT — composer-owned, always the real cited ids (never the model's).
    citedNodeIds: input.citedNodes.map((n) => n.id),
    source: "llm",
  };
}

/** Recover the first balanced JSON object from raw model text (tolerates ``` fences
 *  and leading/trailing prose). Returns the parsed value or null. */
function extractJsonObject(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** A stable, safe widget id — falls back to a random id if the model omitted one. */
function safeId(v: unknown): string {
  if (typeof v === "string") {
    const s = v.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    if (s) return s;
  }
  return `w-${randomUUID().slice(0, 8)}`;
}
