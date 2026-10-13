/**
 * Local Claude Code provider — drive LLM calls through the user's installed
 * `claude` CLI instead of the cloud Messages API. Auth then rides on the local
 * Claude Code login (subscription), so NO ANTHROPIC_API_KEY is needed and no
 * raw key sits in the BFF — the direction proven by a managed-agent
 * executor (clients/managed-agent/src/executors/claude-code.ts).
 *
 * We spawn `claude -p --output-format stream-json --verbose`, feed the prompt on
 * STDIN (not as a CLI arg — a multi-line prompt on the command line is mangled by
 * cmd.exe under shell:true), and parse the newline-delimited JSON on stdout,
 * emitting assistant text as tokens. For /ask we additionally pass --mcp-config
 * so the same read-only Neo4j MCP server is available to the local CLI's
 * tool-loop. Everything is guarded: any spawn or parse failure resolves false and
 * the caller drops to its safe fallback.
 */
import { spawn } from "node:child_process";
import type { FallbackReason, FinOpsSurface } from "@rnd/shared";
import { config } from "../config.js";
import { record } from "../finops/ledger.js";
import { log } from "../log.js";

type Sink = (event: { type: string; [k: string]: unknown }) => void;

export interface CliLineState {
  produced: boolean;
  pendingCypher: Set<string>;
}

/** Handle ONE parsed stdout JSON event. Pure w.r.t. I/O (no spawn/timers) so it
 *  is unit-testable. Emits assistant text as `token`s and, on the terminal
 *  `result`, records FinOps once. */
export function handleCliLine(
  evt: any,
  opts: { sink: Sink; streamPartial?: boolean; emitTrace?: boolean; finopsSurface?: FinOpsSurface; model: string },
  state: CliLineState,
): void {
  const { sink, streamPartial, emitTrace, finopsSurface, model } = opts;

  // STREAMING: raw Anthropic delta events wrapped by the CLI as `stream_event`.
  // Emit each text_delta as a token the instant it arrives.
  if (streamPartial && evt?.type === "stream_event") {
    const inner = evt.event;
    if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
      state.produced = true;
      sink({ type: "token", text: inner.delta.text });
    }
    return;
  }

  // Assistant turns carry content blocks. We emit the TOOL TRACE from here
  // (the Cypher/schema tool_use blocks) but DELIBERATELY DO NOT emit the
  // assistant `text` block as prose: the CLI's stream-json can surface the
  // same final assistant message more than once (a streamed copy plus a
  // consolidated final copy, sharing one message.id), which would double the
  // answer. The canonical, emitted-exactly-once source of the final prose is
  // the terminal `result`/`success` event handled below.
  if (emitTrace && evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type === "tool_use") {
        const name: string = block.name ?? "";
        if (name.endsWith("read_neo4j_cypher") && block.input?.query) {
          if (block.id) state.pendingCypher.add(block.id);
          sink({ type: "cypher", query: String(block.input.query) });
        } else if (name.endsWith("get_neo4j_schema")) {
          sink({ type: "step", label: "Inspected the live graph schema" });
        }
      }
    }
  }
  // The CLI's terminal event for a completed turn: subtype "success" carries
  // `result` = the full final assistant text, exactly once. This is the single
  // canonical source for the answer prose — emitting here (and NOT from the
  // assistant text blocks) guarantees the answer is never duplicated.
  if (evt?.type === "result" && evt?.subtype === "success" && typeof evt?.result === "string" && evt.result) {
    state.produced = true;
    // In streaming mode the prose already arrived via text_delta — DO NOT
    // re-emit it here (that is the double the emit-once design avoided).
    if (!streamPartial) sink({ type: "token", text: evt.result });
    // FINOPS (observability only): the terminal `result` message carries the
    // real token usage + cost for this turn. Record it to the ledger. Wrapped
    // so a ledger failure can NEVER affect the answer the user already got.
    if (finopsSurface) {
      try {
        const u = evt.usage ?? {};
        // Count cache read/creation tokens as input where present (they are
        // billed as input-side); fall back to plain input_tokens.
        const inputTokens =
          Number(u.input_tokens ?? 0) +
          Number(u.cache_read_input_tokens ?? 0) +
          Number(u.cache_creation_input_tokens ?? 0);
        const outputTokens = Number(u.output_tokens ?? 0);
        // Prefer the CLI's own total_cost_usd when it reports one; else let
        // the ledger compute from the hot-editable price table.
        const costUsd = typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : undefined;
        record({
          surface: finopsSurface,
          model,
          inputTokens,
          outputTokens,
          costUsd,
          estimated: false,
        });
      } catch {
        /* instrumentation must never break the response path */
      }
    }
  }
  // Tool results carry the rows the read-Cypher returned — pair by id.
  if (emitTrace && evt?.type === "user" && Array.isArray(evt?.message?.content)) {
    for (const block of evt.message.content) {
      if (block?.type === "tool_result" && state.pendingCypher.has(block.tool_use_id)) {
        state.pendingCypher.delete(block.tool_use_id);
        const txt = Array.isArray(block.content)
          ? block.content
              .filter((c: any) => c?.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text)
              .join("")
          : "";
        if (txt) sink({ type: "rows", preview: txt.slice(0, 600) });
      }
    }
  }
}

/** Result of a local-CLI run: did it produce text, and if not, why. */
export interface ClaudeCodeResult {
  ok: boolean;
  reason?: FallbackReason;
}

/** Classify a failed run from the CLI's stderr so the presenter sees the cause
 *  (auth vs missing MCP tools vs a dead binary) instead of a silent fallback. */
function classify(stderr: string, timedOut: boolean, hadTools: boolean): FallbackReason {
  const s = stderr.toLowerCase();
  // Missing binary: under shell:true a bad command doesn't throw — the shell
  // reports it on stderr ("not recognized" on Windows, "command not found" on *nix).
  if (/not recognized|command not found|cannot find|enoent|spawn error/.test(s)) {
    return "spawn-failed";
  }
  if (/not logged in|please run .*login|unauthorized|invalid api key|authentication/.test(s)) {
    return "not-authenticated";
  }
  if (hadTools && /mcp|uvx|tool|server.*fail|failed to connect|no such file/.test(s)) {
    return "no-tools";
  }
  if (timedOut) return "timeout";
  return "empty-output";
}

export interface ClaudeCodeRunOpts {
  prompt: string;
  sink: Sink;
  signal: AbortSignal;
  /** Path to a Claude Code MCP config JSON (enables tools, e.g. Neo4j read-only). */
  mcpConfigPath?: string;
  /** Tool allowlist; omit for a pure text completion (no tools). */
  allowedTools?: string[];
  /** Override the turn budget — a tool-loop (/ask) needs more than a one-shot narration. */
  maxTurns?: number;
  /** Idle-watchdog window (ms). A tool-loop goes quiet on stdout while it runs
   *  MCP queries, so /ask needs a far larger window than one-shot narration. */
  idleTimeoutMs?: number;
  /** When true, emit a structured "show your work" trace — the Cypher the agent
   *  ran, the rows it got back, and schema-inspection steps — as sink events.
   *  Used by /ask; narration leaves it off. */
  emitToolTrace?: boolean;
  /** Model override. When set, this takes precedence over config.narrator.model.
   *  Pass config.narrate.model for narration or config.ask.model for /ask so each
   *  surface can be tuned independently without touching the shared base model. */
  model?: string;
  /** FinOps surface tag. When set, the real token usage from the CLI's terminal
   *  `result` message is recorded to the ledger (observability only — never gates
   *  the call). Omit to skip ledger recording for an uninstrumented path. */
  finopsSurface?: FinOpsSurface;
  /** Opt-in genuine token-streaming (composer only). Adds --include-partial-messages
   *  so the CLI surfaces content_block_delta/text_delta; each text_delta is emitted
   *  as a `token`, and the terminal `result` is consumed for FinOps ONLY (not prose)
   *  so the answer never doubles. Off (default) preserves the emit-once behaviour. */
  streamPartial?: boolean;
}

/**
 * Run one prompt through the local `claude` CLI, streaming assistant text to
 * `sink`. Resolves {ok:true} if any text was produced, else {ok:false, reason}
 * with a classified cause so the caller can fall back AND log why. Never throws.
 */
export function runClaudeCode(opts: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> {
  log.debug("enter");
  const { prompt, sink, signal, mcpConfigPath, allowedTools, maxTurns } = opts;
  const hadTools = Boolean(allowedTools?.length);
  const idleMs = opts.idleTimeoutMs ?? config.narrator.timeoutMs;
  const emitTrace = Boolean(opts.emitToolTrace);
  // Surface-specific model: caller passes config.narrate.model or config.ask.model;
  // fall back to the shared config.narrator.model for backward compat.
  const model = opts.model ?? config.narrator.model;
  // Correlate a read-Cypher tool_use id with its later tool_result (the rows).
  const pendingCypher = new Set<string>();

  return new Promise<ClaudeCodeResult>((resolve) => {
    // Prompt goes on STDIN; every arg here is a single bare token (no spaces),
    // so shell:true can't mangle it.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      String(maxTurns ?? config.narrator.claudeMaxTurns),
      "--model",
      model,
    ];
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
    }
    if (allowedTools?.length) {
      args.push("--allowedTools", allowedTools.join(","));
    }
    if (opts.streamPartial) {
      args.push("--include-partial-messages");
    }

    let child;
    try {
      // Force MCP tools to load UPFRONT as first-class tools (no "tool search"
      // deferral). Recent `claude` CLI versions defer MCP server tools behind a
      // ToolSearch/deferred-tools layer when many tools are present: the model is
      // handed a `ToolSearch` tool and must discover an MCP tool before calling
      // it. Under that regime the read-Cypher `tool_use` never arrives in the
      // `mcp__neo4j__read_neo4j_cypher` shape this module correlates rows from
      // (handleCliLine L61/L111) → zero `rows` events → EVERY /ask answer grounds
      // to nothing (app-wide fallback). `ENABLE_TOOL_SEARCH=false` loads all MCP
      // tools upfront so the model emits the tool_use directly and the rows pair.
      // An explicit env override still wins so ops can re-enable deferral. Docs:
      // https://code.claude.com/docs/en/mcp.md#scale-with-mcp-tool-search
      const childEnv = {
        ...process.env,
        ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? "false",
      };
      // shell:true so Windows resolves claude.cmd / claude.exe off PATH.
      child = spawn(config.narrator.claudeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        env: childEnv,
      });
    } catch {
      log.warn("[claude-code] spawn threw — is `claude` on PATH?");
      resolve({ ok: false, reason: "spawn-failed" });
      return;
    }

    // Feed the prompt via stdin, then close it so the CLI starts generating.
    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch {
      /* if stdin is gone the close handler will resolve */
    }

    let produced = false;
    let settled = false;
    let timedOut = false;
    let buf = "";
    let stderr = "";

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (ok) {
        resolve({ ok: true });
        return;
      }
      const reason = classify(stderr, timedOut, hadTools);
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      log.warn(`[claude-code] fallback (${reason})${tail ? ` — ${tail}` : ""}`);
      resolve({ ok: false, reason });
    };

    // Idle watchdog — kill if the CLI goes quiet (mirrors managed-agent).
    let idle = setTimeout(() => {
      timedOut = true;
      finish(produced);
    }, idleMs);
    const bump = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        finish(produced);
      }, idleMs);
    };

    const onAbort = () => {
      timedOut = true;
      finish(produced);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    // Capture stderr so failures are explainable, not silent.
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const cliLineState: CliLineState = { produced, pendingCypher };
    child.stdout.on("data", (chunk: Buffer) => {
      bump();
      buf += chunk.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt: any;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue; // non-JSON log line
        }
        handleCliLine(
          evt,
          { sink, streamPartial: opts.streamPartial, emitTrace, finopsSurface: opts.finopsSurface, model },
          cliLineState,
        );
      }
      produced = cliLineState.produced;
    });

    child.on("error", (err) => {
      stderr += `\nspawn error: ${String((err as Error)?.message ?? err)}`;
      finish(false);
    });
    child.on("close", () => finish(produced));
  });
}
