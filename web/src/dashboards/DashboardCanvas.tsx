/**
 * @rnd/dashboards — DashboardCanvas.
 *
 * Renders a validated, grounded DashboardSpec by walking its widget list through
 * the trusted registry. Layout is a simple 2-column grid honouring each widget's
 * `span`. Widgets reveal progressively with a staggered entry animation (masking
 * the composer's latency) — gated by the in-app MotionContext (`useMotion`), never
 * the OS reduce-motion query, per the app's Win11-Enterprise lesson.
 *
 * Grounding: cited nodes are resolved against the live graph payload (unknown ids
 * dropped, never fabricated) — the same intersection GroundedDiagrams performs.
 *
 * Phase 2 interaction & trust:
 *  - F5 cross-filter: clicking a citation chip brushes that node; every widget
 *    narrows to the brushed set. A bar shows the active brush with a Clear.
 *  - F6 drill-down: each widget carries an "Explain" action that submits a grounded
 *    follow-up (via `onAsk`) about that tile's cited nodes — a normal graph-answered
 *    turn, no new answer path.
 *  - F7 patch pulse: widgets named in `changedIds` (added/updated by a follow-up
 *    turn's merge) pulse once so the user sees what the agent patched.
 *  - F8 certified badges: widgets whose id is in `certified` (computed by trusted
 *    BFF code, never the spec) show a ✓ badge; the header shows the audit summary.
 */
import { useMemo, useState } from "react";
import type {
  DashboardAudit,
  DashboardSpec,
  DashboardWidget,
  FaithfulnessResult,
  GraphNode,
  GraphPayload,
} from "@rnd/shared";
import { resolveCited } from "../lib/evidence.js";
import { useMotion } from "../lib/motion.js";
import { renderWidget, type WidgetContext } from "./registry.js";

export interface DashboardCanvasProps {
  spec: DashboardSpec;
  graph: GraphPayload;
  faithfulness?: FaithfulnessResult | null;
  onFocusNode?: (n: GraphNode) => void;
  /** F6 — submit a grounded follow-up turn (answered from the live graph). */
  onAsk?: (question: string) => void;
  /** F8 — widget ids the BFF certified against the verified-query registry. */
  certified?: string[];
  /** F8 — the certified-tile audit record (model, live proof, faithfulness). */
  audit?: DashboardAudit | null;
  /** F7 — widget ids added/updated by the latest follow-up merge (pulse once). */
  changedIds?: string[];
  /** F10 — publish this board. When provided, a "Save" affordance appears; the
   *  handler receives the (inert) spec + trusted audit currently on screen. */
  onSave?: (spec: DashboardSpec, audit: DashboardAudit | null) => Promise<void> | void;
}

/** Keyframes for the staggered reveal + the follow-up patch pulse. Injected once. */
const REVEAL_STYLE = `@keyframes rnd-dash-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes rnd-dash-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(23,105,214,0.55); }
  70%  { box-shadow: 0 0 0 6px rgba(23,105,214,0); }
  100% { box-shadow: 0 0 0 0 rgba(23,105,214,0); }
}`;

/** A short human label per widget kind — used in the Explain follow-up + titles. */
const KIND_LABEL: Record<DashboardWidget["kind"], string> = {
  "citation-chips": "cited evidence",
  "coverage-header": "coverage and conflicts",
  "evidence-ledger": "evidence ledger",
  "evidence-subgraph": "relational subgraph",
  "stat-chart": "disproportionality metrics",
  "hero-flow": "mechanism chain",
  metric: "metric",
};

export function DashboardCanvas({
  spec,
  graph,
  faithfulness,
  onFocusNode,
  onAsk,
  certified,
  audit,
  changedIds,
  onSave,
}: DashboardCanvasProps) {
  const motion = useMotion();
  const cited = useMemo(() => resolveCited(spec.citedNodeIds, graph), [spec.citedNodeIds, graph]);

  // F5 — the cross-filter brush (ids of the currently-brushed cited nodes).
  const [focusIds, setFocusIds] = useState<string[]>([]);
  // F10 — publish state: idle → saving → saved (so the button reads back its result).
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const toggleFocus = (id: string) =>
    setFocusIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const certifiedSet = useMemo(() => new Set(certified ?? []), [certified]);
  const changedSet = useMemo(() => new Set(changedIds ?? []), [changedIds]);

  const ctx: WidgetContext = { cited, graph, faithfulness, onFocusNode, focusIds, onToggleFocus: toggleFocus };

  // Nothing grounded to show — draw nothing (a refusal/fallback never reaches here,
  // but be defensive).
  if (cited.length === 0) return null;

  // Labels of the brushed nodes for the filter bar.
  const brushedLabels = cited.filter((n) => focusIds.includes(n.id)).map((n) => n.label);

  return (
    <div
      data-testid="dashboard-canvas"
      style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}
    >
      <style>{REVEAL_STYLE}</style>

      {/* Header: title + intent + how it was composed + audit summary. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--frame-text)" }}>{spec.title}</span>
        <span
          title={
            spec.source === "llm"
              ? "Composed by the model from your answer's cited evidence"
              : "Deterministic template (composer unavailable) — fully grounded"
          }
          style={{
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            padding: "1px 7px",
            borderRadius: 999,
            border: "1px solid var(--frame-border)",
            color: "var(--frame-text-muted)",
          }}
        >
          {spec.source === "llm" ? "AI-composed" : "Template"}
        </span>
        <span style={{ fontSize: 11, color: "var(--frame-text-muted)", marginLeft: "auto" }}>
          grounded · {cited.length} cited node(s)
        </span>
        {onSave && (
          <button
            type="button"
            data-testid="dashboard-save"
            disabled={saveState !== "idle"}
            onClick={async () => {
              setSaveState("saving");
              try {
                await onSave(spec, audit ?? null);
                setSaveState("saved");
              } catch {
                setSaveState("idle");
              }
            }}
            title="Save this board to your dashboards (publish — no graph write)"
            style={{
              fontSize: 10,
              cursor: saveState === "idle" ? "pointer" : "default",
              background: "transparent",
              border: "1px solid var(--frame-border)",
              borderRadius: 6,
              padding: "1px 8px",
              color: saveState === "saved" ? "rgba(46,160,67,0.95)" : "var(--frame-text-muted)",
            }}
          >
            {saveState === "saved" ? "✓ Saved" : saveState === "saving" ? "Saving…" : "💾 Save"}
          </button>
        )}
      </div>
      {spec.intent && (
        <div style={{ fontSize: 11, color: "var(--frame-text-muted)", marginTop: -4 }}>{spec.intent}</div>
      )}

      {/* F8 — audit summary line, shown when at least one tile is certified. */}
      {audit && audit.certifiedCount > 0 && (
        <div
          data-testid="dashboard-audit"
          title={
            `${audit.certifiedCount} tile(s) match a curated verified query` +
            (audit.verifiedQueryIds.length ? `: ${audit.verifiedQueryIds.join(", ")}` : "") +
            (audit.model ? ` · model ${audit.model}` : "") +
            (audit.estimated === false ? " · live call (real token usage)" : "")
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--frame-text-muted)",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--frame-border)",
            background: "var(--frame-surface, rgba(255,255,255,0.02))",
          }}
        >
          <span style={{ color: "rgba(46,160,67,0.95)", fontWeight: 700 }}>✓ {audit.certifiedCount} certified</span>
          {typeof audit.faithfulnessScore === "number" && (
            <span>faithfulness {Math.round(audit.faithfulnessScore * 100)}%</span>
          )}
          {audit.estimated === false && <span>· live model call</span>}
          {audit.model && <span style={{ marginLeft: "auto" }}>{audit.model}</span>}
        </div>
      )}

      {/* F5 — active cross-filter brush + Clear. */}
      {focusIds.length > 0 && (
        <div
          data-testid="dashboard-filter-bar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 11,
            color: "var(--frame-text)",
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid var(--clinical-blue, #1769d6)",
            background: "rgba(23,105,214,0.08)",
          }}
        >
          <span>
            Filtered to {focusIds.length} node(s): {brushedLabels.slice(0, 3).join(", ")}
            {brushedLabels.length > 3 ? "…" : ""}
          </span>
          <button
            type="button"
            onClick={() => setFocusIds([])}
            style={{
              marginLeft: "auto",
              fontSize: 11,
              cursor: "pointer",
              background: "transparent",
              border: "1px solid var(--frame-border)",
              borderRadius: 6,
              padding: "1px 8px",
              color: "var(--frame-text)",
            }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Screen-reader announce: tiles paint progressively during streaming. */}
      <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {spec.widgets.length} tile{spec.widgets.length === 1 ? "" : "s"} composed
      </div>

      {/* Widget grid — 2 columns, honouring each widget's span. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 10,
          alignItems: "start",
        }}
      >
        {spec.widgets.map((widget, i) => {
          const el = renderWidget(widget, ctx);
          if (el == null) return null;
          // Default span: a metric tile is half-width; every other widget is full.
          const span = widget.span ?? (widget.kind === "metric" ? 1 : 2);
          const isCertified = certifiedSet.has(widget.id);
          const isChanged = changedSet.has(widget.id);
          return (
            <div
              key={widget.id}
              style={{
                gridColumn: span === 2 ? "1 / -1" : "span 1",
                borderRadius: 8,
                // Staggered reveal — only when in-app motion is on. A patched widget
                // (F7) pulses once instead of re-revealing.
                animation: motion
                  ? isChanged
                    ? "rnd-dash-pulse 1200ms ease-out 1"
                    : "rnd-dash-in 320ms ease both"
                  : undefined,
                animationDelay: motion && !isChanged ? `${i * 60}ms` : undefined,
              }}
            >
              {/* Widget header: title (non-metric) + certified badge + Explain. */}
              {(widget.kind !== "metric" || isCertified) && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 4,
                    minHeight: 16,
                  }}
                >
                  {widget.title && widget.kind !== "metric" && (
                    <span
                      style={{
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        color: "var(--frame-text-muted)",
                      }}
                    >
                      {widget.title}
                    </span>
                  )}
                  {isCertified && (
                    <span
                      data-testid="dashboard-certified"
                      title="Certified: this tile's query matches a curated, validated pattern"
                      style={{
                        fontSize: 9,
                        textTransform: "uppercase",
                        letterSpacing: 0.4,
                        padding: "0 6px",
                        borderRadius: 999,
                        border: "1px solid rgba(46,160,67,0.5)",
                        color: "rgba(46,160,67,0.95)",
                        fontWeight: 700,
                      }}
                    >
                      ✓ Certified
                    </span>
                  )}
                  {onAsk && (
                    <button
                      type="button"
                      onClick={() => onAsk(explainQuestion(widget, ctx))}
                      title="Explain this tile — answered from the live graph"
                      style={{
                        marginLeft: "auto",
                        fontSize: 10,
                        cursor: "pointer",
                        background: "transparent",
                        border: "1px solid var(--frame-border)",
                        borderRadius: 6,
                        padding: "0 7px",
                        color: "var(--frame-text-muted)",
                      }}
                    >
                      ⤷ Explain
                    </button>
                  )}
                </div>
              )}
              {el}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Build a grounded drill-down question for a tile, naming its cited nodes. The
 *  answer comes from the live graph (a normal turn) — this only phrases the ask. */
function explainQuestion(widget: DashboardWidget, ctx: WidgetContext): string {
  const scope = widget.nodeIds && widget.nodeIds.length ? new Set(widget.nodeIds) : null;
  const labels = ctx.cited
    .filter((n) => (scope ? scope.has(n.id) : true))
    .slice(0, 3)
    .map((n) => n.label);
  const subject = widget.title || KIND_LABEL[widget.kind];
  const over = labels.length ? ` for ${labels.join(", ")}` : "";
  return `Explain the ${subject}${over}. Answer only from the live graph and cite the evidence.`;
}
