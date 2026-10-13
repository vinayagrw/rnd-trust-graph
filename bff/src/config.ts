import "dotenv/config";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

// PATH self-heal — the root-cause fix for "Claude went inactive even though it
// worked before". User-level installers (Claude Code, uv/uvx) land in
// ~/.local/bin, but a BFF launched from a shell started BEFORE the tool was
// installed there won't have it on PATH. The live-probe (`spawn("claude",
// ["--version"])`) then fails, liveMode reads false, and the whole app silently
// falls back to scripted narration — with nothing broken in the code. Prepend
// the user bin dir (idempotently) so spawning `claude`/`uvx` resolves regardless
// of which shell launched the process. Portable: only acts if the dir exists.
const userBin = join(homedir(), ".local", "bin");
if (existsSync(userBin)) {
  const parts = (process.env.PATH ?? "").split(delimiter);
  if (!parts.includes(userBin)) {
    process.env.PATH = `${userBin}${delimiter}${process.env.PATH ?? ""}`;
  }
}

/** Central config. Live mode is OFF whenever there is no API key — the demo
 *  then runs fully offline on cached narration.
 *
 *  Per-surface model knobs (all env-overridable, hot-read at process start):
 *
 *  NARRATE_MODEL   — model for one-shot narration (safe to use a smaller/cheaper
 *                    model; output is validated + structurally grounded before
 *                    reaching the audience). Default: NARRATOR_MODEL.
 *  ASK_MODEL       — model for the /ask tool-loop (must handle multi-turn Cypher
 *                    tool-calls and coherent grounded reasoning; do NOT downgrade
 *                    below a Sonnet-tier model unless you test correctness).
 *                    Default: NARRATOR_MODEL.
 *
 *  Per-surface timeout/turn knobs:
 *
 *  NARRATE_IDLE_TIMEOUT_MS  — idle watchdog for one narration CLI call (ms).
 *                             Default: 20 000.
 *  NARRATE_HARD_TIMEOUT_MS  — absolute abort cap for narration (ms).
 *                             Default: 30 000.
 *  NARRATE_MAX_TOKENS       — max_tokens passed to cloud Messages API (narration).
 *                             Default: 400.
 *  ASK_IDLE_TIMEOUT_MS      — idle watchdog per MCP tool-loop iteration (ms).
 *                             The CLI goes quiet while uvx runs a Cypher query;
 *                             must be > the worst-case Neo4j round-trip.
 *                             Default: 45 000.
 *  ASK_HARD_TIMEOUT_MS      — absolute abort cap for a full /ask run (ms).
 *                             Default: 300 000 (a grounded board run was
 *                             measured at ~144 s end to end; 120 000 cut it off
 *                             before any prose was emitted, which silently
 *                             disabled the Generative Studio).
 *  ASK_MAX_TURNS            — --max-turns passed to the `claude` CLI for /ask.
 *                             Must be >= 3 (schema + query + answer).
 *                             Default: 12.
 *
 *  The legacy NARRATOR_TIMEOUT_MS / CLAUDE_MAX_TURNS remain as the base
 *  (narrator.timeoutMs / narrator.claudeMaxTurns) but are now unused by the
 *  primary paths — kept for backward compat and the diag probe.
 */
export const config = {
  port: Number(process.env.BFF_PORT ?? 8787),
  corsOrigin: (process.env.BFF_CORS_ORIGIN ?? "http://localhost:5173").split(","),

  neo4j: {
    uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
    user: process.env.NEO4J_USER ?? "neo4j",
    password: process.env.NEO4J_PASSWORD ?? "demo-password-change-me",
    database: process.env.NEO4J_DATABASE ?? "neo4j",
  },

  narrator: {
    // LLM transport: "api" = cloud Messages API (needs ANTHROPIC_API_KEY);
    // "claude-code" = spawn the local `claude` CLI (subscription auth, no key).
    provider: (process.env.LLM_PROVIDER ?? "api") as "api" | "claude-code",
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    /** Shared base model (used when a surface-specific override is absent). */
    model: process.env.NARRATOR_MODEL ?? "claude-opus-4-8",
    /** Legacy idle-watchdog default (ms). Narration and /ask use surface-specific
     *  values below; this remains for backward compat and the diag probe. */
    timeoutMs: Number(process.env.NARRATOR_TIMEOUT_MS ?? 6000),
    // Local Claude Code CLI provider.
    claudeBin: process.env.CLAUDE_BIN ?? "claude",
    /** Legacy max-turns default; superseded by surface-specific values below. */
    claudeMaxTurns: Number(process.env.CLAUDE_MAX_TURNS ?? 6),
    // Air-gapped (Wave 2) — OpenAI-compatible local gateway. Empty = cloud.
    localBaseUrl: process.env.LOCAL_MODEL_BASE_URL ?? "",
    localModel: process.env.LOCAL_MODEL_NAME ?? "",
  },

  /** Per-surface LLM knobs for the /narrate path (one-shot, no tool-loop).
   *  Narration is structurally grounded + citation-validated before output, so
   *  a cheaper/smaller model is safe here — use claude-haiku-4-5-20251001 to
   *  cut tokens while keeping grounding intact. */
  narrate: {
    /** Model for narration. Defaults to the shared narrator.model so existing
     *  deployments without NARRATE_MODEL are unaffected. */
    model: process.env.NARRATE_MODEL ?? process.env.NARRATOR_MODEL ?? "claude-opus-4-8",
    /** Idle watchdog for the structured narration CLI call (ms). */
    idleTimeoutMs: Number(process.env.NARRATE_IDLE_TIMEOUT_MS ?? 20_000),
    /** Absolute hard-abort cap for the entire narration run (ms). */
    hardTimeoutMs: Number(process.env.NARRATE_HARD_TIMEOUT_MS ?? 30_000),
    /** max_tokens passed to the cloud Messages API (narration only). */
    maxTokens: Number(process.env.NARRATE_MAX_TOKENS ?? 400),
  },

  /** Per-surface LLM knobs for the /ask path (multi-turn tool-loop over Neo4j).
   *  Do NOT use a Haiku-tier model here without correctness testing — the agent
   *  must produce valid Cypher and reason over multi-hop graph paths. */
  ask: {
    /** Model for the /ask tool-loop. Defaults to shared narrator.model. */
    model: process.env.ASK_MODEL ?? process.env.NARRATOR_MODEL ?? "claude-opus-4-8",
    /** Idle watchdog per MCP iteration (ms). Must outlast the worst Neo4j RTT. */
    idleTimeoutMs: Number(process.env.ASK_IDLE_TIMEOUT_MS ?? 45_000),
    /** Absolute hard-abort cap for a full /ask run (ms). */
    hardTimeoutMs: Number(process.env.ASK_HARD_TIMEOUT_MS ?? 300_000),
    /** --max-turns for the `claude` CLI during /ask. Min 3 (schema+query+answer). */
    maxTurns: Math.max(3, Number(process.env.ASK_MAX_TURNS ?? 12)),
  },

  mcp: {
    readOnly: (process.env.NEO4J_MCP_READONLY ?? "true") === "true",
    // mcp-neo4j-cypher version uvx resolves. Pinned to 0.6.0 for reproducibility
    // (the once-assumed 1.5.3 does not exist on PyPI; 0.6.0 is the working version).
    version: process.env.NEO4J_MCP_VERSION ?? "0.6.0",
  },
} as const;

/** True when we can make live model calls; otherwise scripted/cached only. */
export const liveModeAvailable = (): boolean =>
  config.narrator.provider === "claude-code" ||
  Boolean(config.narrator.apiKey) ||
  Boolean(config.narrator.localBaseUrl);
