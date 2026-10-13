/**
 * @rnd/dashboards — Dashboard Studio split-view.
 *
 * Left pane: the existing `CopilotChatBeat` in `dashboardTarget="pane"` mode (grounded
 * chat; boards it composes go to the "studio" lineage instead of rendering inline).
 * Right pane: a persistent `DashboardCanvas` subscribed to that lineage, so it paints
 * (and grows, F7-style) as boards stream in from the chat on the left.
 *
 * Trust sidecar: certified badges (F8) and the audit record ride alongside the spec
 * via `setSurfaceTrust` (populated by the chip-mode `dashboardRenderer` branch) so
 * this surface stays first-class — badges + Save (F10) work here too.
 */
import { useEffect, useState } from "react";
import type { GraphPayload, GraphNode, GraphEdge, DashboardSpec, DashboardAudit } from "@rnd/shared";
import { CopilotChatBeat } from "../beats/CopilotChatBeat.js";
import { DashboardCanvas } from "./DashboardCanvas.js";
import { dashboardsApi } from "../api.js";
import { subscribe, currentSpec, currentTrust, rehydrate, scheduleStudioReset, cancelScheduledStudioReset } from "./lineageStore.js";

interface Props {
  graph: GraphPayload;
  lightCanvas?: boolean;
  onNodeClick: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge) => void;
  onOpenHitl?: () => void;
  refreshKey?: number;
}

/** Display-only prompt hints (the real submit happens through CopilotChatBeat's own
 *  dashboard starters / launcher in the left pane). */
const STARTERS = [
  "Build a live dashboard for the checkpoint-inhibitor myocarditis safety signal — disproportionality, mechanism, and supporting evidence.",
  "Compose a dashboard of the evidence and provenance behind the myocarditis signal.",
  "Dashboard: what is known, missing, and conflicting for the myocarditis signal, with the relational subgraph.",
];

export function DashboardStudio({ graph, lightCanvas, onNodeClick, onEdgeClick, onOpenHitl, refreshKey }: Props) {
  const [spec, setSpec] = useState<DashboardSpec | null>(() => currentSpec("studio"));
  const [trust, setTrust] = useState<{ certified: string[]; audit: DashboardAudit | null }>(() => currentTrust("studio"));
  // Pop the board canvas out of the split view into a full-viewport overlay
  // (mirrors GraphCanvas / GenerativeStudio fullscreen: fixed inset:0 + Esc).
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    if (!isFull) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setIsFull(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFull]);

  // A reloaded tab restores its working board (sessionStorage); leaving the beat via
  // SPA navigation (real unmount) clears it — Save is the durable path. StrictMode-safe:
  // dev's mount→cleanup→remount cycle must NOT wipe the rehydrated board, so cleanup
  // only SCHEDULES the clear and the immediate remount cancels it.
  useEffect(() => {
    cancelScheduledStudioReset(); // StrictMode remount: rescue the board before the deferred clear fires
    rehydrate("studio");
    setSpec(currentSpec("studio"));
    setTrust(currentTrust("studio"));
    const off = subscribe("studio", () => {
      setSpec(currentSpec("studio"));
      setTrust(currentTrust("studio"));
    });
    return () => {
      off();
      scheduleStudioReset(); // real beat-leave clears on the next tick
    };
  }, []);

  const onSave = async (s: DashboardSpec, a: DashboardAudit | null) => {
    await dashboardsApi.save({ title: s.title, spec: s, audit: a ?? undefined });
  };

  return (
    <div style={{ display: "flex", gap: 14, height: "100%", minHeight: 0 }}>
      <div style={{ flex: "0 0 38%", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <CopilotChatBeat
          graph={graph}
          lightCanvas={lightCanvas}
          dashboardTarget="pane"
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onOpenHitl={onOpenHitl}
          refreshKey={refreshKey}
        />
      </div>
      <div
        style={
          isFull
            ? { position: "fixed", inset: 0, zIndex: 1000, overflowY: "auto", padding: 16, background: "var(--frame-surface)" }
            : { flex: 1, minWidth: 0, overflowY: "auto", border: "1px solid var(--frame-border)", borderRadius: "var(--radius)", padding: 12, background: "var(--frame-surface)", position: "relative" }
        }
      >
        <button
          type="button"
          onClick={() => setIsFull((v) => !v)}
          aria-pressed={isFull}
          title={isFull ? "Exit full screen (Esc)" : "Pop the board canvas to full screen"}
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            zIndex: 2,
            fontSize: 11,
            padding: "3px 8px",
            borderRadius: 6,
            border: "1px solid var(--frame-border)",
            background: isFull ? "rgba(88,166,255,.16)" : "var(--frame-surface)",
            color: "var(--frame-text)",
            cursor: "pointer",
          }}
        >
          {isFull ? "⤧ Exit" : "⤢ Full screen"}
        </button>
        {spec ? (
          <DashboardCanvas
            spec={spec}
            graph={graph}
            certified={trust.certified}
            audit={trust.audit}
            onFocusNode={onNodeClick}
            onSave={onSave}
          />
        ) : (
          <div style={{ color: "var(--frame-text-muted)", fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>✨ Ask to compose your first board.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {STARTERS.map((s) => (
                <div key={s} style={{ fontSize: 12, opacity: 0.8 }}>· {s}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
