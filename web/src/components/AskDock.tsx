/**
 * AskDock — a floating, minimizable "Ask the graph" widget docked bottom-right.
 *
 * Collapsed, it's an unobtrusive pill (a FAB) with a live teal dot. Click it and
 * it expands into a compact docked chat panel; minimize collapses it back to the
 * pill WITHOUT losing the conversation (the provider stays mounted, the panel is
 * just hidden), and "open full" hands off to Beat 4's full conversation surface.
 *
 * It reuses the EXACT SAME grounded path as Beat 4 — its own `CopilotKitProvider`
 * pointed at the untouched grounded Copilot Runtime (`/api/copilotkit` → AG-UI
 * bridge → read-only `/ask` agent). NO second LLM, NO new answer path: grounding
 * stays server-side, an off-graph question still returns `NOT_IN_GRAPH:` and draws
 * nothing. This is purely a second *view* onto the grounded agent, not a new one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CopilotKitProvider,
  CopilotChat,
  useAgent,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import type { GraphNode } from "@rnd/shared";
import { NodeContextBar } from "./NodeContextBar.js";
import { threadsApi } from "../api.js";
import type { ThreadMessage } from "../api.js";
import { LAST_THREAD_KEY, dedupeById } from "../lib/thread.js";

interface Props {
  /** Hand off to the full Beat 4 conversation surface ("open full"). */
  onOpenFull?: () => void;
  /** Nodes clicked on the canvas — accumulate into the dock conversation's
   *  context (a removable chip each + grounded question pills). */
  contextNodes?: GraphNode[];
  /** Remove a single node from the context set (× on its chip). */
  onRemoveContext?: (id: string) => void;
  /** Clear the entire node context set ("Clear all"). */
  onClearContext?: () => void;
}

const reduceMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** Inject the dock's keyframes/transitions once (scoped by the `.askdock-*`
 *  class names). Kept here so AskDock is a drop-in with no shared-CSS edits;
 *  reduced-motion zeroes the entrance + the pill's ambient pulse. */
const DOCK_STYLE_ID = "askdock-style";
function ensureDockStyle() {
  if (typeof document === "undefined" || document.getElementById(DOCK_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = DOCK_STYLE_ID;
  el.textContent = `
    @keyframes askdock-in {
      from { opacity: 0; transform: translateY(10px) scale(.97); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }
    @keyframes askdock-halo {
      0%,100% { box-shadow: 0 0 0 0 rgba(45,212,191,.40); }
      50%     { box-shadow: 0 0 0 6px rgba(45,212,191,0); }
    }
    .askdock-panel { animation: askdock-in .26s cubic-bezier(.16,1,.3,1); transform-origin: bottom right; }
    .askdock-fab   { transition: transform .18s cubic-bezier(.16,1,.3,1), box-shadow .18s ease; }
    .askdock-fab:hover { transform: translateY(-2px); }
    .askdock-dot   { animation: askdock-halo 2.6s ease-in-out infinite; }
    @media (prefers-reduced-motion: reduce) {
      .askdock-panel { animation: none; }
      .askdock-fab:hover { transform: none; }
      .askdock-dot { animation: none; }
    }
  `;
  document.head.appendChild(el);
}

export function AskDock({ onOpenFull, contextNodes, onRemoveContext, onClearContext }: Props) {
  // `open` = panel expanded. `mounted` latches true on first open so the provider
  // (and thus the conversation) survives minimize — we hide the panel with CSS
  // rather than unmounting it. Reduced-motion users still get instant open/close.
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    ensureDockStyle();
  }, []);

  function expand() {
    setMounted(true);
    setOpen(true);
  }

  // Selecting nodes on the canvas should SURFACE that context here — auto-open the
  // dock when the context set becomes non-empty so the chips + question pills are
  // immediately visible. We open on the empty→non-empty transition (not on every
  // add) so a user who minimized the dock mid-selection isn't fought with.
  const hadContext = useRef(false);
  const hasContext = (contextNodes?.length ?? 0) > 0;
  useEffect(() => {
    if (hasContext && !hadContext.current) {
      setMounted(true);
      setOpen(true);
    }
    hadContext.current = hasContext;
  }, [hasContext]);

  return (
    <div
      style={{
        position: "fixed",
        right: 18,
        bottom: 18,
        zIndex: 60,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 10,
        // The provenance drawer (width 340, slides from the right) sits at the same
        // edge; nudge the dock clear of it when a node is inspected is handled by
        // the drawer's own higher stacking — the dock stays usable beside the chat.
      }}
    >
      {/* The chat panel — kept mounted once opened (conversation continuity); the
          collapsed state just hides it so re-expanding resumes the same thread. */}
      {mounted && (
        <div
          className="askdock-panel"
          role="dialog"
          aria-label="Ask the graph"
          aria-hidden={!open}
          style={{
            display: open ? "flex" : "none",
            flexDirection: "column",
            width: 384,
            height: 564,
            maxHeight: "calc(100vh - 96px)",
            background: "var(--frame-surface)",
            color: "var(--frame-text)",
            border: "1px solid var(--frame-border)",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 18px 48px rgba(8,16,34,.42), 0 2px 8px rgba(8,16,34,.30)",
          }}
        >
          <DockHeader onMinimize={() => setOpen(false)} onOpenFull={onOpenFull} />
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <DockChat
              contextNodes={contextNodes ?? []}
              onRemoveContext={onRemoveContext}
              onClearContext={onClearContext}
            />
          </div>
        </div>
      )}

      {/* The collapsed FAB — a refined pill, always in the corner. Hidden while the
          panel is open so there's never a dangling launcher under the dialog. */}
      {!open && (
        <button
          type="button"
          className="askdock-fab"
          onClick={expand}
          title="Ask the graph — grounded, read-only, refuses off-graph"
          aria-label="Open Ask the graph"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 16px 11px 13px",
            borderRadius: 999,
            border: "1px solid var(--frame-border)",
            cursor: "pointer",
            color: "#eaf2ff",
            fontSize: 13.5,
            fontWeight: 600,
            letterSpacing: 0.2,
            background:
              "linear-gradient(135deg, #143058 0%, #102a4d 55%, #0e6a63 140%)",
            boxShadow: "0 10px 28px rgba(8,16,34,.40), inset 0 1px 0 rgba(255,255,255,.06)",
          }}
        >
          <span
            className="askdock-dot"
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: "50%",
              background: "#2dd4bf",
              display: "inline-block",
              flex: "0 0 auto",
            }}
          />
          <span aria-hidden style={{ fontSize: 14, lineHeight: 1 }}>✦</span>
          Ask the graph
        </button>
      )}
    </div>
  );
}

/** The dock's title bar: identity + grounded badge + minimize / open-full. */
function DockHeader({
  onMinimize,
  onOpenFull,
}: {
  onMinimize: () => void;
  onOpenFull?: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 10px 10px 13px",
        borderBottom: "1px solid var(--frame-border)",
        background:
          "linear-gradient(180deg, rgba(45,212,191,.10), rgba(45,212,191,0) 70%)",
      }}
    >
      <span aria-hidden style={{ fontSize: 14, color: "#2dd4bf" }}>✦</span>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15, flex: 1, minWidth: 0 }}>
        <strong style={{ fontSize: 13.5 }}>Ask the graph</strong>
        <span
          title="Answers come only from read-only Cypher over the live graph; off-graph questions are refused."
          style={{ fontSize: 10.5, color: "var(--frame-text-muted)" }}
        >
          ✓ grounded · read-only · refuses off-graph
        </span>
      </div>
      {onOpenFull && (
        <button
          type="button"
          onClick={onOpenFull}
          title="Open the full conversation surface (Beat 4)"
          aria-label="Open full conversation"
          style={dockIconBtn}
        >
          ⤢
        </button>
      )}
      <button
        type="button"
        onClick={onMinimize}
        title="Minimize"
        aria-label="Minimize Ask the graph"
        style={dockIconBtn}
      >
        —
      </button>
    </div>
  );
}

/** The grounded chat itself — own provider on the SAME runtime as Beat 4, plus a
 *  curated, grounding-safe suggestion set (clicking one sends a normal user turn
 *  through the same grounded bridge). No second LLM; identical answer path. */
/** Hand-curated starter prompts. Rendered as our OWN static pills (below) — NOT
 *  via CopilotKit's `useConfigureSuggestions`, whose auto-reload loop runs the
 *  grounded agent (~500k-token context) repeatedly on `onAgentsChanged`, silently
 *  burning budget. Static buttons that submit a normal user turn carry the same
 *  demo value with zero idle cost. */
const STARTERS: { title: string; message: string }[] = [
  { title: "Safety signal", message: "What is the safety signal for the checkpoint inhibitor?" },
  { title: "Mechanism", message: "How does the checkpoint inhibitor cause myocarditis?" },
  { title: "Evidence", message: "What evidence supports the myocarditis signal?" },
  { title: "What's missing?", message: "What is known, what is missing, and what is conflicting for the myocarditis signal?" },
];

function DockChat({
  contextNodes,
  onRemoveContext,
  onClearContext,
}: {
  contextNodes: GraphNode[];
  onRemoveContext?: (id: string) => void;
  onClearContext?: () => void;
}) {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit">
      {/* Selected nodes take over the suggestion strip (a chip each + grounded
          pills); otherwise the static starters show — never both, so the rows
          never duplicate (mirrors Beat 4). */}
      {contextNodes.length > 0 ? (
        <DockMultiContext
          nodes={contextNodes}
          onRemove={(id) => onRemoveContext?.(id)}
          onClearAll={() => onClearContext?.()}
        />
      ) : (
        <DockStarters />
      )}
      <DockChatSurface />
    </CopilotKitProvider>
  );
}

/** The chat itself, bound to the SHARED persistent thread. Lives inside the
 *  provider so `useDockThread` (→ `useAgent`) resolves. Binding `threadId` +
 *  persisting on each finalized turn is what makes the dock conversation survive
 *  minimize/reload AND carry into Beat 4 (which restores the same `LAST_THREAD_KEY`
 *  thread on mount). `threadId` is null only on the very first paint — same
 *  CopilotChat fallback Beat 4 uses. */
function DockChatSurface() {
  const { agent } = useAgent();
  const { threadId, chatKey } = useDockThread(agent);
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {threadId ? (
        <CopilotChat key={chatKey} threadId={threadId} />
      ) : (
        <CopilotChat key={chatKey} />
      )}
    </div>
  );
}

/** Bind the dock to ONE persistent conversation, reusing Beat 4's exact thread
 *  machinery (the shared `LAST_THREAD_KEY` + `threadsApi` + history-only BFF
 *  store). On mount it restores the last-open thread (or creates one); after each
 *  finalized run it snapshots messages + grounding back to the store. The two
 *  surfaces are never visible at once (the dock is hidden on the conversation
 *  beat), so this single shared key is race-free. Best-effort throughout: a store
 *  outage degrades to an ephemeral in-memory chat, never a broken one. */
function useDockThread(agent: ReturnType<typeof useAgent>["agent"]) {
  const [threadId, setThreadId] = useState<string | null>(null);
  // Bump to (re)bind CopilotChat once the thread id is known/loaded.
  const [chatKey, setChatKey] = useState(0);
  // Keep the live id for the finalize subscription without re-subscribing.
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = threadId;

  /** Snapshot the current thread (messages + grounding) to the BFF. Grounding is
   *  read from the agent's live state (the bridge's STATE_SNAPSHOT) so a restore
   *  in Beat 4 brings the citations back. Mirrors Beat 4's `persist`. */
  const persist = useCallback(
    async (id: string) => {
      if (!agent || !id) return;
      const messages = dedupeById((agent.messages ?? []) as unknown as ThreadMessage[]);
      // Skip blank threads — nothing to save until the user has actually asked
      // something (mirrors Beat 4's guard; stops empty "Conversation …" rows).
      const hasUserTurn = messages.some(
        (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
      );
      if (!hasUserTurn) return;
      const live = (agent.state ?? {}) as { citedNodeIds?: unknown; isFallback?: unknown };
      const citedNodeIds = Array.isArray(live.citedNodeIds) ? live.citedNodeIds.map(String) : [];
      const isFallback = typeof live.isFallback === "boolean" ? live.isFallback : false;
      try {
        await threadsApi.save(id, { messages, grounding: { citedNodeIds, isFallback } });
      } catch {
        /* persistence is best-effort; never break the live chat on a save error */
      }
    },
    [agent],
  );

  // On agent ready: bind to the shared last-open thread (restore it) or create one.
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    (async () => {
      let id = (() => {
        try {
          return localStorage.getItem(LAST_THREAD_KEY);
        } catch {
          return null;
        }
      })();
      try {
        const list = await threadsApi.list();
        if (cancelled) return;
        if (id && list.some((t) => t.threadId === id)) {
          // Restore the conversation INTO the agent so the prebuilt chat redraws it.
          const rec = await threadsApi.get(id);
          if (cancelled) return;
          agent.setMessages(dedupeById((rec.messages ?? []) as ThreadMessage[]) as never);
          agent.threadId = id;
          const g = rec.grounding ?? { citedNodeIds: [], isFallback: false };
          try {
            agent.setState({ ...(agent.state ?? {}), ...g });
          } catch {
            /* setState may reject unknown shapes on some builds — harmless here */
          }
        } else {
          // No (valid) prior thread → start a fresh one LAZILY: mint a client-side
          // id but do NOT write a blank row to the store. The thread is persisted
          // only once a turn finalizes (same lazy policy as CopilotChatBeat), so
          // merely mounting the dock never accumulates empty "Conversation …" rows.
          id = crypto.randomUUID();
          agent.setMessages([] as never);
          agent.threadId = id;
        }
      } catch {
        // Store unreachable → fall back to the agent's own ephemeral id (no persist).
        id = id ?? agent.threadId ?? null;
      }
      if (cancelled || !id) return;
      try {
        localStorage.setItem(LAST_THREAD_KEY, id);
      } catch {
        /* private mode / no storage — the hand-off just won't survive a reload */
      }
      setThreadId(id);
      setChatKey((k) => k + 1); // remount CopilotChat bound to this thread
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  // Persist after each finalized run; keep LAST_THREAD_KEY pinned so Beat 4's
  // mount-restore picks up exactly this conversation on "open full" / navigation.
  useEffect(() => {
    if (!agent) return;
    const sub = agent.subscribe({
      onRunFinalized: () => {
        const id = threadIdRef.current ?? agent.threadId;
        if (!id) return;
        try {
          localStorage.setItem(LAST_THREAD_KEY, id);
        } catch {
          /* best-effort */
        }
        void persist(id);
      },
    });
    return () => sub.unsubscribe();
  }, [agent, persist]);

  return { threadId, chatKey };
}

/** The node-context bar inside the dock — must live INSIDE the provider so it can
 *  submit grounded turns through the SAME agent the composer uses (no new path). */
function DockMultiContext({
  nodes,
  onRemove,
  onClearAll,
}: {
  nodes: GraphNode[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
}) {
  const { agent } = useAgent();
  const ask = (message: string) => {
    if (!agent) return;
    try {
      agent.addMessage?.({ id: `u_${message.length}_${message.slice(0, 10)}`, role: "user", content: message } as never);
      void agent.runAgent?.();
    } catch {
      /* fall back to the composer */
    }
  };
  return <NodeContextBar nodes={nodes} onRemove={onRemove} onClearAll={onClearAll} onAsk={ask} />;
}

/** Static starter pills shown before the first turn. Clicking one submits a
 *  normal grounded turn through the agent (the SAME path the composer uses) —
 *  no CopilotKit suggestion machinery, so nothing fires while the dock sits idle. */
function DockStarters() {
  const { agent } = useAgent();
  const [sent, setSent] = useState(false);
  if (sent || !agent || (agent.messages?.length ?? 0) > 0) return null;

  const ask = (message: string) => {
    setSent(true);
    try {
      // AG-UI client: append the user turn and run the (grounded) agent once.
      agent.addMessage?.({ id: `u_${message.length}_${message.slice(0, 8)}`, role: "user", content: message } as never);
      void agent.runAgent?.();
    } catch {
      setSent(false); // let the user fall back to the composer
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 10px 0" }}>
      {STARTERS.map((s) => (
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
            background: "rgba(45,212,191,.08)",
            color: "var(--frame-text)",
            cursor: "pointer",
          }}
        >
          {s.title}
        </button>
      ))}
    </div>
  );
}

const dockIconBtn: React.CSSProperties = {
  border: "1px solid var(--frame-border)",
  background: "rgba(255,255,255,.04)",
  color: "var(--frame-text)",
  cursor: "pointer",
  width: 28,
  height: 28,
  borderRadius: 8,
  fontSize: 14,
  lineHeight: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
};
