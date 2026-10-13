/**
 * Narrator — "the graph reasons, the LLM narrates."
 * Live narration streams from Claude Opus 4.8; on no-key / timeout / error it
 * falls back to a pre-generated narration so the demo never stalls (§10/§11).
 *
 * Live calls use the Messages streaming API directly (stable surface). The
 * Agent SDK is reserved for /ask, where the MCP tool-loop earns its keep.
 * The path is fixed and passed in-context, so the model can only narrate
 * nodes/edges that exist — prompt-grounding now; structured-output is the
 * production hardening (verify Opus 4.8 support, header structured-outputs-2025-11-13).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExplanationPath, FallbackReason } from "@rnd/shared";
import { config, liveModeAvailable } from "../config.js";
import { getConfig } from "../config/adminConfig.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { record, estimateTokens } from "../finops/ledger.js";
import { log } from "../log.js";

const here = dirname(fileURLToPath(import.meta.url));
const FALLBACK_PATH = join(here, "../../../data/fallbacks/narrations.json");

type Sink = (event: { type: string; [k: string]: unknown }) => void;

function fallbackText(beatId: string): string {
  try {
    const cache = JSON.parse(readFileSync(FALLBACK_PATH, "utf-8")) as Record<
      string,
      { text: string }
    >;
    return cache[beatId]?.text ?? "Narration unavailable offline.";
  } catch {
    return "Narration unavailable offline.";
  }
}

function pathChain(path: ExplanationPath): string {
  return path.hops
    .map(
      (h) =>
        `${h.index}. [${h.node.id}] ${h.node.kind}: ${h.node.label}${
          h.edge ? ` (via ${h.edge.kind})` : ""
        }`
    )
    .join("\n");
}

function buildPrompt(path: ExplanationPath): string {
  // System prompt is live-editable via admin config; the scenario + path are
  // appended structurally so the model can only ever narrate real nodes/edges.
  return [
    getConfig().narratorSystemPrompt,
    `Scenario: ${path.scenario}`,
    "Path:",
    pathChain(path),
  ].join("\n");
}

/** Structured-output prompt: forces the model to declare which node IDs it cited,
 *  so we can ENFORCE (not just request) that it only grounds itself on the path.
 *  Allowed IDs are the only legal citations — anything else is refused upstream. */
function buildStructuredPrompt(path: ExplanationPath): string {
  const allowed = path.hops.map((h) => h.node.id);
  return [
    // Live-editable advisory lead-in; the HARD CONSTRAINT + JSON contract below
    // is structural and enforced by validateGrounding regardless of the prompt.
    getConfig().narratorSystemPrompt,
    "",
    "HARD CONSTRAINT: you may ONLY reference nodes from the allow-list below. Do not",
    "invent or name any entity that is not on it.",
    "",
    "Return ONLY a JSON object on a single line, no markdown fences, of the exact shape:",
    `{"narration": "<your 2-3 sentence explanation>", "citedNodeIds": ["<id>", ...]}`,
    "citedNodeIds MUST be a subset of the allowed IDs and list every node your narration refers to.",
    "",
    `Scenario: ${path.scenario}`,
    `Allowed node IDs: ${JSON.stringify(allowed)}`,
    "Path:",
    pathChain(path),
  ].join("\n");
}

/** Best-effort extraction of the first JSON object from model text (tolerates
 *  stray prose or code fences the CLI sometimes adds). */
function extractJson(text: string): { narration?: unknown; citedNodeIds?: unknown } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Pure grounding check (unit-tested): validate a parsed narration against the
 *  allow-list of legal node IDs. Off-path citations or empty narration → refused. */
export function validateGrounding(
  allowedIds: string[],
  parsed: { narration?: unknown; citedNodeIds?: unknown } | null
):
  | { ok: true; narration: string; citedNodeIds: string[] }
  | { ok: false; reason: "empty-output" | "ungrounded"; offPath: string[] } {
  const allowed = new Set(allowedIds);
  const narration = typeof parsed?.narration === "string" ? parsed.narration.trim() : "";
  const cited = Array.isArray(parsed?.citedNodeIds)
    ? parsed!.citedNodeIds.filter((x): x is string => typeof x === "string")
    : [];
  if (!narration) return { ok: false, reason: "empty-output", offPath: [] };
  const offPath = cited.filter((id) => !allowed.has(id));
  if (offPath.length > 0) return { ok: false, reason: "ungrounded", offPath };
  return { ok: true, narration, citedNodeIds: cited };
}

export { extractJson };

/** Run the structured narration through the local CLI and ENFORCE grounding.
 *  Returns the validated narration + the (path-subset) cited IDs, or a reason
 *  why it was refused (parse failure, or a citation off the allow-list). */
async function narrateStructured(
  path: ExplanationPath,
  signal: AbortSignal
): Promise<
  | { ok: true; narration: string; citedNodeIds: string[] }
  | { ok: false; reason: FallbackReason | "ungrounded" }
> {
  const allowed = new Set(path.hops.map((h) => h.node.id));
  let buf = "";
  // Collect the full reply (don't stream yet — we must validate before showing).
  const collect: Sink = (e) => {
    if (e.type === "token" && typeof e.text === "string") buf += e.text;
  };
  const result = await runClaudeCode({
    prompt: buildStructuredPrompt(path),
    sink: collect,
    signal,
    // Surface-specific model + idle watchdog: NARRATE_MODEL / NARRATE_IDLE_TIMEOUT_MS.
    model: config.narrate.model,
    idleTimeoutMs: config.narrate.idleTimeoutMs,
    // FinOps: record this narration's real token usage (observability only).
    finopsSurface: "narrate",
  });
  // Preserve the CLI's classified cause (spawn-failed / not-authenticated /
  // timeout / no-tools) so the presenter sees WHY it degraded, not just "empty".
  if (!result.ok) return { ok: false, reason: result.reason ?? "empty-output" };

  // ENFORCED INVARIANT: any cited ID off the path → refuse the whole narration.
  // Off-path entities never reach the audience; we fall back to the deterministic
  // script instead. This is the structural guarantee, not a polite request.
  const verdict = validateGrounding([...allowed], extractJson(buf));
  if (!verdict.ok) {
    if (verdict.reason === "ungrounded") {
      log.warn(`[narrate] refused ungrounded narration — off-path: ${verdict.offPath.join(", ")}`);
    }
    return { ok: false, reason: verdict.reason };
  }
  return { ok: true, narration: verdict.narration, citedNodeIds: verdict.citedNodeIds };
}

/** Stream a finished narration string word-by-word for a natural feel. */
function streamWords(text: string, sink: Sink): void {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) sink({ type: "token", text: (i ? " " : "") + words[i] });
}

/** Stream live narration token-by-token; resolves false if it failed to start. */
async function streamLive(path: ExplanationPath, sink: Sink, signal: AbortSignal): Promise<boolean> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": config.narrator.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      // Surface-specific model: configurable via NARRATE_MODEL (or NARRATOR_MODEL).
      model: config.narrate.model,
      // Configurable via NARRATE_MAX_TOKENS; 400 is enough for 2-3 sentence narration.
      max_tokens: config.narrate.maxTokens,
      stream: true,
      messages: [{ role: "user", content: buildPrompt(path) }],
    }),
  });
  if (!res.ok || !res.body) throw new Error(`narrate live ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let any = false;
  // Accumulate the streamed text + capture any usage the cloud SSE reports.
  let outText = "";
  let usageIn = 0;
  let usageOut = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = line.match(/^data:\s?(.*)$/);
      if (!m || m[1] === "[DONE]") continue;
      try {
        const evt = JSON.parse(m[1]);
        if (evt.type === "content_block_delta" && evt.delta?.text) {
          any = true;
          outText += evt.delta.text;
          sink({ type: "token", text: evt.delta.text });
        }
        // The Messages stream reports usage on message_start (input) and
        // message_delta (cumulative output) — capture real counts when present.
        if (evt.type === "message_start" && evt.message?.usage) {
          usageIn = Number(evt.message.usage.input_tokens ?? 0);
          usageOut = Number(evt.message.usage.output_tokens ?? usageOut);
        }
        if (evt.type === "message_delta" && evt.usage) {
          usageOut = Number(evt.usage.output_tokens ?? usageOut);
        }
      } catch {
        /* ignore keep-alives */
      }
    }
  }
  // FinOps: record the cloud narration's usage. Real counts when the stream
  // reported them; else estimate from text length. Marked estimated accordingly.
  if (any) {
    try {
      const hasReal = usageIn > 0 || usageOut > 0;
      record({
        surface: "narrate",
        model: config.narrate.model,
        inputTokens: hasReal ? usageIn : estimateTokens(buildPrompt(path)),
        outputTokens: hasReal ? usageOut : estimateTokens(outText),
        estimated: !hasReal,
      });
    } catch {
      /* instrumentation must never break the response path */
    }
  }
  return any;
}

function streamFallback(beatId: string, sink: Sink): void {
  // Emit the cached text in word chunks for a natural feel.
  const words = fallbackText(beatId).split(" ");
  for (let i = 0; i < words.length; i++) {
    sink({ type: "token", text: (i ? " " : "") + words[i] });
  }
}

/** Orchestrate live-with-fallback for one narration request. */
export async function narrate(beatId: string, path: ExplanationPath, sink: Sink): Promise<void> {
  if (!liveModeAvailable()) {
    streamFallback(beatId, sink);
    sink({ type: "done", isFallback: true, reason: "disabled" });
    return;
  }

  const isClaudeCode = config.narrator.provider === "claude-code";
  // The local `claude` CLI has real cold-start latency (a heavy Node process +
  // auth check) before its first token — the cloud API's first-token latency is
  // far lower. Give the CLI a generous hard cap so narration actually goes live
  // instead of tripping the short cloud-tuned timeout.
  // Both caps are configurable: NARRATE_HARD_TIMEOUT_MS (CLI) / NARRATOR_TIMEOUT_MS (cloud).
  const hardTimeoutMs = isClaudeCode ? config.narrate.hardTimeoutMs : config.narrator.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hardTimeoutMs);
  try {
    if (isClaudeCode) {
      // Structured-output enforcement: collect → validate citations against the
      // path allow-list → only then stream. Off-path citations are refused.
      const r = await narrateStructured(path, controller.signal);
      clearTimeout(timer);
      if (!r.ok) {
        streamFallback(beatId, sink);
        sink({ type: "done", isFallback: true, reason: r.reason });
      } else {
        sink({ type: "citations", nodeIds: r.citedNodeIds });
        streamWords(r.narration, sink);
        sink({ type: "done", isFallback: false });
      }
    } else {
      // Cloud Messages API: prompt-grounded streaming (structured-outputs header
      // is the production hardening path; see .env / plan).
      const ok = await streamLive(path, sink, controller.signal);
      clearTimeout(timer);
      if (!ok) {
        streamFallback(beatId, sink);
        sink({ type: "done", isFallback: true, reason: "api-error" });
      } else {
        sink({ type: "done", isFallback: false });
      }
    }
  } catch {
    clearTimeout(timer);
    streamFallback(beatId, sink);
    // The local CLI path aborts on the hard-timeout controller → surface it as a
    // timeout (the common "CLI hung" case) rather than a generic api-error.
    sink({ type: "done", isFallback: true, reason: isClaudeCode ? "timeout" : "api-error" });
  }
}
