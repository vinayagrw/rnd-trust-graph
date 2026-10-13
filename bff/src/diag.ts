/**
 * Live-readiness preflight for the presenter. Answers the one question that
 * matters at the podium: "is this really running live, and if not, what's
 * missing?" — without making a (slow, billable) model call. Each check is a
 * fast, guarded probe; failures resolve false rather than throwing.
 */
import { spawn } from "node:child_process";
import type { LiveStatus } from "@rnd/shared";
import { config, liveModeAvailable } from "./config.js";
import { healthcheck } from "./neo4j.js";

/** Resolve true if `bin args` exits 0 within `ms`. Never throws. */
function probe(bin: string, args: string[], ms = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    let child;
    try {
      child = spawn(bin, args, { stdio: "ignore", shell: true });
    } catch {
      finish(false);
      return;
    }
    const t = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish(false);
    }, ms);
    child.on("error", () => {
      clearTimeout(t);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      finish(code === 0);
    });
  });
}

/** Run all preflight checks in parallel and summarize live-readiness. */
export async function getLiveStatus(): Promise<LiveStatus> {
  const isClaudeCode = config.narrator.provider === "claude-code";
  const [neo4j, claudeBin, uvx] = await Promise.all([
    healthcheck().catch(() => false),
    isClaudeCode ? probe(config.narrator.claudeBin, ["--version"]) : Promise.resolve(false),
    isClaudeCode ? probe("uvx", ["--version"]) : Promise.resolve(false),
  ]);
  const apiKey = Boolean(config.narrator.apiKey);

  // "live" = the chosen provider can actually answer right now. For claude-code
  // we need the binary (auth can't be cheaply verified — surfaced as a caveat);
  // for api we need a key. /ask additionally needs uvx + neo4j for the MCP loop.
  const live = isClaudeCode ? claudeBin : apiKey;

  const detail = isClaudeCode
    ? !claudeBin
      ? "`claude` not found on PATH — install Claude Code or set CLAUDE_BIN."
      : !uvx
        ? "`uvx` not found — /narrate works but /ask needs uvx (from uv) for the Neo4j MCP."
        : !neo4j
          ? "Neo4j unreachable — start it with `npm run db:up`."
          : "Live via local Claude Code (subscription auth, no API key). Auth assumed from your login."
    : apiKey
      ? "Live via cloud Anthropic API."
      : "No provider configured — running scripted/cached fallback only.";

  return {
    provider: config.narrator.provider,
    live: live && liveModeAvailable(),
    checks: { neo4j, claudeBin, uvx, apiKey },
    detail,
  };
}
