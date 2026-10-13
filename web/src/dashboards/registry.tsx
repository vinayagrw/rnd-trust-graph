/**
 * @rnd/dashboards — the TRUSTED widget registry.
 *
 * Maps each `DashboardWidget.kind` to an existing grounded render primitive
 * (GroundedDiagrams / recharts / Mermaid-strict). This is the only place a spec
 * turns into pixels, and it renders STRICTLY from the live graph payload + the
 * answer's cited nodes — never from anything in the spec except the widget kind, an
 * escaped title, and a subset of cited ids. The spec cannot carry a value, so no
 * value can be rendered from it.
 */
import type { ReactNode } from "react";
import type { DashboardWidget, FaithfulnessResult, GraphNode, GraphPayload } from "@rnd/shared";
import {
  CitationChips,
  CoverageConflictHeader,
  EvidenceLedger,
  EvidenceSubgraph,
  HeroFlow,
  StatChart,
} from "../components/GroundedDiagrams.js";
import { classifyCited, coverage } from "../lib/evidence.js";

/** Everything a widget needs to render, derived once per dashboard. */
export interface WidgetContext {
  /** The resolved cited nodes for the whole dashboard (⊆ live graph). */
  cited: GraphNode[];
  /** The live graph payload (source of all edges/values). */
  graph: GraphPayload;
  /** The answer's faithfulness verdict, when present (drives the metric tile). */
  faithfulness?: FaithfulnessResult | null;
  onFocusNode?: (n: GraphNode) => void;
  /** Feature 5 — cross-filter / linked brushing. The brushed cited-node ids; when
   *  non-empty EVERY widget (except the brush control) narrows to this set. */
  focusIds?: string[];
  /** Toggle a node in/out of the cross-filter brush (wired to citation chips). */
  onToggleFocus?: (id: string) => void;
}

/** Read a numeric node attribute (e.g. PRR/ROR on a SignalStat), or null. */
function num(n: GraphNode, key: string): number | null {
  const v = n.attrs?.[key];
  const parsed = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Narrow the dashboard's cited nodes to a widget's `nodeIds` (omit = all cited),
 *  then apply the cross-filter brush (Feature 5) unless the widget is the brush
 *  control itself (citation-chips must always show every chip so the brush can be
 *  toggled off again). An active brush with no overlap yields [] → the widget draws
 *  nothing, the "draw nothing rather than fabricate" discipline. */
function subset(widget: DashboardWidget, ctx: WidgetContext): GraphNode[] {
  let out = ctx.cited;
  if (widget.nodeIds && widget.nodeIds.length > 0) {
    const want = new Set(widget.nodeIds);
    out = out.filter((n) => want.has(n.id));
  }
  const brush = ctx.focusIds;
  if (brush && brush.length > 0 && widget.kind !== "citation-chips") {
    const focus = new Set(brush);
    out = out.filter((n) => focus.has(n.id));
  }
  return out;
}

/** Edges of the live graph that connect two nodes in `nodes` — the real wiring. */
function edgesWithin(nodes: GraphNode[], graph: GraphPayload): GraphPayload["edges"] {
  const ids = new Set(nodes.map((n) => n.id));
  return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
}

/** Render one widget. Returns null when the widget has no data to show (e.g. a
 *  stat-chart with no SignalStat metrics) — the same "draw nothing rather than
 *  fabricate" discipline GroundedDiagrams uses. */
export function renderWidget(widget: DashboardWidget, ctx: WidgetContext): ReactNode {
  const nodes = subset(widget, ctx);
  switch (widget.kind) {
    case "citation-chips":
      // The brush control: a chip click toggles the cross-filter AND bubbles to the
      // dossier inspect. Chips always show the full cited set (see `subset`).
      return nodes.length ? (
        <CitationChips
          cited={nodes}
          onFocusNode={(n) => {
            ctx.onToggleFocus?.(n.id);
            ctx.onFocusNode?.(n);
          }}
        />
      ) : null;
    case "coverage-header":
      return nodes.length ? <CoverageConflictHeader cited={nodes} /> : null;
    case "evidence-ledger":
      return nodes.length ? <EvidenceLedger cited={nodes} /> : null;
    case "evidence-subgraph":
      return nodes.length ? <EvidenceSubgraph nodes={nodes} edges={edgesWithin(nodes, ctx.graph)} /> : null;
    case "stat-chart": {
      const rows = nodes
        .filter((n) => n.kind === "SignalStat")
        .map((n) => ({ name: n.label, id: n.id, prr: num(n, "prr"), ror: num(n, "ror") }))
        .filter((r) => r.prr != null || r.ror != null);
      return rows.length ? <StatChart rows={rows} /> : null;
    }
    case "hero-flow":
      return nodes.length ? <HeroFlow nodes={nodes} edges={edgesWithin(nodes, ctx.graph)} /> : null;
    case "metric":
      return <MetricTile widget={widget} ctx={ctx} />;
    default:
      return null;
  }
}

/** A single KPI tile. Its value comes ONLY from `widget.metric` (a fixed enum) and
 *  data the client already holds — never from a literal in the spec. */
function MetricTile({ widget, ctx }: { widget: DashboardWidget; ctx: WidgetContext }) {
  const nodes = subset(widget, ctx); // reflects the active cross-filter brush
  let value = "—";
  let label = "";
  let accent = "var(--clinical-blue, #1769d6)";

  if (widget.metric === "faithfulness") {
    label = widget.title ?? "Faithfulness";
    if (ctx.faithfulness && typeof ctx.faithfulness.score === "number") {
      const pct = Math.round(ctx.faithfulness.score * 100);
      value = `${pct}%`;
      accent =
        ctx.faithfulness.band === "high"
          ? "rgba(46,160,67,0.95)"
          : ctx.faithfulness.band === "low"
            ? "rgba(248,81,73,0.95)"
            : "rgba(210,153,34,0.95)";
    }
  } else if (widget.metric === "cited-count") {
    label = widget.title ?? "Cited evidence";
    value = String(nodes.length);
  } else if (widget.metric === "coverage") {
    label = widget.title ?? "Coverage";
    const pct = Math.round(coverage(classifyCited(nodes)) * 100);
    value = `${pct}%`;
    accent = pct >= 70 ? "rgba(46,160,67,0.95)" : pct >= 40 ? "rgba(210,153,34,0.95)" : "rgba(248,81,73,0.95)";
  }

  return (
    <div
      data-testid="dashboard-metric"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "10px 14px",
        borderRadius: 8,
        border: "1px solid var(--frame-border)",
        borderLeft: `3px solid ${accent}`,
        background: "var(--frame-surface, rgba(255,255,255,0.02))",
        minWidth: 120,
      }}
    >
      <span style={{ fontSize: 22, fontWeight: 700, color: accent, lineHeight: 1.1 }}>{value}</span>
      <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--frame-text-muted)" }}>
        {label}
      </span>
    </div>
  );
}
