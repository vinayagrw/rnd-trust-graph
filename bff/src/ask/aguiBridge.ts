/**
 * AG-UI bridge (Phase 2).
 *
 * Lets CopilotKit's prebuilt chat UI drive our EXISTING grounded /ask agent
 * over the AG-UI SSE protocol — WITHOUT a second LLM and WITHOUT touching the
 * agent. CopilotKit's `HttpAgent` (from `@ag-ui/client`) POSTs a RunAgentInput
 * here and consumes a `text/event-stream` of AG-UI events. We translate the
 * untouched `askGraph(question, sink)` sink events into AG-UI events:
 *
 *   askGraph sink event            -> AG-UI SSE event(s)
 *   ----------------------------     --------------------------------------------
 *   {type:"token", text}           -> TEXT_MESSAGE_CONTENT {messageId, delta}
 *   {type:"step", label}           -> a `read_neo4j_cypher` tool call (schema step)
 *   {type:"cypher", query}         -> TOOL_CALL_START/ARGS (the real read-only Cypher)
 *   {type:"rows", preview}         -> TOOL_CALL_END + TOOL_CALL_RESULT (the row preview)
 *   {type:"citations", nodeIds}    -> accumulated into shared state (STATE_SNAPSHOT)
 *   {type:"done", isFallback}      -> STATE_SNAPSHOT {citedNodeIds, isFallback} +
 *                                     a `render_evidence` tool call carrying the
 *                                     real cited ids so the UI can draw GROUNDED
 *                                     diagrams (subgraph/chart/flow) from real data
 *
 * Grounding stays 100% server-side in the untouched agent: refusals come back
 * as prose beginning "NOT_IN_GRAPH:" inside the token stream and ride through
 * TEXT_MESSAGE_CONTENT unchanged — the UI shows exactly what the graph said. The
 * `render_evidence` tool call is emitted ONLY when the answer is grounded
 * (not a fallback) AND cited >=1 real node id, so a refusal never draws a diagram.
 *
 * Event shapes verified against the installed `@ag-ui/core@0.0.42` `.d.ts`:
 *   TOOL_CALL_START  {toolCallId, toolCallName, parentMessageId?}
 *   TOOL_CALL_ARGS   {toolCallId, delta}            (delta = JSON args fragment)
 *   TOOL_CALL_END    {toolCallId}
 *   TOOL_CALL_RESULT {messageId, toolCallId, content, role?:"tool"}
 *   STATE_SNAPSHOT   {snapshot}
 */
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
  FaithfulnessResult,
  DashboardSpec,
  DashboardAudit,
  GenerativeBoard,
  GenerativeDatasets,
  FieldMenuEntry,
} from "@rnd/shared";
import { askGraph } from "./agent.js";
import { getConfig } from "../config/adminConfig.js";
import { log } from "../log.js";
import { getGatedConclusions } from "../graph/risk.js";
import { recentEntries } from "../finops/ledger.js";
import { VERIFIED_QUERIES } from "../dashboards/verified.js";

/** Minimal shape of the AG-UI RunAgentInput body `HttpAgent` POSTs. We only
 *  need threadId/runId (echoed back) and the messages (to find the question). */
interface AguiMessage {
  role?: string;
  content?: unknown;
}
interface AguiRunInput {
  threadId?: string;
  runId?: string;
  messages?: AguiMessage[];
}

/** Coerce message content (string, or content-parts array) to plain text. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : ""
      )
      .join("");
  }
  return "";
}

/** Begin an AG-UI SSE response on the raw socket. Mirrors server.ts `sse()`
 *  headers exactly so it shares the same proxy/CORS behaviour. */
function aguiSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return {
    send: (event: Record<string, unknown>) =>
      reply.raw.write(`data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`),
    end: () => reply.raw.end(),
  };
}

/** POST /api/agui — AG-UI protocol endpoint backed by the grounded /ask agent.
 *  `askGraphImpl` defaults to the real `askGraph` — tests inject a scripted
 *  fake (same signature) so the sink-translation + grounded gates below are
 *  exercised with no Neo4j and no real CLI (mirrors the dashboards streaming
 *  composer's own test-seam pattern). */
export async function aguiBridge(
  req: FastifyRequest,
  reply: FastifyReply,
  askGraphImpl: typeof askGraph = askGraph,
): Promise<void> {
  log.debug("enter");
  const body = (req.body ?? {}) as AguiRunInput;
  const threadId = body.threadId ?? randomUUID();
  const runId = body.runId ?? randomUUID();
  const messageId = randomUUID();
  // Generative Studio (T7): the SAME Fastify handler that receives RunAgentInput
  // also reads the `compose` query param off the request the HttpAgent POSTs to
  // (the second Copilot Runtime agent is registered at `?compose=generative`).
  // Any other value (or its absence) leaves classic surfaces byte-identical —
  // `generative` stays false and the dashboard lane composes exactly as before.
  const compose = (req.query as { compose?: string } | undefined)?.compose;
  // `compose=generative` = the single-pass fast path; `compose=board` = the full
  // orchestrator (planner → workers → board-critic → reflexion). Both drive the
  // SAME grounded generative lane and emit the SAME render_generative tool calls —
  // the only difference is which composer runs (selected by `orchestrated`).
  const generative = compose === "generative" || compose === "board";
  const orchestrated = compose === "board";
  // One dashboard run-generation id per run: rides ALONGSIDE the inert spec in every
  // render_dashboard tool-call args (deltas + final) so the frontend lineage store
  // can roll back a failed run's partials and drop stale historical re-renders.
  const dashboardRunId = randomUUID();
  // Same pattern for Generative Studio (T7): one id per run, stamped on every
  // render_generative tool-call args (deltas + final) — mirrors d064402 exactly.
  const generativeRunId = randomUUID();

  // SINGLE SOURCE OF TRUTH for the refusal marker: read the same configured
  // marker the agent emits and the UI detects. Reading it here (not a hardcoded
  // literal) means editing the marker via /api/admin/config can never desync the
  // grounding gate below — the bridge always gates on the exact emitted marker.
  const notInGraphMarker = getConfig().notInGraphMarker;

  // The question is the content of the LAST user-role message.
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = messageText(lastUser?.content).trim();

  const ch = aguiSse(reply);
  ch.send({ type: "RUN_STARTED", threadId, runId });

  // Accumulated across the run; flushed into shared state on `done`.
  let citedNodeIds: string[] = [];
  let isFallback = false;
  // F1/F4: the faithfulness verdict for this answer (null until the agent emits
  // one; never present on a refusal/fallback because the scorer skips those).
  let faithfulness: FaithfulnessResult | null = null;
  // @rnd/dashboards: the composed, validated, grounded spec for this answer (null
  // until the agent emits one; never present on a refusal/fallback).
  let dashboardSpec: DashboardSpec | null = null;
  // Feature 8: widget ids the trusted BFF certified against the verified-query
  // registry (computed over the real cited nodes, never from the inert spec).
  let dashboardCertified: string[] = [];
  // Generative Studio (@rnd/generative): the composed, grounded board for this
  // answer (null until the agent emits one; never present on a refusal/fallback,
  // and never populated at all unless this run was driven with `generative`).
  let generativeBoard: GenerativeBoard | null = null;
  let generativeDatasets: GenerativeDatasets | null = null;
  let generativeFieldMenu: FieldMenuEntry[] = [];
  // The full assistant prose, accumulated so we can detect a refusal. The agent
  // refuses by emitting prose that contains the exact marker "NOT_IN_GRAPH:". On
  // a refusal the agent may still have scraped node ids from the schema/searches
  // it ran to CONFIRM the absence — those are not real citations of an answer, so
  // we MUST suppress both the highlight state and the generative diagram. This is
  // the bridge's grounding gate; the untouched agent keeps its own behaviour.
  let answer = "";
  const isRefusal = () => answer.includes(notInGraphMarker);
  // A read-Cypher tool call is opened on {cypher} and closed on the NEXT {rows}
  // (or on the next cypher / at end). We keep the open call's id + query so the
  // row preview lands as its TOOL_CALL_RESULT.
  let openCall: { id: string; query: string } | null = null;

  /** Close the currently-open cypher tool call, attaching `rows` as its result. */
  const closeOpenCall = (rows: string) => {
    if (!openCall) return;
    ch.send({ type: "TOOL_CALL_END", toolCallId: openCall.id });
    // TOOL_CALL_RESULT needs its OWN messageId (a tool-role message id).
    ch.send({
      type: "TOOL_CALL_RESULT",
      messageId: randomUUID(),
      toolCallId: openCall.id,
      content: rows || "(no rows returned)",
      role: "tool",
    });
    openCall = null;
  };

  try {
    if (!question) {
      // No user turn to answer — open and immediately close an empty message so
      // the UI stays well-formed rather than hanging on an unfinished run.
      ch.send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
      ch.send({ type: "TEXT_MESSAGE_END", messageId });
      ch.send({ type: "RUN_FINISHED", threadId, runId });
      ch.end();
      return;
    }

    ch.send({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });

    // Drive the EXISTING grounded agent and translate its trace into AG-UI.
    // Tag the FinOps surface "runtime" so Copilot-Runtime spend is attributed
    // separately from the direct /ask path. Observability only. `generative`
    // selects which grounded composer runs (T7) — never what the agent answers.
    await askGraphImpl(question, (event) => {
      switch (event.type) {
        case "token": {
          if (typeof event.text === "string") {
            answer += event.text;
            ch.send({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: event.text });
          }
          return;
        }
        case "step": {
          // A schema-inspection step → a short-lived `read_neo4j_cypher` call so
          // the "inspected the live graph schema" work is visible as show-your-work.
          const label = String((event as { label?: unknown }).label ?? "");
          closeOpenCall(""); // close any dangling cypher call first
          const id = randomUUID();
          ch.send({
            type: "TOOL_CALL_START",
            toolCallId: id,
            toolCallName: "read_neo4j_cypher",
            parentMessageId: messageId,
          });
          ch.send({
            type: "TOOL_CALL_ARGS",
            toolCallId: id,
            delta: JSON.stringify({ step: label }),
          });
          ch.send({ type: "TOOL_CALL_END", toolCallId: id });
          return;
        }
        case "route": {
          // F3 — the router's "why this strategy" decision, surfaced as a one-shot
          // `route_strategy` tool call so the trace leads with how the agent chose
          // to approach the question. The seeds are candidates-to-verify, NOT
          // citations (the grounding gate below is unaffected).
          closeOpenCall("");
          const id = randomUUID();
          ch.send({
            type: "TOOL_CALL_START",
            toolCallId: id,
            toolCallName: "route_strategy",
            parentMessageId: messageId,
          });
          ch.send({
            type: "TOOL_CALL_ARGS",
            toolCallId: id,
            delta: JSON.stringify({
              strategy: (event as { strategy?: unknown }).strategy ?? "",
              reason: (event as { reason?: unknown }).reason ?? "",
              seedNodeIds: (event as { seedNodeIds?: unknown }).seedNodeIds ?? [],
            }),
          });
          ch.send({ type: "TOOL_CALL_END", toolCallId: id });
          return;
        }
        case "cypher": {
          // Real read-only Cypher → open a tool call carrying the query in args.
          // Its rows arrive next as {rows} and become the TOOL_CALL_RESULT.
          closeOpenCall(""); // previous call had no rows; close it cleanly
          const query = String((event as { query?: unknown }).query ?? "");
          const id = randomUUID();
          openCall = { id, query };
          ch.send({
            type: "TOOL_CALL_START",
            toolCallId: id,
            toolCallName: "read_neo4j_cypher",
            parentMessageId: messageId,
          });
          ch.send({
            type: "TOOL_CALL_ARGS",
            toolCallId: id,
            delta: JSON.stringify({ query }),
          });
          return;
        }
        case "rows": {
          const preview = String((event as { preview?: unknown }).preview ?? "");
          closeOpenCall(preview);
          return;
        }
        case "citations": {
          const ids = (event as { nodeIds?: unknown }).nodeIds;
          if (Array.isArray(ids)) citedNodeIds = ids.map(String);
          return;
        }
        case "faithfulness": {
          const r = (event as { result?: unknown }).result;
          if (r) faithfulness = r as FaithfulnessResult;
          return;
        }
        case "dashboard-delta": {
          // Genuine streaming: paint each widget the instant it closes. Emit a
          // self-contained render_dashboard tool call carrying the one-widget partial;
          // the frontend merges it by widget id (F7) so tiles appear progressively.
          // The spec is already inert + grounding-filtered by the composer. A refusal
          // never reaches here (compose only runs on a grounded, cited answer).
          const s = (event as { spec?: unknown }).spec;
          if (s) {
            const id = randomUUID();
            ch.send({
              type: "TOOL_CALL_START",
              toolCallId: id,
              toolCallName: "render_dashboard",
              parentMessageId: messageId,
            });
            ch.send({
              type: "TOOL_CALL_ARGS",
              toolCallId: id,
              delta: JSON.stringify({ spec: s, runId: dashboardRunId }),
            });
            ch.send({ type: "TOOL_CALL_END", toolCallId: id });
          }
          return;
        }
        case "dashboard": {
          const s = (event as { spec?: unknown }).spec;
          if (s) dashboardSpec = s as DashboardSpec;
          const c = (event as { certified?: unknown }).certified;
          if (Array.isArray(c)) dashboardCertified = c.map(String);
          return;
        }
        case "generative-delta": {
          // Genuine streaming (T7, mirrors dashboard-delta): paint each tile the
          // instant it closes. Emit a self-contained render_generative tool call
          // carrying the one-tile partial PLUS the already-bound datasets/field
          // menu (a GenerativeTile needs its rows to render — unlike a
          // DashboardSpec widget, it is not self-contained). The tile is already
          // grounding-filtered by the composer; a refusal never reaches here
          // (compose only runs on a grounded, cited answer).
          const tile = (event as { tile?: unknown }).tile;
          if (tile) {
            const datasets = (event as { datasets?: unknown }).datasets;
            const fieldMenu = (event as { fieldMenu?: unknown }).fieldMenu;
            const id = randomUUID();
            ch.send({
              type: "TOOL_CALL_START",
              toolCallId: id,
              toolCallName: "render_generative",
              parentMessageId: messageId,
            });
            ch.send({
              type: "TOOL_CALL_ARGS",
              toolCallId: id,
              delta: JSON.stringify({ tile, datasets, fieldMenu, runId: generativeRunId }),
            });
            ch.send({ type: "TOOL_CALL_END", toolCallId: id });
          }
          return;
        }
        case "generative": {
          const b = (event as { board?: unknown }).board;
          if (b) generativeBoard = b as GenerativeBoard;
          const d = (event as { datasets?: unknown }).datasets;
          if (d) generativeDatasets = d as GenerativeDatasets;
          const fm = (event as { fieldMenu?: unknown }).fieldMenu;
          if (Array.isArray(fm)) generativeFieldMenu = fm as FieldMenuEntry[];
          return;
        }
        case "done": {
          isFallback = Boolean((event as { isFallback?: unknown }).isFallback);
          return;
        }
      }
    }, "runtime", { generative, orchestrated });

    // Close any cypher call still open (agent ended without a paired rows event).
    closeOpenCall("");

    // End the assistant prose message before publishing state / generative UI.
    ch.send({ type: "TEXT_MESSAGE_END", messageId });

    // A refusal ("NOT_IN_GRAPH:") may have scraped ids from the absence-confirming
    // searches — those are NOT answer citations, so publish an EMPTY highlight set
    // and draw no diagram. Otherwise publish the real cited ids.
    const grounded = !isFallback && !isRefusal();
    const publishedIds = grounded ? citedNodeIds : [];

    // F1/F4: surface the faithfulness verdict ONLY on a grounded answer (a refusal
    // never scored, so this is null then anyway). Carried in shared state so a
    // thread restore can re-show the badge.
    // `faithfulness` is only ever assigned inside the sink callback above, so TS
    // keeps it narrowed to its `null` initializer here — assert the real union so
    // the truthy-narrow below yields FaithfulnessResult, not never.
    const groundedFaithfulness = (grounded ? faithfulness : null) as FaithfulnessResult | null;

    // Publish the citation state so the frontend can highlight the cited nodes on
    // the companion canvas. Full snapshot (no JSON-Patch) — simplest valid form.
    ch.send({
      type: "STATE_SNAPSHOT",
      snapshot: {
        citedNodeIds: publishedIds,
        isFallback: isFallback || isRefusal(),
        faithfulness: groundedFaithfulness,
      },
    });

    // F1: a `faithfulness` tool call carries the confidence verdict so the chat
    // renders a badge (score + band, and a visible low-confidence stamp when
    // gated). ADDITIVE — it never changes the answer text or its citations.
    if (groundedFaithfulness) {
      const id = randomUUID();
      ch.send({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: "faithfulness",
        parentMessageId: messageId,
      });
      ch.send({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta: JSON.stringify(groundedFaithfulness),
      });
      ch.send({ type: "TOOL_CALL_END", toolCallId: id });
      ch.send({
        type: "TOOL_CALL_RESULT",
        messageId: randomUUID(),
        toolCallId: id,
        content: `Faithfulness ${Math.round(groundedFaithfulness.score * 100)}% (${groundedFaithfulness.band}).`,
        role: "tool",
      });

      // F4: a `hallucination_flag` tool call ONLY when at least one claim could not
      // be traced to the cited evidence. This catches a drifted claim INSIDE an
      // answered response — distinct from the whole-question NOT_IN_GRAPH refusal.
      if (groundedFaithfulness.unsupportedClaims.length > 0) {
        const hid = randomUUID();
        ch.send({
          type: "TOOL_CALL_START",
          toolCallId: hid,
          toolCallName: "hallucination_flag",
          parentMessageId: messageId,
        });
        ch.send({
          type: "TOOL_CALL_ARGS",
          toolCallId: hid,
          delta: JSON.stringify({ unsupportedClaims: groundedFaithfulness.unsupportedClaims }),
        });
        ch.send({ type: "TOOL_CALL_END", toolCallId: hid });
        ch.send({
          type: "TOOL_CALL_RESULT",
          messageId: randomUUID(),
          toolCallId: hid,
          content: `${groundedFaithfulness.unsupportedClaims.length} claim(s) not traceable to cited evidence.`,
          role: "tool",
        });
      }
    }

    // GROUNDED generative UI: emit a `render_evidence` tool call ONLY on a grounded
    // answer (not a fallback, not a refusal) that cited >=1 real node id. Its args
    // carry the real cited ids; the frontend draws subgraph / stat-chart / hero-flow
    // strictly from that + the live graph payload. A refusal draws NOTHING.
    if (grounded && publishedIds.length > 0) {
      const id = randomUUID();
      ch.send({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: "render_evidence",
        parentMessageId: messageId,
      });
      ch.send({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta: JSON.stringify({ citedNodeIds: publishedIds }),
      });
      ch.send({ type: "TOOL_CALL_END", toolCallId: id });
      ch.send({
        type: "TOOL_CALL_RESULT",
        messageId: randomUUID(),
        toolCallId: id,
        content: `Rendered grounded evidence for ${publishedIds.length} cited node(s).`,
        role: "tool",
      });
    }

    // GENERATIVE DASHBOARD (@rnd/dashboards): emit a `render_dashboard` tool call
    // carrying the composed, BFF-validated, grounded DashboardSpec — under the SAME
    // grounded-and-cited gate as render_evidence. The spec is already schema-checked
    // (structurally inert, every widget node id ⊆ the cited set), so the frontend
    // registry can render it directly from the live graph payload. A refusal/fallback
    // never reaches here (dashboardSpec stays null), so it draws NOTHING.
    // The final render_dashboard reconciles the full spec + certification/audit; streaming deltas above already painted each tile as it closed.
    // `dashboardSpec` is only assigned inside the sink callback above, so TS keeps
    // it narrowed to its `null` initializer here — assert the real union (same
    // pattern as `groundedFaithfulness`).
    const composedDashboard = dashboardSpec as DashboardSpec | null;
    if (grounded && publishedIds.length > 0 && composedDashboard) {
      const id = randomUUID();
      // Feature 8: assemble the certified-tile audit record. It rides ALONGSIDE the
      // inert spec (never inside it) and composes the app's existing observability
      // ledgers — the latest `dashboard`-surface FinOps entry (which model, and
      // `estimated:false` = a real live call, the definitive live-vs-cached proof) and
      // this answer's faithfulness verdict (the eval signal) — plus the verified-query
      // ids the certified widgets matched. Each verified query maps 1:1 to a widget
      // kind in the registry, so a certified widget's query id is fixed by its kind.
      const certifiedSet = new Set(dashboardCertified);
      const kindToQuery = new Map(VERIFIED_QUERIES.map((q) => [q.widgetKind, q.id]));
      const certifiedWidgets = composedDashboard.widgets.filter((w) => certifiedSet.has(w.id));
      const verifiedQueryIds = Array.from(
        new Set(certifiedWidgets.map((w) => kindToQuery.get(w.kind)).filter((q): q is string => Boolean(q))),
      );
      const latestDash = recentEntries(50).find((e) => e.surface === "dashboard");
      const audit: DashboardAudit = {
        model: latestDash?.model,
        estimated: latestDash ? latestDash.estimated : undefined,
        faithfulnessScore: groundedFaithfulness?.score,
        faithfulnessBand: groundedFaithfulness?.band,
        verifiedQueryIds,
        certifiedCount: certifiedWidgets.length,
      };
      ch.send({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: "render_dashboard",
        parentMessageId: messageId,
      });
      ch.send({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        // The faithfulness verdict + certified ids + audit ride ALONGSIDE the spec (not
        // inside it — the spec stays inert) so a `metric` tile can show the confidence
        // score and certified tiles can show a trust badge, all from trusted channels.
        delta: JSON.stringify({
          spec: composedDashboard,
          faithfulness: groundedFaithfulness,
          certified: dashboardCertified,
          audit,
          runId: dashboardRunId,
          final: true,
        }),
      });
      ch.send({ type: "TOOL_CALL_END", toolCallId: id });
      ch.send({
        type: "TOOL_CALL_RESULT",
        messageId: randomUUID(),
        toolCallId: id,
        content: `Composed a ${composedDashboard.source} dashboard with ${composedDashboard.widgets.length} widget(s).`,
        role: "tool",
      });
    }

    // GENERATIVE STUDIO (@rnd/generative, T7): the final render_generative tool
    // call reconciles the full board + datasets/field menu — mirrors the
    // render_dashboard final block above (same grounded-and-cited gate; same
    // shared per-run id stamped on every args; `final: true` on this one only).
    // Streaming deltas above already painted each tile as it closed. Mutually
    // exclusive with the dashboard block: `generativeBoard` is only ever
    // assigned when this run composed generatively (agent.ts branches on
    // `options.generative`), so at most one of the two final blocks ever fires.
    const composedGenerative = generativeBoard as GenerativeBoard | null;
    if (grounded && publishedIds.length > 0 && composedGenerative) {
      const id = randomUUID();
      ch.send({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: "render_generative",
        parentMessageId: messageId,
      });
      ch.send({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta: JSON.stringify({
          board: composedGenerative,
          datasets: generativeDatasets,
          fieldMenu: generativeFieldMenu,
          runId: generativeRunId,
          final: true,
        }),
      });
      ch.send({ type: "TOOL_CALL_END", toolCallId: id });
      ch.send({
        type: "TOOL_CALL_RESULT",
        messageId: randomUUID(),
        toolCallId: id,
        content: `Composed a ${composedGenerative.source} generative board with ${composedGenerative.tiles.length} tile(s).`,
        role: "tool",
      });
    }

    // HITL GOVERNANCE GATE (Phase 2 slice 2c). When the grounded answer leaned on
    // a STATISTICAL (probabilistic) conclusion — surfaced as a cited SignalStat
    // (`STAT-*`) node — that conclusion is `routedToHuman` by the reasoner and must
    // not be silently accepted. We emit an UNRESOLVED `review_conclusion` tool call
    // (START/ARGS/END, deliberately NO TOOL_CALL_RESULT) so the frontend's
    // `useHumanInTheLoop` renders an in-thread Approve / Reject / Escalate card and
    // waits for a human. This is ADDITIVE: it never changes the grounded answer text
    // or its citations — deductive (auto-accepted) answers cite no SignalStat and so
    // raise no gate. The live summary/confidence come from the reasoner, not hardcoded.
    if (grounded && publishedIds.some((id) => id.startsWith("STAT-"))) {
      const stat = (await getGatedConclusions()).find(
        (c) => c.kind === "statistical" && c.routedToHuman
      );
      if (stat) {
        const id = randomUUID();
        ch.send({
          type: "TOOL_CALL_START",
          toolCallId: id,
          toolCallName: "review_conclusion",
          parentMessageId: messageId,
        });
        ch.send({
          type: "TOOL_CALL_ARGS",
          toolCallId: id,
          delta: JSON.stringify({
            conclusionId: stat.id,
            summary: stat.summary,
            confidence: stat.confidence ?? null,
          }),
        });
        ch.send({ type: "TOOL_CALL_END", toolCallId: id });
        // NO TOOL_CALL_RESULT — the human supplies it via the HITL card's respond().
      }
    }

    ch.send({ type: "RUN_FINISHED", threadId, runId });
  } catch (err) {
    // Surface as an AG-UI protocol error; never leak an ungrounded fallback.
    const message = err instanceof Error ? err.message : String(err);
    ch.send({ type: "RUN_ERROR", message, code: "ASK_AGENT_FAILED" });
  } finally {
    ch.end();
  }
}
