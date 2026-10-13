/**
 * Ask-the-graph-anything (Beat — live).
 *
 * Primary path: the Claude Agent SDK runs a bounded tool-loop against the
 * official Neo4j MCP server (READ-ONLY) so free-text questions become real
 * Cypher over the live graph. Hardening (§13): MCP authenticated, never
 * public-facing, read-only enforced, queries parameterized.
 *
 * Safe fallback: an always-available, read-only intent matcher that answers
 * from the graph directly — so the demo works offline and can NEVER write.
 *
 * ⚠ Verify at build time: exact @anthropic-ai/claude-agent-sdk API (query(),
 * options.mcpServers shape, streaming events). The block below is written to
 * the documented shape and fully guarded — any failure drops to the fallback.
 */
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FallbackReason, FinOpsSurface } from "@rnd/shared";
import { record, estimateTokens } from "../finops/ledger.js";
import { read } from "../neo4j.js";
import { config, liveModeAvailable } from "../config.js";
import { getConfig } from "../config/adminConfig.js";
import { ALLOWED_TOOLS } from "./enforced.js";
import { runClaudeCode } from "../llm/claudeCode.js";
import { getFullGraph } from "../graph/queries.js";
import { scoreFaithfulness, contextRecall } from "./faithfulness.js";
import { routeQuery } from "./router.js";
import { recordEval } from "../eval/scorecard.js";
import { composeDashboardStreaming } from "../dashboards/composer.js";
import { certifySpec } from "../dashboards/verified.js";
import { composeGenerativeStreaming } from "../generative/composer.js";
import { composeBoardOrchestrated } from "../generative/orchestrator.js";
import { bindDatasets } from "../generative/bind.js";
import { log } from "../log.js";
import type { GraphNode } from "@rnd/shared";

/** Build the /ask instruction. The instruction prefix is live-editable via admin
 *  config, but the refusal-marker sentence is appended STRUCTURALLY using the
 *  single configured marker — so the agent emits the exact same marker the bridge
 *  gates on and the UI detects. There is no way to desync them. */
function buildAskPrompt(question: string, seedNodeIds?: string[]): string {
  const cfg = getConfig();
  // F3: candidate seeds are advisory STARTING POINTS only. They are explicitly
  // labelled "verify, do not cite unless your own query returns them" so an
  // unverified seed can never be passed off as evidence — citations still derive
  // ONLY from returned rows (the rows-only guard in traceSink).
  const seedNote =
    seedNodeIds && seedNodeIds.length
      ? ` Candidate seed node ids you MAY use as starting points (semantic/lexical ` +
        `matches — NOT evidence; do NOT cite any of them unless your own read-only ` +
        `Cypher returns it in a row): ${JSON.stringify(seedNodeIds)}.`
      : "";
  return (
    `${cfg.askInstruction} ` +
    `If the graph does NOT contain the answer, do not guess — reply with a line ` +
    `that begins exactly "${cfg.notInGraphMarker}" followed by what is missing and the ` +
    `nearest related evidence the graph does hold.${seedNote} Question: ${question}`
  );
}

type Sink = (event: { type: string; [k: string]: unknown }) => void;

/** Node IDs are uppercase, hyphenated tokens (AE-MYOCARDITIS, LIT-PMID-20694011,
 *  CT-NCT02743819, ONTO-MESH-2026-06, …). Extract candidates then intersect with
 *  the real graph so we only ever emit grounded IDs. */
const NODE_ID_RE = /[A-Z]{2,}-[A-Z0-9-]+/g;

/** Load the set of valid node IDs once. Guarded — returns null if the graph is
 *  unavailable, in which case the caller simply skips citations. */
async function loadValidNodeIds(): Promise<Set<string> | null> {
  try {
    const graph = await getFullGraph("all");
    const ids = new Set(graph.nodes.map((n) => n.id));
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

/** The single source of truth for the official Neo4j MCP server's CLI args:
 *  `uvx mcp-neo4j-cypher@<ver>` + connection flags, and (when configured) the
 *  `--read-only` flag. Used by BOTH transports (local CLI via --mcp-config and
 *  the cloud Agent SDK's mcpServers) so the read-only enforcement can never
 *  drift between them. */
function neo4jMcpServerArgs(): string[] {
  const serverArgs = [
    `mcp-neo4j-cypher@${config.mcp.version}`,
    "--db-url",
    config.neo4j.uri,
    "--username",
    config.neo4j.user,
    "--password",
    config.neo4j.password,
    "--database",
    config.neo4j.database,
  ];
  if (config.mcp.readOnly) serverArgs.push("--read-only");
  return serverArgs;
}

/** Read-only Neo4j MCP config the local `claude` CLI loads via --mcp-config.
 *  The official server takes connection + `--read-only` as CLI args (verified
 *  against `uvx mcp-neo4j-cypher --help`); env vars are passed as a backstop. */
function writeNeo4jMcpConfig(): string {
  const path = join(tmpdir(), "rnd-trust-graph-neo4j-mcp.json");
  const serverArgs = neo4jMcpServerArgs();
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        neo4j: {
          command: "uvx",
          // NOTE: serverArgs still carries `--password` on argv — that is the
          // auth path verified against `uvx mcp-neo4j-cypher --help`; the env
          // block below is a backstop. argv is visible in process listings, which
          // is acceptable for a single-user localhost demo. The file itself holds
          // the password too, so it is written 0600 (owner-only) just below.
          args: serverArgs,
          env: {
            NEO4J_URI: config.neo4j.uri,
            NEO4J_USERNAME: config.neo4j.user,
            NEO4J_PASSWORD: config.neo4j.password,
          },
        },
      },
    }),
    // Owner read/write only — the file contains NEO4J_PASSWORD; default 0644 would
    // let any local user read it.
    { encoding: "utf-8", mode: 0o600 }
  );
  return path;
}

/** /ask via the local Claude Code CLI + read-only Neo4j MCP. Guarded; returns a
 *  classified result so the caller can log/show why it fell back. */
async function tryClaudeCode(
  question: string,
  sink: Sink,
  surface: FinOpsSurface,
  seedNodeIds?: string[]
): Promise<{ ok: boolean; reason?: FallbackReason; citedNodeIds?: string[]; answerText?: string }> {
  // Load valid node IDs once so we can ground citations against the real graph.
  // Guarded — if unavailable we simply never emit citations.
  const validIds = await loadValidNodeIds();
  const touched = new Set<string>();
  // Accumulate the assistant's prose so the faithfulness scorer (F1/F4) can check
  // it against the cited evidence AFTER the answer settles. Observability only —
  // this never alters the streamed answer the user sees.
  let answerText = "";
  // Interceptor: forward every event unchanged, and scan the Cypher the agent
  // ran + the rows it got back for real node IDs as they stream past.
  const traceSink: Sink = (event) => {
    sink(event);
    if (event.type === "token") {
      const t = (event as { text?: unknown }).text;
      if (typeof t === "string") answerText += t;
    }
    if (!validIds) return;
    // Derive citations ONLY from the result ROWS the agent got back — not from the
    // Cypher query text. An id that appears only in a WHERE filter (and returned
    // no rows) is not evidence the answer used it, and citing it would over-cite
    // and spuriously trip the STAT-/HITL governance gate. (Caveat: the rows
    // preview is length-capped, so an id past the cap in a large result won't be
    // cited — under-citing is the safer error for a grounding story. Widening the
    // preview is a possible follow-up; it is the UI trace string, not changed here.)
    if (event.type !== "rows") return;
    const text = String((event as { preview?: unknown }).preview ?? "");
    if (!text) return;
    const matches = text.match(NODE_ID_RE);
    if (!matches) return;
    for (const m of matches) if (validIds.has(m)) touched.add(m);
  };
  // Written 0600 with the Neo4j password — remove it once the CLI has read it.
  const mcpConfigPath = writeNeo4jMcpConfig();
  try {
    const controller = new AbortController();
    // A read-only tool-loop (schema → Cypher → answer) can run far longer than a
    // one-shot narration: give it a generous hard cap and idle window so it isn't
    // cut off mid-loop (which would strand us on just the agent's preamble).
    // Both caps are configurable: ASK_HARD_TIMEOUT_MS, ASK_IDLE_TIMEOUT_MS, ASK_MAX_TURNS.
    const timer = setTimeout(() => controller.abort(), config.ask.hardTimeoutMs);
    const result = await runClaudeCode({
      prompt: buildAskPrompt(question, seedNodeIds),
      sink: traceSink,
      signal: controller.signal,
      // Stream the agent's Cypher + rows as a first-class "show your work" trace.
      emitToolTrace: true,
      mcpConfigPath,
      // Read-only tools only — schema (to write correct Cypher) + read query.
      // ENFORCED IN CODE, never config-editable: the write tool
      // (mcp__neo4j__write_neo4j_cypher) is deliberately excluded. See ./enforced.ts.
      allowedTools: [...ALLOWED_TOOLS],
      // Surface-specific model: ASK_MODEL (must be Sonnet-tier or above for Cypher).
      model: config.ask.model,
      // Surface-specific turn budget: ASK_MAX_TURNS (min 3 enforced in config).
      maxTurns: config.ask.maxTurns,
      // Surface-specific idle watchdog: ASK_IDLE_TIMEOUT_MS.
      idleTimeoutMs: config.ask.idleTimeoutMs,
      // FinOps: tag the surface ("ask" direct, "runtime" via the AG-UI bridge) so
      // the CLI's real token usage lands in the ledger. Observability only.
      finopsSurface: surface,
    });
    clearTimeout(timer);
    return {
      ...result,
      citedNodeIds: result.ok ? [...touched] : undefined,
      answerText: result.ok ? answerText : undefined,
    };
  } catch {
    return { ok: false, reason: "spawn-failed" };
  } finally {
    // Best-effort cleanup of the password-bearing temp config.
    try {
      unlinkSync(mcpConfigPath);
    } catch {
      /* already gone — fine */
    }
  }
}

/** Always-available, strictly read-only answer grounded in the live graph. */
async function safeGraphAnswer(question: string): Promise<string> {
  const q = question.toLowerCase();

  if (/(signal|myocard|adverse|safety|prr|ror|dispro)/.test(q)) {
    const rows = await read<{ cases: number; drug: string; prr: unknown }>(
      `MATCH (p:Patient)-[:REPORTS]->(ae:AdverseEvent { id:'AE-MYOCARDITIS' })
       MATCH (ae)-[:SUSPECTED_IN]->(d:Drug)
       MATCH (ae)-[:HAS_STAT]->(s:SignalStat)
       RETURN count(DISTINCT p) AS cases, d.label AS drug, s.attrsRaw AS prr`
    );
    const r = rows[0];
    return r
      ? `${r.cases} synthetic cases link ${r.drug} to immune-related myocarditis; the disproportionality signal is ${String(r.prr)}.`
      : "No matching safety signal found in the graph.";
  }

  if (/(target|pd-?1|mechanism|pathway)/.test(q)) {
    const rows = await read<{ target: string; pathway: string }>(
      `MATCH (:Drug { id:'DRUG-CPI' })-[:TARGETS]->(t:BiologicalTarget)-[:IN_PATHWAY]->(pw:Pathway)
       RETURN t.label AS target, pw.label AS pathway`
    );
    const r = rows[0];
    return r
      ? `The checkpoint inhibitor targets ${r.target}, which sits in the ${r.pathway}.`
      : "No mechanism path found.";
  }

  if (/(evidence|source|support|cite|provenance)/.test(q)) {
    const rows = await read<{ ev: string; src: string }>(
      `MATCH (:SignalStat { id:'STAT-MYO-CPI' })-[:SUPPORTED_BY]->(e:Evidence)
       RETURN e.label AS ev, e.sourceSystem AS src`
    );
    return rows.length
      ? `Supported by: ${rows.map((r) => `${r.ev} (${r.src})`).join("; ")}.`
      : "No evidence nodes found.";
  }

  const counts = await read<{ labels: number }>(`MATCH (n) RETURN count(n) AS labels`);
  return `The graph holds ${counts[0]?.labels ?? 0} nodes spanning patients, drugs, targets, pathways, signals and evidence. Ask about the safety signal, the drug mechanism, or the supporting evidence.`;
}

/**
 * Score the grounded answer's faithfulness to the nodes it cited and emit a
 * `faithfulness` event (F1/F4). SCORING ONLY — never alters the answer. Skipped
 * for a refusal (answer carries the NOT_IN_GRAPH marker) or when nothing was
 * cited (no grounded claim to check). Fully guarded: a scoring failure is silent.
 */
async function emitFaithfulness(
  sink: Sink,
  question: string,
  answerText: string,
  citedNodeIds: string[],
  surface: FinOpsSurface
): Promise<void> {
  try {
    const cfg = getConfig();
    if (!answerText || answerText.includes(cfg.notInGraphMarker)) return;
    if (!citedNodeIds.length) return;
    const graph = await getFullGraph("all");
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const citedNodes: GraphNode[] = citedNodeIds
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => Boolean(n));
    if (!citedNodes.length) return;
    const result = scoreFaithfulness(answerText, citedNodes);
    result.gated = result.score < cfg.faithfulness.threshold;
    sink({ type: "faithfulness", result });
    // F2: record the answer-quality entry (faithfulness + deterministic
    // context-recall; answer-relevancy is left null — the LLM judge is off by
    // default). Observability only; recordEval never throws.
    try {
      recordEval({
        surface,
        question,
        faithfulness: result.score,
        contextRecall: contextRecall(question, citedNodes),
        answerRelevancy: null,
        citedCount: citedNodes.length,
      });
    } catch {
      /* eval instrumentation must never break the answer path */
    }
  } catch {
    /* scoring must never break the answer path */
  }
}

/**
 * Compose a grounded generative dashboard for the settled answer and emit it as a
 * `dashboard` event (@rnd/dashboards). GROUNDED-ONLY: skipped for a refusal (answer
 * carries the NOT_IN_GRAPH marker) or when nothing was cited — mirroring the
 * faithfulness/render_evidence gate exactly, so a refusal/fallback draws nothing.
 * The composer never throws and always returns a valid spec (LLM-composed when live,
 * else the deterministic template), so this can only ADD a dashboard, never break
 * the answer path.
 */
async function emitDashboard(
  sink: Sink,
  question: string,
  answerText: string,
  citedNodeIds: string[],
  strategy?: string
): Promise<void> {
  try {
    const cfg = getConfig();
    if (!answerText || answerText.includes(cfg.notInGraphMarker)) return;
    if (!citedNodeIds.length) return;
    const graph = await getFullGraph("all");
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const citedNodes: GraphNode[] = citedNodeIds
      .map((id) => byId.get(id))
      .filter((n): n is GraphNode => Boolean(n));
    if (!citedNodes.length) return;
    const spec = await composeDashboardStreaming(
      { question, answerText, citedNodes, strategy },
      (partial) => sink({ type: "dashboard-delta", spec: partial }),
    );
    // Feature 8: certify over the REAL cited nodes (trusted), never the inert spec.
    const { certified } = certifySpec(spec, citedNodes);
    sink({ type: "dashboard", spec, certified });
  } catch {
    /* dashboard composition must never break the answer path */
  }
}

/**
 * Compose a grounded Generative Studio board (@rnd/generative) for the settled
 * answer and emit `generative-delta`/`generative` events. GROUNDED-ONLY: same
 * gate as `emitDashboard` (skipped for a refusal or when nothing was cited).
 * Mutually exclusive with `emitDashboard` — the generative surface (driven via
 * `?compose=generative`) composes tiles INSTEAD OF a dashboard for this run.
 *
 * `composeGenerativeStreaming`'s contract is "never throws" EXCEPT its
 * up-front `bindDatasets` call (Neo4j/reasoner-backed) CAN throw when the graph
 * is unavailable. We ALSO call `bindDatasets` directly here — a plain,
 * deterministic, read-only call (NOT the composer's test-only `deps` seam), so
 * calling it twice (once here, once again inside the composer) is harmless —
 * purely so `datasets`/`fieldMenu` are already in hand BEFORE any tile streams:
 * a `GenerativeTile` needs its rows to render, unlike a `DashboardSpec` widget
 * which is self-contained, so each `generative-delta` carries them alongside
 * the tile. Both calls sit inside the SAME try/catch, so either one throwing
 * (this one OR the composer's internal one) degrades to "no board emitted" and
 * the grounded answer still completes — never a 500, never a broken run.
 */
async function emitGenerative(
  sink: Sink,
  question: string,
  answerText: string,
  citedNodeIds: string[],
  orchestrated: boolean,
): Promise<void> {
  try {
    const cfg = getConfig();
    if (!answerText || answerText.includes(cfg.notInGraphMarker)) return;
    if (!citedNodeIds.length) return;
    const { datasets, fieldMenu } = await bindDatasets(citedNodeIds);
    // `compose=board` runs the full orchestrator (planner → workers → board-critic →
    // reflexion), which returns a board carrying host-owned layout + filters + score.
    // `compose=generative` runs the single-pass fast path. Same (input, onDelta)
    // contract, same never-throws guarantee — the new board fields ride inside `board`,
    // so the sink/bridge shape is unchanged.
    const composer = orchestrated ? composeBoardOrchestrated : composeGenerativeStreaming;
    const { board } = await composer(
      { question, answerText, citedNodeIds },
      (tile) => sink({ type: "generative-delta", tile, datasets, fieldMenu }),
    );
    sink({ type: "generative", board, datasets, fieldMenu });
  } catch {
    /* generative composition (incl. a bindDatasets throw) must never break the answer path */
  }
}

/** Try the Agent SDK + Neo4j MCP path; resolve false if unavailable. */
async function tryAgentSdk(
  question: string,
  sink: Sink,
  surface: FinOpsSurface,
  seedNodeIds?: string[]
): Promise<boolean> {
  if (!liveModeAvailable()) return false;
  // The cloud Agent SDK streaming path does not surface a usage/result message we
  // parse, so we ESTIMATE tokens from prompt + answer text length (~4 chars/token)
  // and mark the ledger entry estimated:true. Accumulate the streamed answer here.
  let answerText = "";
  try {
    // Dynamic import via a variable specifier so TS doesn't resolve it at
    // build time — a missing/uninstalled SDK never crashes the BFF.
    const sdkName = "@anthropic-ai/claude-agent-sdk";
    const sdk: any = await import(sdkName).catch(() => null);
    if (!sdk?.query) return false;

    const stream = sdk.query({
      // Same prompt as the local CLI path (buildAskPrompt + F3 seeds) so the two transports
      // share one instruction — schema-first Cypher, grounded answers, and the
      // configured NOT_IN_GRAPH marker the bridge/UI gate on. No drift.
      prompt: buildAskPrompt(question, seedNodeIds),
      options: {
        // Surface-specific model for the /ask path: configurable via ASK_MODEL.
        model: config.ask.model,
        // Read-only Neo4j MCP server, spawned locally, never public-facing.
        mcpServers: {
          neo4j: {
            command: "uvx",
            // Connection + read-only enforced as CLI args (verified against
            // `uvx mcp-neo4j-cypher --help`; the once-assumed @1.5.3 doesn't exist).
            // Shared builder so --read-only can never drift from the CLI path.
            args: neo4jMcpServerArgs(),
            env: {
              NEO4J_URI: config.neo4j.uri,
              NEO4J_USERNAME: config.neo4j.user,
              NEO4J_PASSWORD: config.neo4j.password,
            },
          },
        },
        // Read-only tools only — ENFORCED IN CODE, never config-editable. The
      // write tool (mcp__neo4j__write_neo4j_cypher) is deliberately excluded.
      allowedTools: [...ALLOWED_TOOLS],
      },
    });

    let any = false;
    for await (const msg of stream) {
      // Surface assistant text deltas; shape is version-sensitive (guarded).
      const text =
        msg?.delta?.text ??
        (msg?.type === "assistant" && Array.isArray(msg?.message?.content)
          ? msg.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")
          : "");
      if (text) {
        any = true;
        answerText += text;
        sink({ type: "token", text });
      }
    }
    // FinOps (estimated): the cloud SDK path reports no usage message; estimate
    // tokens from prompt + answer length. Marked estimated:true in the ledger.
    if (any) {
      try {
        record({
          surface,
          model: config.ask.model,
          inputTokens: estimateTokens(question),
          outputTokens: estimateTokens(answerText),
          estimated: true,
        });
      } catch {
        /* instrumentation must never break the response path */
      }
    }
    return any;
  } catch {
    return false;
  }
}

export async function askGraph(
  question: string,
  sink: Sink,
  // FinOps surface: "ask" for the direct /api/ask route, "runtime" when driven
  // through the AG-UI / Copilot Runtime bridge. Defaults to "ask". Observability
  // only — it never changes what the agent is allowed to answer.
  surface: FinOpsSurface = "ask",
  // Generative Studio lane switch: true ONLY when the AG-UI bridge is driven via
  // the second `?compose=generative` Copilot Runtime agent. Selects WHICH
  // grounded composer runs below (generative tiles instead of a dashboard) —
  // it never changes what the agent is allowed to answer. Defaults to `{}` so
  // every existing caller (server.ts `/api/ask`, eval/askEval.ts,
  // playbooks/runner.ts) is completely unaffected.
  options: { generative?: boolean; orchestrated?: boolean } = {}
): Promise<void> {
  log.debug(`enter · surface=${surface}`);
  // F3 — route first: classify the question and gather REAL candidate seeds, then
  // emit a "route" trace event so the UI can show "why this strategy". The seeds
  // are advisory starting points only; citations still come exclusively from rows,
  // so an unverified seed can never become evidence. Guarded — never blocks answering.
  let seedNodeIds: string[] | undefined;
  try {
    const route = await routeQuery(question);
    seedNodeIds = route.seedNodeIds;
    sink({
      type: "route",
      strategy: route.strategy,
      reason: route.rationale,
      seedNodeIds: route.seedNodeIds,
    });
  } catch {
    /* routing is best-effort; fall through with no seeds */
  }
  // Prefer the local Claude Code CLI when selected (subscription auth, no key),
  // else the cloud Agent SDK; both run read-only Cypher via the Neo4j MCP.
  const result =
    config.narrator.provider === "claude-code"
      ? await tryClaudeCode(question, sink, surface, seedNodeIds)
      : { ok: await tryAgentSdk(question, sink, surface, seedNodeIds), reason: "api-error" as FallbackReason };
  if (result.ok) {
    // Grounded citations: emit the real graph node IDs the answer touched (from
    // the streamed Cypher + rows) so the frontend can highlight them. Only on a
    // live success with >=1 touched id; never on fallback, never invented.
    const cited = "citedNodeIds" in result ? result.citedNodeIds : undefined;
    if (cited && cited.length > 0) {
      sink({ type: "citations", nodeIds: cited });
    }
    // F1/F4: score the grounded answer against the evidence it cited, then emit a
    // faithfulness verdict the bridge/UI surface as a confidence badge + any
    // per-claim "unverified" flags. Only when we actually have an answer + cites.
    const answerText = "answerText" in result ? result.answerText : undefined;
    if (cited && cited.length > 0 && answerText) {
      await emitFaithfulness(sink, question, answerText, cited, surface);
      // Generative Studio (@rnd/generative) vs classic dashboard (@rnd/dashboards):
      // MUTUALLY EXCLUSIVE composers, selected by `options.generative`, both under
      // the SAME grounded-and-cited gate. Additive either way — never alters the
      // answer/citations. Classic callers (options.generative defaults to false)
      // are byte-identical to before this branch existed.
      if (options.generative) {
        await emitGenerative(sink, question, answerText, cited, options.orchestrated ?? false);
      } else {
        await emitDashboard(sink, question, answerText, cited);
      }
    }
    sink({ type: "done", isFallback: false });
    return;
  }
  // Safe, read-only fallback — stream word by word for a natural feel.
  // Guard the graph read so /ask never 500s even if Neo4j is down (RUNBOOK).
  const reason: FallbackReason = liveModeAvailable() ? result.reason ?? "empty-output" : "disabled";
  let answer: string;
  try {
    answer = await safeGraphAnswer(question);
  } catch {
    answer = "The graph is offline right now — see the recorded walkthrough for this answer.";
  }
  const words = answer.split(" ");
  for (let i = 0; i < words.length; i++) sink({ type: "token", text: (i ? " " : "") + words[i] });
  sink({ type: "done", isFallback: true, reason });
}
