/**
 * Beat 4 — Grounded Conversation, now powered by CopilotKit's PREBUILT chat.
 *
 * CopilotKit's prebuilt `CopilotChat` drives our EXISTING grounded /ask agent
 * through the thin AG-UI bridge (BFF `POST /api/agui`) — NO second LLM, NO change
 * to the agent. Grounding stays server-side; refusals ("NOT_IN_GRAPH: …") ride
 * through unchanged and DRAW NOTHING.
 *
 * Phase 2 wiring (all verified against the installed v2-next `.d.ts`):
 *  - `CopilotKitProvider` (v2) registers the self-managed AG-UI agent via
 *    `agents__unsafe_dev_only` (bypasses the Copilot Runtime — no extra LLM).
 *  - SHOW-YOUR-WORK + GENERATIVE UI: the provider's `renderToolCalls` prop maps
 *    tool-call names to React renderers. The bridge emits two tool calls:
 *      · `read_neo4j_cypher` — the real read-only Cypher + row preview (trace)
 *      · `render_evidence`   — carries the real cited node ids; we draw GROUNDED
 *                              diagrams (subgraph/PRR-ROR chart/hero flow) from
 *                              those ids + the live graph payload. In-thread.
 *  - CITATIONS → CANVAS: the bridge publishes `{citedNodeIds,isFallback}` as an
 *    AG-UI STATE_SNAPSHOT. We read it off the agent via `useAgent()` (subscribing
 *    to its state events) and pass `active={new Set(citedNodeIds)}` to the
 *    companion `GraphCanvas` so the grounded nodes highlight/pulse.
 *
 * Phase 5 wiring — CONVERSATION PERSISTENCE / RESTORE (additive, reversible):
 *  The self-managed `agents__unsafe_dev_only` path has NO Copilot Runtime, so
 *  thread history lives only in the in-memory `agent` and is lost on reload. We
 *  layer a tiny history-only store on the BFF (`/api/threads`, see threadStore.ts)
 *  AROUND the untouched grounded bridge: after each finalized turn we snapshot
 *  `agent.messages` + the per-turn grounding (citedNodeIds/isFallback) to the
 *  store; a thread switcher lists prior conversations and RESTORES one by calling
 *  `agent.setMessages()` + replaying its grounding into the canvas-highlight
 *  state. The store never touches Neo4j and never weakens grounding — restored
 *  citedNodeIds can only ever be ids the grounded agent itself emitted live.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CopilotKitProvider,
  CopilotChat,
  useAgent,
  useAgentContext,
  useHumanInTheLoop,
} from "@copilotkit/react-core/v2";
import type { ReactToolCallRenderer } from "@copilotkit/react-core/v2";
import { z } from "zod";
import "@copilotkit/react-core/v2/styles.css";
import type { GraphPayload, GraphNode, GraphEdge, ExplanationPath, RiskReport, DashboardSpec, DashboardAudit } from "@rnd/shared";
import { NOT_IN_GRAPH_MARKER, REFUSAL_SUGGESTIONS } from "@rnd/shared";
import { GraphCanvas } from "../components/GraphCanvas.js";
import { NodeContextBar } from "../components/NodeContextBar.js";
import { GroundedDiagrams } from "../components/GroundedDiagrams.js";
import { dashboardRenderer } from "../dashboards/dashboardRenderer.js";
import { generativeRenderer } from "../generative/generativeRenderer.js";
import { AnswerCanvas } from "../components/AnswerCanvas.js";
import { FiltersRail } from "../components/FiltersRail.js";
import { FiltersPopover } from "../components/FiltersPopover.js";
import { api, hitlApi, threadsApi, dashboardsApi } from "../api.js";
import type { ThreadSummary, ThreadMessage } from "../api.js";
import { verifiedNodeIds, lowConfidenceIds } from "../lib/trust.js";
import { resolveCited } from "../lib/evidence.js";
import { applyFilters, EMPTY_FILTERS, type GraphFilters } from "../lib/filterGraph.js";
import { LAST_THREAD_KEY, dedupeById } from "../lib/thread.js";
import { log } from "../lib/log.js";
import type { ConvoSeed } from "../App.js";
import { RefusalCard } from "../components/RefusalCard.js";

interface Props {
  graph: GraphPayload;
  lightCanvas?: boolean;
  onNodeClick: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge) => void;
  /** Open the HITL queue panel (used by Send → Review after enqueue). */
  onOpenHitl?: () => void;
  /** Bumped by App after a governed HITL apply/revert (or manual flag) so the
   *  trust lens here (flag stamps + verified stamp) refetches /api/risk instead
   *  of staying frozen at the mount-time value. */
  refreshKey?: number;
  /** A governed-change context handed in from the HITL audit log ("ask about this
   *  change"): its node(s) join the conversation context, a removable change chip
   *  appears, and any seeded question is submitted once. `nonce` distinguishes each
   *  hand-off so the same change can be re-sent. */
  seed?: ConvoSeed | null;
  /** F6 bridge: CopilotSurface publishes its grounded-ask fn here so the dashboard
   *  tile "Explain" action (built on the provider) can submit a grounded turn. */
  askRef?: { current: ((q: string) => void) | null };
  /** Where a composed board renders: "inline" (Conversation beat, full board in
   *  the transcript — default, unchanged) or "pane" (Studio — pushed to the
   *  "studio" lineage + a compact "opened in canvas" chip inline instead). */
  dashboardTarget?: "inline" | "pane";
  /** Which named agent this beat's chat binds to (verified against the
   *  installed `@copilotkitnext/react` `.d.ts`: `useAgent({ agentId })` and
   *  `<CopilotChat agentId={...} />` both accept an optional `agentId`,
   *  defaulting to the runtime's `default` agent when absent). Absent here
   *  preserves the EXISTING default-agent behaviour byte-for-byte; the
   *  Generative Studio beat (Task 11) passes `agentId="generative"` to bind
   *  to the BFF's second named agent (registered in `copilotRuntime.ts`, T7). */
  agentId?: string;
}

/** Enqueue a grounded answer's conclusion to the HITL review queue, then surface
 *  the queue. Carries only the real cited ids + a summary — no fabricated mutation
 *  (the BFF builds a record-decision-only pending item). */
async function sendToReview(
  cited: GraphNode[],
  onOpenHitl?: () => void,
): Promise<void> {
  if (cited.length === 0) return;
  const summary = `Grounded conclusion over ${cited.length} cited node(s): ${cited
    .slice(0, 3)
    .map((n) => n.label)
    .join(", ")}${cited.length > 3 ? "…" : ""}`;
  try {
    await hitlApi.enqueue({ summary, citedNodeIds: cited.map((n) => n.id) });
  } catch {
    /* best-effort — never break the chat on an enqueue failure */
  }
  onOpenHitl?.();
}

/** Shared citation state the bridge publishes via AG-UI STATE_SNAPSHOT. */
interface CitationState {
  citedNodeIds: string[];
  isFallback: boolean;
}

export function CopilotChatBeat({ graph, lightCanvas, onNodeClick, onEdgeClick, onOpenHitl, refreshKey, seed, dashboardTarget = "inline", agentId }: Props) {
  // Tool-call renderers live on the PROVIDER (verified: `renderToolCalls` is a
  // CopilotKitProviderProps field, not a CopilotChat prop). Memoized so they
  // close over the live graph payload that grounds the diagrams. The evidence
  // renderer also gets click-to-focus (open dossier) and Send → Review wiring.
  // F6 drill-down bridge: the dashboard tiles' "Explain" action must submit a
  // grounded turn, but `askGrounded` lives INSIDE CopilotSurface (needs `useAgent`),
  // while the tool-call renderers are built HERE (on the provider). A ref bridges
  // them: CopilotSurface publishes its `askGrounded` into `askRef`, and the renderer
  // reads it through a stable `onAsk` closure. This is the same proven click→ask path
  // the audit-log pill uses — no new answer route.
  const askRef = useRef<((q: string) => void) | null>(null);
  const onAsk = useCallback((q: string) => askRef.current?.(q), []);
  // F10 — publish a chat-composed board. The spec is the inert, BFF-validated unit
  // and the audit is trusted BFF metadata; the server re-validates the grounding
  // schema on save. No graph write.
  const onSaveDashboard = useCallback(
    async (spec: DashboardSpec, audit: DashboardAudit | null) => {
      await dashboardsApi.save({ title: spec.title, spec, audit: audit ?? undefined });
    },
    []
  );
  const renderToolCalls = useMemo<ReactToolCallRenderer<any>[]>(
    () => [
      cypherRenderer(),
      routeRenderer(),
      evidenceRenderer(graph, { onFocusNode: onNodeClick, onOpenHitl }),
      dashboardTarget === "pane"
        ? dashboardRenderer(graph, { surface: "studio", renderChipOnly: true, onAsk })
        : dashboardRenderer(graph, { onFocusNode: onNodeClick, onAsk, onSave: onSaveDashboard }),
      faithfulnessRenderer(),
      hallucinationRenderer(),
      // Registered unconditionally — `render_generative` only ever arrives on
      // the generative agent's own thread (T7's BFF wiring), so no other beat
      // ever sees this tool call. Chip-only; the Studio canvas (Task 11)
      // subscribes to `generativeStore` directly for the actual tiles.
      generativeRenderer(),
    ],
    [graph, onNodeClick, onOpenHitl, onAsk, onSaveDashboard, dashboardTarget]
  );

  // Phase 2 slice 2a: the chat now runs through the full Copilot **Runtime**
  // (`runtimeUrl`), retiring the self-managed `agents__unsafe_dev_only` dev path.
  // The Runtime is a transparent AG-UI proxy whose single `default` agent is an
  // HttpAgent (server-side) pointed at our UNTOUCHED grounded `/api/agui` bridge —
  // NO LLM key, NO model on the Runtime. Verified end-to-end through
  // `/api/copilotkit`: a grounded answer rides through with its STATE_SNAPSHOT
  // citations + `render_evidence` diagram + Cypher trace, and an off-graph
  // question still returns `NOT_IN_GRAPH:` with `citedNodeIds:[]` and DRAWS
  // NOTHING. `useAgent()` below resolves the Runtime's `default` agent, so the
  // citation STATE_SNAPSHOT → canvas-highlight wiring is unchanged.
  // Relative URL → Vite proxy (/api → http://localhost:8787) reaches the BFF.
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" renderToolCalls={renderToolCalls}>
      <CopilotSurface graph={graph} lightCanvas={lightCanvas} onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onOpenHitl={onOpenHitl} refreshKey={refreshKey} seed={seed} askRef={askRef} agentId={agentId} dashboardTarget={dashboardTarget} />
    </CopilotKitProvider>
  );
}

/** Inner surface — must live INSIDE the provider so `useAgent()` resolves. */
function CopilotSurface({ graph, lightCanvas, onNodeClick, onEdgeClick, onOpenHitl, refreshKey, seed, askRef, agentId, dashboardTarget = "inline" }: Props) {
  // In the Studios (pane mode) the companion knowledge graph is HIDDEN by default —
  // the Studios' own board/tiles canvas is the focus — and pops into a full-screen
  // overlay on demand via the 🕸 Graph button. Inline (Conversation beat) is unchanged.
  const paneMode = dashboardTarget === "pane";
  const [canvasOpen, setCanvasOpen] = useState(false);
  useEffect(() => {
    if (!canvasOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setCanvasOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canvasOpen]);
  // `useAgent({ agentId })` with `agentId` undefined behaves IDENTICALLY to the
  // prior bare `useAgent()` call — the installed `@copilotkitnext/react` hook
  // does `agentId ??= DEFAULT_AGENT_ID` internally (verified in
  // `node_modules/@copilotkitnext/react/dist/index.mjs`), so every existing
  // beat (which never passes `agentId`) is byte-identical to before.
  const { agent } = useAgent({ agentId });
  const [cited, setCited] = useState<CitationState>({ citedNodeIds: [], isFallback: false });

  // --- Node → chat context (click graph nodes to focus the conversation) -----
  // Clicking a companion-graph node toggles it into the conversation's "context":
  // a removable chip per node + grounded question pills appear above the chat
  // (node-specific for one node, relational for several). Click a selected node
  // again to drop it; per-chip × or "Clear all" reset it. We ALSO bubble the click
  // to the app's provenance-drawer inspect so that behaviour is preserved.
  const [contextNodes, setContextNodes] = useState<GraphNode[]>([]);

  /** Submit a normal grounded turn through the SAME agent the composer uses.
   *  Returns false if it could not submit (agent not ready / threw) so callers
   *  can keep a staged question instead of clearing it on a silent no-op. */
  const askGrounded = useCallback(
    (message: string): boolean => {
      if (!agent) return false;
      try {
        // Unique id per turn — a length+prefix scheme collided when the SAME
        // question was asked twice (duplicate id → CopilotKit drops the repeat,
        // so re-asking silently did nothing).
        agent.addMessage?.({ id: `u_${crypto.randomUUID()}`, role: "user", content: message } as never);
        void agent.runAgent?.();
        return true;
      } catch {
        /* fall back to the composer */
        return false;
      }
    },
    [agent]
  );

  // F6 bridge: publish the grounded-ask fn so the dashboard tile "Explain" action
  // (rendered on the provider, outside this component) can route through it.
  useEffect(() => {
    if (askRef) askRef.current = (q: string) => void askGrounded(q);
    return () => {
      if (askRef) askRef.current = null;
    };
  }, [askRef, askGrounded]);

  const handleNodeClick = useCallback(
    (n: GraphNode) => {
      // Toggle this node in/out of the accumulating context set (by id).
      setContextNodes((prev) =>
        prev.some((p) => p.id === n.id) ? prev.filter((p) => p.id !== n.id) : [...prev, n],
      );
      onNodeClick(n); // keep the existing provenance-drawer inspect
    },
    [onNodeClick]
  );

  // --- Governed-change context (from the HITL audit log "ask about this change") --
  // A removable chip naming the change the user chose to ask about. It carries NO
  // facts to the agent (grounding stays the read-only graph + the node chips); it's
  // a visible marker, and it seeds change-aware questions. Cleared with its ×.
  const [changeContext, setChangeContext] = useState<ConvoSeed["change"] | null>(null);
  // A question handed in from the audit log, staged as a one-click "Ask" pill. We
  // deliberately do NOT auto-fire it from an effect: on a fresh Beat-4 mount the
  // chat restores its last thread a beat after the agent resolves, and that restore
  // clobbers any turn injected during mount. Staging it as a pill routes it through
  // the SAME proven click→askGrounded path the other suggestions use — reliable,
  // and the presenter stays in control of when it sends.
  const [seededQuestion, setSeededQuestion] = useState<string | null>(null);
  // Apply each audit-log hand-off exactly once, keyed on nonce: merge its node(s)
  // into context, set the change chip, and stage its question. Idempotent.
  const appliedSeedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!seed || appliedSeedRef.current === seed.nonce) return;
    appliedSeedRef.current = seed.nonce;
    setContextNodes((prev) => {
      const have = new Set(prev.map((p) => p.id));
      return [...prev, ...seed.nodes.filter((n) => !have.has(n.id))];
    });
    setChangeContext(seed.change);
    setSeededQuestion(seed.question ?? null);
  }, [seed]);

  // --- STATIC suggestions (grounding-safe AND cost-safe) --------------------
  // We deliberately do NOT use CopilotKit's `useConfigureSuggestions`: its
  // auto-reload (`onAgentsChanged → reloadSuggestions`) RUNS the grounded agent
  // (~500k-token context) on a loop while the chat sits idle — a silent budget
  // leak. Instead we render our OWN fixed, presenter-trusted pills (BeatStarters
  // below) that submit a normal user turn through the SAME grounded bridge. No
  // model-written follow-ups (no second ungrounded path), and nothing fires while
  // the chat is idle.

  // --- Phase 2 slice 2b: readable context (NOT an answer source) ------------
  // Expose the graph's SHAPE (the node kinds present + the hero scenario) as
  // readable context so the agent can phrase itself in the demo's vocabulary.
  // This is metadata ONLY: the value carries no facts to answer from, and the
  // text explicitly instructs the agent to read the live graph for any fact —
  // grounding still comes solely from the read-only Cypher the bridge runs.
  const schemaSummary = useMemo(() => {
    const kinds = Array.from(new Set(graph.nodes.map((n) => n.kind))).sort();
    return {
      note: "SCHEMA/LEGEND ONLY — not a source of facts. Answer every question by reading the live Neo4j graph (read-only Cypher); never answer from this context.",
      scenario:
        "Oncology pharmacovigilance trust graph. Hero scenario: anti-PD-1 checkpoint inhibitor → immune-related myocarditis candidate signal.",
      nodeKinds: kinds,
    };
  }, [graph.nodes]);
  useAgentContext({
    description: "Graph schema and legend (node kinds + hero scenario). Metadata only, not an answer source.",
    value: schemaSummary,
  });

  // --- Thread state (Phase 5) ----------------------------------------------
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  // Bump to force CopilotChat to remount (rebind to a fresh/loaded thread).
  const [chatKey, setChatKey] = useState(0);
  // Latest grounding for THIS thread, kept in a ref so the persist effect always
  // snapshots the freshest citations without re-subscribing.
  const citedRef = useRef<CitationState>(cited);
  citedRef.current = cited;

  // --- History pane: resizable + collapsible (presenter ergonomics) --------
  // Drag the handle to resize the conversation-history column; collapse it to
  // hand the space to the chat + canvas. Both persist to localStorage (same
  // convention as LAST_THREAD_KEY) so the presenter's layout survives a reload.
  const HISTORY_MIN = 140;
  const HISTORY_MAX = 420;
  const [historyWidth, setHistoryWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("rtg.beat4.historyWidth"));
      if (Number.isFinite(v) && v >= HISTORY_MIN && v <= HISTORY_MAX) return v;
    } catch {
      /* private mode / no storage — fall through to default */
    }
    return 196;
  });
  const [historyCollapsed, setHistoryCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("rtg.beat4.historyCollapsed") === "1";
    } catch {
      return false;
    }
  });
  // Ref so the drag handler reads the live start-width without re-subscribing.
  const historyWidthRef = useRef(historyWidth);
  historyWidthRef.current = historyWidth;
  useEffect(() => {
    try {
      localStorage.setItem("rtg.beat4.historyWidth", String(historyWidth));
    } catch {
      /* best-effort persistence */
    }
  }, [historyWidth]);
  useEffect(() => {
    try {
      localStorage.setItem("rtg.beat4.historyCollapsed", historyCollapsed ? "1" : "0");
    } catch {
      /* best-effort persistence */
    }
  }, [historyCollapsed]);

  /** Begin a drag-resize of the history column from the current pointer x. */
  const startHistoryResize = useCallback((clientX: number) => {
    const startX = clientX;
    const startW = historyWidthRef.current;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, startW + (ev.clientX - startX)));
      setHistoryWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // --- Chat ↔ canvas split: draggable boundary between the chat column and the
  // trust-lens/answer canvas. Stored as the CHAT share (0–1) of the chat+canvas
  // region so it survives the history pane being resized/collapsed. Persisted to
  // localStorage like historyWidth. Default 0.4 ≡ the prior fixed 1fr : 1.5fr.
  const MAIN_MIN = 0.28;
  const MAIN_MAX = 0.7;
  const [chatFrac, setChatFrac] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("rtg.beat4.chatFrac"));
      if (Number.isFinite(v) && v >= MAIN_MIN && v <= MAIN_MAX) return v;
    } catch {
      /* private mode / no storage — fall through to default */
    }
    return 0.4;
  });
  useEffect(() => {
    try {
      localStorage.setItem("rtg.beat4.chatFrac", String(chatFrac));
    } catch {
      /* best-effort persistence */
    }
  }, [chatFrac]);
  // Refs to the chat + canvas columns so the drag maps the absolute pointer x to a
  // fraction of the actual on-screen region (handle tracks the cursor exactly,
  // independent of the live history width).
  const chatColRef = useRef<HTMLDivElement | null>(null);
  const canvasColRef = useRef<HTMLDivElement | null>(null);

  /** Begin a drag-resize of the chat ↔ canvas boundary from the current pointer. */
  const startMainResize = useCallback(() => {
    const chatRect = chatColRef.current?.getBoundingClientRect();
    const canvasRect = canvasColRef.current?.getBoundingClientRect();
    if (!chatRect || !canvasRect) return;
    const left = chatRect.left;
    const width = canvasRect.right - chatRect.left;
    if (width <= 0) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) => {
      const frac = Math.min(MAIN_MAX, Math.max(MAIN_MIN, (ev.clientX - left) / width));
      setChatFrac(frac);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setThreads(await threadsApi.list());
    } catch {
      /* list is best-effort; an empty list still lets the user start a chat */
    }
  }, []);

  /** Persist the current thread snapshot (messages + grounding) to the BFF.
   *  Reads grounding from the agent's live state (the STATE_SNAPSHOT the bridge
   *  just published) rather than React state, which may not have flushed yet when
   *  this fires synchronously inside onRunFinalized. Falls back to the ref. */
  const persist = useCallback(
    async (id: string) => {
      if (!agent || !id) return;
      const messages = dedupeById((agent.messages ?? []) as unknown as ThreadMessage[]);
      // Never persist a blank thread: a run can finalize (onRunFinalized) before the
      // user has actually said anything (auto/empty runs). Without a real user turn
      // there is nothing worth saving — skip it so no empty "Conversation …" lands.
      const hasUserTurn = messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
      );
      if (!hasUserTurn) return;
      const live = (agent.state ?? {}) as Partial<CitationState>;
      const citedNodeIds = Array.isArray(live.citedNodeIds)
        ? live.citedNodeIds.map(String)
        : citedRef.current.citedNodeIds;
      const isFallback =
        typeof live.isFallback === "boolean" ? live.isFallback : citedRef.current.isFallback;
      try {
        await threadsApi.save(id, {
          messages,
          grounding: { citedNodeIds, isFallback },
        });
        void refreshList();
      } catch {
        /* persistence is best-effort; never break the live chat on a save error */
      }
    },
    [agent, refreshList]
  );

  // --- Phase 2 slice 2c: HITL governance gate (human-in-the-loop) -----------
  // The grounded bridge emits an UNRESOLVED `review_conclusion` tool call whenever
  // a grounded answer leaned on a STATISTICAL (probabilistic) conclusion the
  // reasoner routed to a human (a cited `STAT-*` SignalStat). We render an
  // in-thread Approve / Reject / Escalate card and supply the agent's tool result
  // via `respond()`. `followUp:false` → answering NEVER re-invokes the agent (no
  // second LLM turn), so this is a pure governance capture, not a new answer path.
  // A ref keeps the active threadId fresh so we can persist the decision after it.
  const threadIdRef = useRef<string | null>(threadId);
  threadIdRef.current = threadId;
  useHumanInTheLoop(
    {
      name: "review_conclusion",
      description:
        "Human review of a statistical (probabilistic) conclusion before acceptance: approve, reject, or escalate.",
      parameters: z.object({
        conclusionId: z.string().optional(),
        summary: z.string().optional(),
        confidence: z.number().nullable().optional(),
      }),
      followUp: false,
      render: ({ args, respond, result }) => (
        <HitlReviewCard
          summary={args?.summary}
          confidence={args?.confidence ?? undefined}
          respond={respond}
          result={typeof result === "string" ? result : undefined}
          onResolved={() => {
            const id = threadIdRef.current ?? agent?.threadId ?? null;
            if (id) void persist(id);
          }}
        />
      ),
    },
    [persist, agent]
  );

  /** Load a thread into the live agent: messages + replayed grounding. */
  const loadThread = useCallback(
    async (id: string) => {
      if (!agent) return;
      try {
        const rec = await threadsApi.get(id);
        // Restore the conversation INTO the agent so the prebuilt chat redraws it.
        // De-dup defends against a record that already holds a duplicate id.
        agent.setMessages(dedupeById((rec.messages ?? []) as ThreadMessage[]) as any);
        agent.threadId = id;
        // Replay the persisted grounding so chips + canvas highlight come back.
        const g = rec.grounding ?? { citedNodeIds: [], isFallback: false };
        try {
          agent.setState({ ...(agent.state ?? {}), ...g });
        } catch {
          /* setState may reject unknown shapes on some builds — UI state below
             is the source of truth for the highlight regardless */
        }
        setCited({ citedNodeIds: g.citedNodeIds ?? [], isFallback: Boolean(g.isFallback) });
      } catch {
        // Missing thread → start it clean rather than hang.
        agent.setMessages([] as any);
        setCited({ citedNodeIds: [], isFallback: false });
      }
      setThreadId(id);
      localStorage.setItem(LAST_THREAD_KEY, id);
      setChatKey((k) => k + 1); // remount CopilotChat bound to this thread
    },
    [agent]
  );

  /** Start a brand-new conversation LAZILY: mint a client-side threadId but do
   *  NOT write it to the store yet. The thread is persisted (and thus appears in
   *  the switcher) only once the first turn finalizes — see `persist` in the
   *  onRunFinalized handler below. This stops empty "Conversation <timestamp>"
   *  rows from accumulating every time a surface mounts or the user clicks New
   *  without typing (the store's createThread wrote a blank row on every mount). */
  const newThread = useCallback(() => {
    if (!agent) return;
    const id = crypto.randomUUID();
    agent.setMessages([] as any);
    try {
      agent.threadId = id;
    } catch {
      /* some builds make threadId read-only; threadId state below still drives persist */
    }
    setCited({ citedNodeIds: [], isFallback: false });
    setThreadId(id);
    localStorage.setItem(LAST_THREAD_KEY, id);
    setChatKey((k) => k + 1);
  }, [agent]);

  const removeThread = useCallback(
    async (id: string) => {
      try {
        await threadsApi.remove(id);
      } catch {
        /* ignore */
      }
      await refreshList();
      if (id === threadId) await newThread();
    },
    [refreshList, threadId, newThread]
  );

  // On first mount: list threads and restore the last-open one (or start fresh).
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    (async () => {
      await refreshList();
      if (cancelled) return;
      const last = localStorage.getItem(LAST_THREAD_KEY);
      const list = await threadsApi.list().catch(() => [] as ThreadSummary[]);
      if (cancelled) return;
      if (last && list.some((t) => t.threadId === last)) {
        await loadThread(last);
      } else {
        await newThread();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // Read the agent's shared state (published as STATE_SNAPSHOT by the bridge).
  // Subscribe to its state-change events and lift `citedNodeIds` into React; on
  // each finalized run, PERSIST the thread so a reload/switch restores it.
  useEffect(() => {
    if (!agent) return;
    const read = () => {
      const s = (agent.state ?? {}) as Partial<CitationState>;
      setCited({
        citedNodeIds: Array.isArray(s.citedNodeIds) ? s.citedNodeIds : [],
        isFallback: Boolean(s.isFallback),
      });
    };
    read(); // initial
    const sub = agent.subscribe({
      onStateSnapshotEvent: () => read(),
      onStateDeltaEvent: () => read(),
      onRunFinalized: () => {
        read();
        // Snapshot AFTER state is applied; threadId is the active conversation.
        const id = threadId ?? agent.threadId;
        if (id) void persist(id);
      },
      // New run starting → clear stale highlights until fresh citations arrive.
      onRunInitialized: () => setCited({ citedNodeIds: [], isFallback: false }),
    });
    return () => sub.unsubscribe();
  }, [agent, threadId, persist]);

  // --- Resumable stream-drop retry (best-effort) ------------------------------
  // `agent.subscribe()`'s `onRunFailed` is a REAL typed AG-UI callback (verified
  // against the installed `@ag-ui/client` `.d.ts`: `AgentSubscriber.onRunFailed`),
  // fired when a run throws/drops mid-stream (e.g. an SSE connection drop). We
  // surface this as a calm, non-red "still composing" chip rather than a red
  // error toast — the underlying answer route is untouched; retry just re-submits
  // the same last user question through the SAME `askGrounded` path.
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!agent) return;
    const sub = agent.subscribe({
      onRunFailed: () => setStalled(true),
      onRunInitialized: () => setStalled(false),
      onRunFinalized: () => setStalled(false),
    });
    return () => sub.unsubscribe();
  }, [agent]);

  const active = useMemo(() => new Set(cited.citedNodeIds), [cited.citedNodeIds]);

  // --- NOT_IN_GRAPH refusal card (annotate-only) ------------------------------
  // True only when the LATEST assistant turn is the honest refusal — an older
  // refusal followed by a good answer must not keep showing the card.
  const refused = useMemo(() => {
    const messages = dedupeById((agent?.messages ?? []) as unknown as ThreadMessage[]);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant") return typeof m.content === "string" && m.content.includes(NOT_IN_GRAPH_MARKER);
      if (m.role === "user") break; // no assistant turn yet for the latest user message
    }
    return false;
  }, [agent?.messages]);

  // The last user question — used both by the refusal card's suggestion pills
  // (via askGrounded directly) and the retry chip (re-submits the SAME question).
  const lastUserQuestion = useMemo(() => {
    const messages = dedupeById((agent?.messages ?? []) as unknown as ThreadMessage[]);
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].content ?? "";
    }
    return "";
  }, [agent?.messages]);

  // --- Trust lens + filters + answer canvas (right column) -------------------
  // Risk drives the low-confidence halo; explain supplies the deductive hop-path
  // shown in the answer canvas. Both are read-only, derived from served payloads.
  const [report, setReport] = useState<RiskReport>();
  const [explain, setExplain] = useState<ExplanationPath>();
  useEffect(() => {
    api.risk().then(setReport).catch((e) => log.error("risk() load failed:", e));
    api.explain().then(setExplain).catch((e) => log.error("explain() load failed:", e));
  }, [refreshKey]);
  const [filters, setFilters] = useState<GraphFilters>(() => ({ ...EMPTY_FILTERS, kinds: new Set() }));
  const readiness = useMemo(
    () => new Map(report?.findings.map((f) => [f.nodeId, f.readiness]) ?? []),
    [report],
  );
  const verified = useMemo(() => {
    const s = verifiedNodeIds(graph);
    for (const id of report?.humanReviewed ?? []) s.add(id);
    return s;
  }, [graph, report]);
  const lowConfidence = useMemo(() => lowConfidenceIds(readiness), [readiness]);
  const flaggedSet = useMemo(
    () => new Set((report?.findings ?? []).filter((f) => f.flags.length > 0).map((f) => f.nodeId)),
    [report],
  );
  // Cited (active) nodes are ALWAYS kept so a filter can never hide a citation.
  const shown = useMemo(
    () => applyFilters(graph, filters, readiness, verified, flaggedSet, active),
    [graph, filters, readiness, verified, flaggedSet, active],
  );
  // The latest answer's cited nodes (intersected with the graph) + the hero path
  // only when the answer actually touches it (so we never show an unrelated path).
  const answerCited = useMemo(() => resolveCited(cited.citedNodeIds, graph), [cited.citedNodeIds, graph]);
  const answerPath = useMemo(() => {
    if (!explain) return undefined;
    const onPath = new Set(explain.hops.map((h) => h.node.id));
    return answerCited.some((n) => onPath.has(n.id)) ? explain : undefined;
  }, [explain, answerCited]);

  // Hold the heavy CopilotKit chat as a memoized element so React reuses the SAME
  // element reference across re-renders and bails out of reconciling its subtree.
  // Without this, toggling `contextNodes` on a node click (the suggestion strip
  // swap below) re-renders <CopilotChat>, re-initializing its composer — the
  // <textarea> gets a new DOM node, which flashes/resets the chat and looks like a
  // page reload. Deps are ONLY the intentional remount keys: chatKey still bumps on
  // thread load/new (loadThread/newThread), so switching threads still rebinds.
  const chatEl = useMemo(
    () =>
      threadId ? (
        <CopilotChat key={chatKey} threadId={threadId} agentId={agentId} />
      ) : (
        <CopilotChat key={chatKey} agentId={agentId} />
      ),
    [threadId, chatKey, agentId],
  );

  return (
    <div
      style={{
        display: "grid",
        // Track 1 = history column (drag-resizable, collapses to 0); track 2 = the
        // 6px history drag handle / collapsed re-open rail; track 3 = chat; track 4
        // = the 6px chat↔canvas drag handle; track 5 = trust-lens/answer canvas.
        // chatFrac/(1-chatFrac) is the draggable chat:canvas split (0.4 ≡ 1:1.5).
        // Pane mode (Studios): drop the chat↔canvas split — the companion graph is
        // a pop-out overlay, so the chat takes the whole pane. Inline: 5-track split.
        gridTemplateColumns: paneMode
          ? `${historyCollapsed ? 0 : historyWidth}px 6px minmax(0, 1fr)`
          : `${historyCollapsed ? 0 : historyWidth}px 6px minmax(0, ${chatFrac}fr) 6px minmax(0, ${1 - chatFrac}fr)`,
        // minmax(0,1fr) row + minHeight:0 let the columns shrink to the bounded
        // height so their inner overflow:auto engages (history list scrolls, page
        // doesn't grow).
        gridTemplateRows: "minmax(0, 1fr)",
        gap: 14,
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* LEFT: thread switcher / history sidebar (Phase 5). Collapsed → a 0-width
          empty cell (the re-open affordance lives on the handle to its right). */}
      {historyCollapsed ? (
        <div aria-hidden style={{ overflow: "hidden" }} />
      ) : (
        <ThreadSidebar
          threads={threads}
          activeId={threadId}
          onSelect={loadThread}
          onNew={newThread}
          onDelete={removeThread}
          onCollapse={() => setHistoryCollapsed(true)}
        />
      )}

      {/* Drag handle (resize) / collapsed rail (click to re-open). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={historyCollapsed ? "Show conversation history" : "Resize conversation history"}
        title={historyCollapsed ? "Show history" : "Drag to resize the history pane"}
        onMouseDown={historyCollapsed ? undefined : (e) => startHistoryResize(e.clientX)}
        onClick={historyCollapsed ? () => setHistoryCollapsed(false) : undefined}
        style={{
          cursor: historyCollapsed ? "pointer" : "col-resize",
          background: "var(--frame-surface)",
          border: "1px solid var(--frame-border)",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--frame-text-muted)",
          fontSize: 11,
          lineHeight: 1,
          userSelect: "none",
          writingMode: historyCollapsed ? "vertical-rl" : "horizontal-tb",
          transition: "background var(--dur) var(--ease), color var(--dur) var(--ease)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(88,166,255,.16)";
          e.currentTarget.style.color = "var(--frame-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--frame-surface)";
          e.currentTarget.style.color = "var(--frame-text-muted)";
        }}
      >
        {historyCollapsed ? "› History" : "⋮"}
      </div>

      {/* MIDDLE: prebuilt CopilotKit chat (thread + composer + generative tool UI) */}
      <div
        ref={chatColRef}
        style={{
          background: "var(--frame-surface)",
          color: "var(--frame-text)",
          border: "1px solid var(--frame-border)",
          borderRadius: "var(--radius)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        {/* Pane mode (Studios): the companion knowledge graph is hidden — this
            button pops it into a full-screen overlay only when the presenter wants it. */}
        {paneMode && (
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 8px 0" }}>
            <button
              type="button"
              onClick={() => setCanvasOpen(true)}
              title="Show the companion knowledge graph in a full-screen overlay"
              style={{
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 6,
                border: "1px solid var(--frame-border)",
                background: "transparent",
                color: "var(--frame-text)",
                cursor: "pointer",
              }}
            >
              🕸 Graph
            </button>
          </div>
        )}
        {/* Static, presenter-trusted starter prompts (replaces CopilotKit's
            cost-leaking auto-suggestions). Hidden once the thread has turns. */}
        {/* Generic starters OR node-context pills — never both, so the suggestion
            rows never duplicate. A selected node takes over the suggestion strip.
            Wrapped in a STABLE container so the chat's sibling list never changes
            shape when the strip swaps (keeps <CopilotChat> reconciliation stable). */}
        <div className="suggestion-strip">
          {changeContext && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                margin: "0 0 6px",
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid var(--frame-border)",
                background: "rgba(45,212,191,.08)",
                fontSize: 12,
              }}
              title={`Governed change: ${changeContext.summary}`}
            >
              <span aria-hidden style={{ color: "#2dd4bf" }}>⚙</span>
              <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                Change in context: <strong>{changeContext.title}</strong>
              </span>
              <button
                type="button"
                onClick={() => setChangeContext(null)}
                aria-label="Remove change from context"
                title="Remove change from context"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--frame-text-muted)",
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                  flex: "0 0 auto",
                }}
              >
                ×
              </button>
            </div>
          )}
          {seededQuestion && (
            <button
              type="button"
              onClick={() => {
                // Only clear the staged question if it actually submitted — if the
                // agent isn't ready yet, keep the pill so the click isn't lost.
                if (askGrounded(seededQuestion)) setSeededQuestion(null);
              }}
              title="Ask this question about the change — answered from the live graph"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                margin: "0 0 6px",
                padding: "8px 12px",
                borderRadius: 10,
                border: "1px solid rgba(45,212,191,.5)",
                background: "rgba(45,212,191,.12)",
                color: "var(--frame-text)",
                cursor: "pointer",
                fontSize: 13,
                textAlign: "left",
              }}
            >
              <span aria-hidden style={{ color: "#2dd4bf", flex: "0 0 auto" }}>✦</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <strong>Ask:</strong> {seededQuestion}
              </span>
              <span aria-hidden style={{ color: "var(--frame-text-muted)", flex: "0 0 auto" }}>↵</span>
            </button>
          )}
          {contextNodes.length > 0 ? (
            <NodeContextBar
              nodes={contextNodes}
              onRemove={(id) => setContextNodes((prev) => prev.filter((p) => p.id !== id))}
              onClearAll={() => setContextNodes([])}
              onAsk={askGrounded}
            />
          ) : (
            <BeatStarters agent={agent} />
          )}
        </div>
        {/* Memoized (deps [threadId, chatKey]) so node-click context changes never
            re-render the composer; chatKey still remounts it on thread switch.
            Wrapped so it always takes exactly the remaining column height (flex:1,
            minHeight:0) — this leaves deterministic room below for the refusal
            card / retry chip without ever squeezing them out or overflowing the
            (overflow:hidden) column. */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {chatEl}
        </div>
        {/* Branded NOT_IN_GRAPH refusal card — annotate-only, shown ONLY on the
            latest refused turn. `onAsk` is the SAME `askGrounded` fn CopilotSurface
            publishes to `askRef`; no new answer route. */}
        {refused && (
          <div style={{ flex: "0 0 auto", padding: "0 12px 10px" }}>
            <RefusalCard suggestions={[...REFUSAL_SUGGESTIONS]} onAsk={askGrounded} />
          </div>
        )}
        {/* Resumable stream-drop retry (best-effort, see onRunFailed subscribe
            above) — a calm, non-red chip, never an error toast. */}
        {stalled && (
          <div style={{ flex: "0 0 auto", padding: "0 12px 10px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid var(--frame-border)",
                background: "rgba(234,179,8,.08)",
                color: "var(--frame-text)",
              }}
            >
              <span aria-hidden>⏳</span>
              <span style={{ flex: 1 }}>Still composing… the local model is slow.</span>
              <button
                type="button"
                onClick={() => {
                  if (lastUserQuestion) askGrounded(lastUserQuestion);
                  setStalled(false);
                }}
                style={{
                  fontSize: 12,
                  padding: "3px 10px",
                  borderRadius: 999,
                  border: "1px solid var(--frame-border)",
                  background: "rgba(88,166,255,.10)",
                  color: "var(--frame-text)",
                  cursor: "pointer",
                }}
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Drag handle: resize the chat ↔ canvas boundary. Same affordance as the
          history handle, so the two splitters read as one consistent control.
          Inline only — pane mode has no inline canvas to resize against. */}
      {!paneMode && (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat and graph canvas"
        title="Drag to resize the chat and the graph canvas"
        onMouseDown={() => startMainResize()}
        style={{
          cursor: "col-resize",
          background: "var(--frame-surface)",
          border: "1px solid var(--frame-border)",
          borderRadius: "var(--radius-sm)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--frame-text-muted)",
          fontSize: 11,
          lineHeight: 1,
          userSelect: "none",
          transition: "background var(--dur) var(--ease), color var(--dur) var(--ease)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(88,166,255,.16)";
          e.currentTarget.style.color = "var(--frame-text)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--frame-surface)";
          e.currentTarget.style.color = "var(--frame-text-muted)";
        }}
      >
        ⋮
      </div>
      )}

      {/* RIGHT: trust lens (filters + companion graph) + the KMC answer canvas.
          Cited nodes highlight/pulse via STATE_SNAPSHOT and are never filtered
          away; clicking a node (or a citation chip) makes it the context + opens
          the dossier.
          Inline: a grid column. Pane (Studios): hidden by default, popped into a
          full-screen overlay via the 🕸 Graph button (Esc / ⤧ Close to dismiss). */}
      {(!paneMode || canvasOpen) && (
      <div
        ref={canvasColRef}
        style={
          paneMode
            ? { position: "fixed", inset: 0, zIndex: 1000, display: "flex", flexDirection: "column", gap: 8, overflowY: "auto", padding: 16, background: "var(--frame-surface)" }
            : { display: "flex", flexDirection: "column", minHeight: 0, gap: 8, overflowY: "auto" }
        }
      >
        {paneMode && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => setCanvasOpen(false)}
              title="Close the companion graph (Esc)"
              style={{
                fontSize: 11,
                padding: "3px 8px",
                borderRadius: 6,
                border: "1px solid var(--frame-border)",
                background: "rgba(88,166,255,.16)",
                color: "var(--frame-text)",
                cursor: "pointer",
              }}
            >
              ⤧ Close graph
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <FiltersPopover>
            <FiltersRail graph={graph} filters={filters} onChange={setFilters} visibleCount={shown.nodes.length} />
          </FiltersPopover>
          <div style={{ flex: 1, minWidth: 0 }}>
            <GraphCanvas
              graph={shown}
              active={active}
              pathNodes={active}
              readiness={readiness}
              verified={verified}
              lowConfidence={lowConfidence}
              flagged={flaggedSet}
              searchable
              lightCanvas={lightCanvas}
              filtersSlot={<FiltersRail graph={graph} filters={filters} onChange={setFilters} visibleCount={shown.nodes.length} />}
              onNodeClick={handleNodeClick}
              onEdgeClick={onEdgeClick}
              // Larger inline companion; the ⤢ toggle (top-right) expands it to full
              // screen, where the filtersSlot above keeps the filters reachable.
              height={520}
            />
          </div>
        </div>
        {answerCited.length > 0 && (
          <>
            <AnswerCanvas
              cited={answerCited}
              graph={graph}
              path={answerPath}
              onFocusNode={handleNodeClick}
              showSubgraph={false}
            />
          </>
        )}
      </div>
      )}
    </div>
  );
}

/** Static starter prompts for Beat 4 — our own pills, NOT CopilotKit's auto-
 *  suggestions (whose reload loop runs the grounded agent on idle, leaking spend).
 *  Clicking one submits a normal grounded turn via the SAME agent the composer
 *  uses. Hidden once the thread has any messages. */
const BEAT_STARTERS: { title: string; message: string }[] = [
  { title: "Safety signal", message: "What is the safety signal for the checkpoint inhibitor?" },
  { title: "Mechanism", message: "How does the checkpoint inhibitor cause myocarditis?" },
  { title: "Evidence", message: "What evidence supports the myocarditis signal?" },
  { title: "What's missing?", message: "What is known, what is missing, and what is conflicting for the myocarditis signal?" },
  { title: "Human review", message: "Which conclusions are routed to a human reviewer, and why?" },
];

/** Explicit, discoverable entry point for the generative-dashboard build. A dashboard
 *  already composes as a side-effect of ANY grounded, cited answer, but nothing told
 *  the user that — so these labelled prompts make the capability visible. They route
 *  through the SAME grounded `ask()` bridge (no new answer path); each is phrased to
 *  land on the myocarditis hero scenario, which reliably cites real nodes → the
 *  composer runs → a live DashboardSpec renders below the answer. */
const DASHBOARD_STARTERS: { title: string; message: string }[] = [
  { title: "Signal dashboard", message: "Build a live dashboard for the checkpoint-inhibitor myocarditis safety signal — show the disproportionality, the mechanism, and the supporting evidence." },
  { title: "Evidence board", message: "Compose a dashboard of the evidence and provenance behind the myocarditis signal." },
  { title: "Full case view", message: "Give me a dashboard summarising what is known, missing, and conflicting for the myocarditis signal, with the relational subgraph." },
];

function BeatStarters({ agent }: { agent: ReturnType<typeof useAgent>["agent"] }) {
  const [sent, setSent] = useState(false);
  if (sent || !agent || (agent.messages?.length ?? 0) > 0) return null;

  const ask = (message: string) => {
    setSent(true);
    try {
      // Unique id per turn (see askGrounded) — avoid the length+prefix collision.
      agent.addMessage?.({ id: `u_${crypto.randomUUID()}`, role: "user", content: message } as never);
      void agent.runAgent?.();
    } catch {
      setSent(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 10px 0" }}>
      {/* Discoverable generative-dashboard launcher — the "new build" the user
          couldn't find. Visually distinct (teal genUI accent) from the plain
          question starters, but routes through the identical grounded ask path. */}
      <div
        data-testid="dashboard-launcher"
        style={{
          border: "1px solid rgba(45,212,191,.5)",
          background: "rgba(45,212,191,.10)",
          borderRadius: 10,
          padding: "9px 11px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
          <span aria-hidden style={{ color: "#2dd4bf" }}>✨</span>
          <strong style={{ fontSize: 12.5 }}>Generate a live dashboard</strong>
          <span style={{ fontSize: 10.5, opacity: 0.7 }}>
            grounded, certified tiles composed from the graph
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {DASHBOARD_STARTERS.map((s) => (
            <button
              key={s.title}
              type="button"
              onClick={() => ask(s.message)}
              title={s.message}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "5px 11px",
                borderRadius: 999,
                border: "1px solid rgba(45,212,191,.55)",
                background: "rgba(45,212,191,.16)",
                color: "var(--frame-text)",
                cursor: "pointer",
              }}
            >
              ✨ {s.title}
            </button>
          ))}
        </div>
      </div>

      {/* Plain grounded-question starters. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {BEAT_STARTERS.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => ask(s.message)}
            title={s.message}
            style={{
              fontSize: 12,
              padding: "5px 10px",
              borderRadius: 999,
              border: "1px solid var(--frame-border)",
              background: "rgba(88,166,255,.10)",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            {s.title}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Thread switcher sidebar — list prior conversations, start a new one, restore
 *  one, or delete. History-only; selecting a thread reloads its messages + chips. */
function ThreadSidebar({
  threads,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onCollapse,
}: {
  threads: ThreadSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onCollapse?: () => void;
}) {
  return (
    <div
      data-testid="thread-sidebar"
      style={{
        background: "var(--frame-surface)",
        color: "var(--frame-text)",
        border: "1px solid var(--frame-border)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 10px",
          borderBottom: "1px solid var(--frame-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 6,
        }}
      >
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--frame-text-muted)" }}>
          Conversations
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            onClick={onNew}
            title="Start a new conversation"
            style={{
              fontSize: 12,
              lineHeight: 1,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--frame-border)",
              background: "rgba(88,166,255,0.10)",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            + New
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              title="Hide conversation history"
              aria-label="Hide conversation history"
              style={{
                fontSize: 13,
                lineHeight: 1,
                padding: "4px 7px",
                borderRadius: 6,
                border: "1px solid var(--frame-border)",
                background: "transparent",
                color: "var(--frame-text-muted)",
                cursor: "pointer",
              }}
            >
              ‹
            </button>
          )}
        </div>
      </div>
      <div style={{ overflowY: "auto", flex: 1, padding: 6 }}>
        {threads.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--frame-text-muted)", padding: "8px 6px" }}>
            No saved conversations yet.
          </div>
        ) : (
          threads.map((t) => {
            const isActive = t.threadId === activeId;
            return (
              <div
                key={t.threadId}
                data-testid="thread-item"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  borderRadius: 6,
                  marginBottom: 2,
                  background: isActive ? "rgba(88,166,255,0.16)" : "transparent",
                  border: isActive ? "1px solid var(--frame-border)" : "1px solid transparent",
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(t.threadId)}
                  title={`${t.title} · ${t.messageCount} message(s)`}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    color: "var(--frame-text)",
                    cursor: "pointer",
                    padding: "6px 8px",
                    fontSize: 12.5,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.title}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(t.threadId)}
                  title="Delete this conversation"
                  style={{
                    border: "none",
                    background: "transparent",
                    color: "var(--frame-text-muted)",
                    cursor: "pointer",
                    padding: "4px 6px",
                    fontSize: 13,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Phase 2 slice 2c — the in-thread Human-in-the-Loop review card. Rendered by
 *  `useHumanInTheLoop` for the bridge's unresolved `review_conclusion` tool call.
 *  While `respond` is a function (the agent is waiting) it shows Approve / Reject /
 *  Escalate; once answered it collapses to the recorded decision. The decision is
 *  the tool RESULT supplied back to the agent — a human gate, not a new answer. */
function HitlReviewCard({
  summary,
  confidence,
  respond,
  result,
  onResolved,
}: {
  summary?: string;
  confidence?: number;
  respond?: (result: unknown) => Promise<void>;
  result?: string;
  onResolved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // Local decision state. The grounded bridge ends the run when it emits this
  // (unresolved) tool call, so CopilotKit may hand us the call already `Complete`
  // (no `respond`) rather than paused in `Executing`. We therefore drive the gate
  // from our OWN state so the Approve/Reject/Escalate controls always work, and we
  // ALSO call CopilotKit's `respond()` when it IS provided (paused/Executing).
  const [localDecision, setLocalDecision] = useState<string | null>(null);
  const pct = typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : null;

  const decide = async (decision: "approved" | "rejected" | "escalated") => {
    if (busy || localDecision) return;
    setBusy(true);
    try {
      setLocalDecision(decision);
      if (respond) await respond(decision).catch(() => undefined);
      onResolved?.();
    } finally {
      setBusy(false);
    }
  };

  const resolved = localDecision ?? result ?? null;
  return (
    <div style={hitlBox} data-testid="hitl-review">
      <div style={hitlLabel}>⚖ human review · statistical conclusion</div>
      <div style={{ fontSize: 12.5, margin: "4px 0 2px" }}>
        {summary ?? "A probabilistic conclusion needs human sign-off."}
      </div>
      {pct ? (
        <div style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>
          model confidence {pct} · routed to a human because it is probabilistic, not deductive
        </div>
      ) : null}
      {resolved ? (
        <div style={{ ...hitlDecision, marginTop: 6 }}>Decision recorded: {resolved}</div>
      ) : (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button type="button" disabled={busy} onClick={() => decide("approved")} style={hitlBtn("rgba(46,160,67,0.18)")}>
            Approve
          </button>
          <button type="button" disabled={busy} onClick={() => decide("rejected")} style={hitlBtn("rgba(248,81,73,0.16)")}>
            Reject
          </button>
          <button type="button" disabled={busy} onClick={() => decide("escalated")} style={hitlBtn("rgba(210,153,34,0.18)")}>
            Escalate
          </button>
        </div>
      )}
    </div>
  );
}

const hitlBox: React.CSSProperties = {
  border: "1px solid var(--frame-border)",
  borderLeft: "3px solid rgba(210,153,34,0.9)",
  borderRadius: 6,
  padding: "8px 10px",
  margin: "6px 0",
  background: "rgba(210,153,34,0.07)",
};
const hitlLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--frame-text-muted)",
};
const hitlDecision: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--frame-text)",
};
const hitlBtn = (bg: string): React.CSSProperties => ({
  flex: 1,
  fontSize: 12,
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--frame-border)",
  background: bg,
  color: "var(--frame-text)",
  cursor: "pointer",
});

/** Renderer for the real read-only Cypher trace (show-your-work). */
function cypherRenderer(): ReactToolCallRenderer<{ query?: string; step?: string }> {
  return {
    name: "read_neo4j_cypher",
    args: z.object({ query: z.string().optional(), step: z.string().optional() }),
    render: ({ args, result }) => {
      if (args?.step) {
        return (
          <div style={traceBox}>
            <span style={traceLabel}>graph</span> {args.step}
          </div>
        );
      }
      return (
        <div style={traceBox}>
          <div style={traceLabel}>read-only Cypher</div>
          <pre style={tracePre}>{args?.query ?? "…"}</pre>
          {result ? <pre style={traceRows}>{String(result).slice(0, 400)}</pre> : null}
        </div>
      );
    },
  };
}

/** F3 — the adaptive-routing "why this strategy" trace. Shows the chosen strategy,
 *  the rationale, and the candidate seed ids (labelled candidates-to-verify, NOT
 *  citations). Purely informational; the answer's grounding is unchanged. */
function routeRenderer(): ReactToolCallRenderer<{
  strategy?: string;
  reason?: string;
  seedNodeIds?: string[];
}> {
  return {
    name: "route_strategy",
    args: z.object({
      strategy: z.string().optional(),
      reason: z.string().optional(),
      seedNodeIds: z.array(z.string()).optional(),
    }),
    render: ({ args }) => {
      const strategy = args?.strategy ?? "";
      if (!strategy) return <></>;
      const seeds = Array.isArray(args?.seedNodeIds) ? args!.seedNodeIds! : [];
      return (
        <div style={traceBox}>
          <span style={traceLabel}>route</span>{" "}
          <strong>{strategy}</strong>
          {args?.reason ? (
            <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--frame-text-muted)" }}>
              {args.reason}
            </div>
          ) : null}
          {seeds.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, color: "var(--frame-text-muted)" }}>
              candidates to verify:{" "}
              <span style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>
                {seeds.slice(0, 6).join(", ")}
              </span>
            </div>
          )}
        </div>
      );
    },
  };
}

/** Renderer for the grounded generative diagrams. Args carry the REAL cited ids;
 *  diagrams are derived from those + the live graph payload (passed in). */
function evidenceRenderer(
  graph: GraphPayload,
  opts?: { onFocusNode?: (n: GraphNode) => void; onOpenHitl?: () => void },
): ReactToolCallRenderer<{ citedNodeIds?: string[] }> {
  return {
    name: "render_evidence",
    args: z.object({ citedNodeIds: z.array(z.string()).optional() }),
    render: ({ args }) => {
      const ids = Array.isArray(args?.citedNodeIds) ? args!.citedNodeIds! : [];
      if (ids.length === 0) return <></>;
      const cited = resolveCited(ids, graph);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <GroundedDiagrams citedNodeIds={ids} graph={graph} onFocusNode={opts?.onFocusNode} />
          {cited.length > 0 && (
            <button
              type="button"
              onClick={() => void sendToReview(cited, opts?.onOpenHitl)}
              title="Route this grounded conclusion to the human-in-the-loop review queue"
              style={{
                alignSelf: "flex-start",
                fontSize: 12,
                fontWeight: 600,
                padding: "5px 12px",
                borderRadius: 6,
                cursor: "pointer",
                color: "var(--frame-text)",
                background: "rgba(88,166,255,.12)",
                border: "1px solid var(--frame-border)",
              }}
            >
              ⚖ Send → Review
            </button>
          )}
        </div>
      );
    },
  };
}

/** F1 — the per-answer faithfulness badge. Renders the confidence score + band
 *  from the bridge's `faithfulness` tool call. A visible "low-confidence" stamp
 *  shows when the verdict is gated; it NEVER hides or rewrites the answer. */
function faithfulnessRenderer(): ReactToolCallRenderer<{
  score?: number;
  band?: "high" | "medium" | "low";
  method?: string;
  gated?: boolean;
  unsupportedClaims?: string[];
}> {
  return {
    name: "faithfulness",
    args: z.object({
      score: z.number().optional(),
      band: z.enum(["high", "medium", "low"]).optional(),
      method: z.string().optional(),
      gated: z.boolean().optional(),
      unsupportedClaims: z.array(z.string()).optional(),
    }),
    render: ({ args }) => {
      if (!args || typeof args.score !== "number") return <></>;
      const band = args.band ?? "medium";
      const accent =
        band === "high"
          ? "rgba(46,160,67,0.9)"
          : band === "medium"
            ? "rgba(210,153,34,0.9)"
            : "rgba(248,81,73,0.9)";
      const pct = Math.round(args.score * 100);
      const dot = band === "high" ? "●" : band === "low" ? "▲" : "◆";
      return (
        <div style={{ ...faithBox, borderLeft: `3px solid ${accent}` }} data-testid="faithfulness-badge">
          <span style={{ color: accent, fontWeight: 700 }} aria-hidden>{dot}</span>
          <span style={{ fontWeight: 600 }}>Faithfulness {pct}%</span>
          <span style={{ color: "var(--frame-text-muted)", textTransform: "capitalize" }}>· {band}</span>
          {args.method === "judge" && (
            <span style={{ color: "var(--frame-text-muted)" }}>· judged</span>
          )}
          {args.gated && (
            <span
              title="Below the configured faithfulness threshold — review before relying on this answer."
              style={{
                marginLeft: "auto",
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.4,
                color: "rgba(248,81,73,0.95)",
                border: "1px solid rgba(248,81,73,0.5)",
                borderRadius: 999,
                padding: "1px 7px",
              }}
            >
              low confidence
            </span>
          )}
        </div>
      );
    },
  };
}

/** F4 — the in-answer hallucination flag. Renders ONLY when the bridge emitted a
 *  `hallucination_flag` tool call (≥1 claim not traceable to cited evidence). This
 *  surfaces a drifted claim INSIDE an answered response — distinct from the whole-
 *  question NOT_IN_GRAPH refusal. It annotates; it never edits the answer. */
function hallucinationRenderer(): ReactToolCallRenderer<{ unsupportedClaims?: string[] }> {
  return {
    name: "hallucination_flag",
    args: z.object({ unsupportedClaims: z.array(z.string()).optional() }),
    render: ({ args }) => {
      const claims = Array.isArray(args?.unsupportedClaims) ? args!.unsupportedClaims! : [];
      if (claims.length === 0) return <></>;
      return (
        <div style={halluBox} data-testid="hallucination-flag">
          <div style={hitlLabel}>⚠ unverified claim{claims.length > 1 ? "s" : ""} · not traced to cited evidence</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {claims.slice(0, 4).map((c, i) => (
              <li key={`${i}-${c.slice(0, 16)}`} style={{ marginBottom: 2 }}>{c}</li>
            ))}
          </ul>
          {claims.length > 4 && (
            <div style={{ fontSize: 11, color: "var(--frame-text-muted)", marginTop: 4 }}>
              +{claims.length - 4} more
            </div>
          )}
        </div>
      );
    },
  };
}

const faithBox: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  border: "1px solid var(--frame-border)",
  borderRadius: 6,
  padding: "5px 10px",
  margin: "4px 0",
  fontSize: 12,
  background: "rgba(88,166,255,0.05)",
};

const halluBox: React.CSSProperties = {
  border: "1px solid var(--frame-border)",
  borderLeft: "3px solid rgba(248,81,73,0.9)",
  borderRadius: 6,
  padding: "8px 10px",
  margin: "6px 0",
  background: "rgba(248,81,73,0.06)",
};

const traceBox: React.CSSProperties = {
  border: "1px solid var(--frame-border)",
  borderRadius: 6,
  padding: "6px 8px",
  margin: "4px 0",
  fontSize: 12,
  background: "rgba(88,166,255,0.06)",
};
const traceLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  color: "var(--frame-text-muted)",
  letterSpacing: 0.4,
};
const tracePre: React.CSSProperties = {
  margin: "4px 0 0",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontSize: 11.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};
const traceRows: React.CSSProperties = {
  ...tracePre,
  marginTop: 6,
  color: "var(--frame-text-muted)",
  borderTop: "1px dashed var(--frame-border)",
  paddingTop: 4,
};
