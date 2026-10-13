/**
 * Grounded-by-construction generative diagrams for the Copilot chat.
 *
 * Every diagram here is derived STRICTLY from real returned data:
 *   - `citedNodeIds`  — the exact node ids the grounded /ask agent touched
 *                       (extracted server-side from the Cypher it ran + the rows
 *                       it got back, intersected with the real graph).
 *   - `graph`         — the live graph payload the app already fetched from the
 *                       BFF (`/api/graph`), carrying each node's real attrs
 *                       (PRR/ROR on SignalStat nodes) and the real edges.
 *
 * NOTHING is invented. We only ever render nodes/edges/numbers that exist in the
 * fetched payload AND were cited. If a citation names an id we don't have in the
 * payload, it is simply skipped — never fabricated. Which diagram(s) appear is
 * chosen by what's actually in the citations:
 *   - SignalStat cited  -> PRR/ROR bar chart (real disproportionality metrics)
 *   - hero AE cited     -> Mermaid AE→Drug→Target→Pathway flow (real hero path)
 *   - always            -> mini evidence subgraph of the cited nodes + the real
 *                          edges that connect them
 */
import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import mermaid from "mermaid";
import type { GraphPayload, GraphNode } from "@rnd/shared";
import { NODE_COLORS } from "@rnd/shared";
import { classifyCited, coverage, classify, EVIDENCE_TONE } from "../lib/evidence.js";

mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });

const COLOR_FALLBACK: Record<string, string> = {
  RegulatoryDoc: "#e3b341",
  GeneticAssociation: "#7ee787",
};
const DEFAULT_COLOR = "#8b949e";
function colorOf(kind: string): string {
  return NODE_COLORS[kind] ?? COLOR_FALLBACK[kind] ?? DEFAULT_COLOR;
}

const HERO_AE = "AE-MYOCARDITIS";

export interface GroundedDiagramsProps {
  /** The exact node ids the grounded agent cited. Drives everything. */
  citedNodeIds: string[];
  /** The live graph payload the app already fetched. The source of all values. */
  graph: GraphPayload;
  /** Click a citation chip → focus that node (highlight + open its dossier). */
  onFocusNode?: (n: GraphNode) => void;
}

/** A number-attr reader that never invents a value. */
function num(n: GraphNode | undefined, key: string): number | null {
  const v = n?.attrs?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function GroundedDiagrams({ citedNodeIds, graph, onFocusNode }: GroundedDiagramsProps) {
  // Resolve cited ids against the REAL payload. Unknown ids are dropped, not faked.
  const byId = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const cited = useMemo(
    () => citedNodeIds.map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n)),
    [citedNodeIds, byId]
  );
  const citedSet = useMemo(() => new Set(cited.map((n) => n.id)), [cited]);

  // Edges that connect two cited nodes — the real wiring of the evidence subgraph.
  const subEdges = useMemo(
    () => graph.edges.filter((e) => citedSet.has(e.source) && citedSet.has(e.target)),
    [graph.edges, citedSet]
  );

  // Stat chart applies only when SignalStat nodes with real PRR/ROR are cited.
  const statRows = useMemo(
    () =>
      cited
        .filter((n) => n.kind === "SignalStat")
        .map((n) => ({ name: n.label, id: n.id, prr: num(n, "prr"), ror: num(n, "ror") }))
        .filter((r) => r.prr != null || r.ror != null),
    [cited]
  );

  // Hero Mermaid flow applies only when the hero AE is among the cited nodes.
  const heroCited = citedSet.has(HERO_AE);

  if (cited.length === 0) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
        Grounded evidence · derived from {cited.length} cited node(s)
      </div>

      {/* Inline citation chips — one per real cited node (unknown ids dropped).
          Clicking a chip focuses that node on the canvas + opens its dossier. */}
      <CitationChips cited={cited} onFocusNode={onFocusNode} />

      {/* Coverage + conflict flags header — the at-a-glance trust readout. */}
      <CoverageConflictHeader cited={cited} />

      {/* Safe-GenAI signature: Known / Missing / Conflicting + confidence boundary,
          classified ONLY from the real cited nodes (never an invented gap). */}
      <EvidenceLedger cited={cited} />

      {/* Mini evidence subgraph — always, from the real cited nodes + edges. */}
      <EvidenceSubgraph nodes={cited} edges={subEdges} />

      {/* Disproportionality chart — only when SignalStat metrics were cited. */}
      {statRows.length > 0 && <StatChart rows={statRows} />}

      {/* Hero mechanism flow — only when the hero AE was cited. */}
      {heroCited && <HeroFlow nodes={cited} edges={subEdges} />}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Known / Missing / Conflicting ledger — the PoC doc's "Safe GenAI" signature.
 *
 * Grounded-by-construction: it classifies ONLY the REAL cited nodes, using the
 * graph's OWN defect markers (the documented noise nodes the radar already
 * flags) — it never fabricates a gap. Buckets:
 *   - CONFLICTING : a cited node the graph flags as contradictory (AE-CONFLICT).
 *   - GAP/MISSING : a cited node the graph flags as missing-provenance / no
 *                   target link / stale mapping (TGT-NOPROV, DRUG-ORPHAN, CON-STALE).
 *   - KNOWN       : every other cited node — solid evidence the graph holds.
 * Plus an explicit CONFIDENCE BOUNDARY: the answer is bounded to these cited
 * nodes; anything outside the graph is refused (NOT_IN_GRAPH draws nothing, so
 * this panel only ever appears when there IS grounded evidence).
 * ------------------------------------------------------------------------- */
/** Inline citation chips — one per real cited node, colour-coded by KMC bucket.
 *  Clicking a chip focuses that node (highlight + dossier). Grounded: cited is
 *  already the citedNodeIds ∩ graph intersection, so no chip is ever fabricated. */
export function CitationChips({
  cited,
  onFocusNode,
}: {
  cited: GraphNode[];
  onFocusNode?: (n: GraphNode) => void;
}) {
  if (cited.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {cited.map((n) => {
        const tone = EVIDENCE_TONE[classify(n)];
        const clickable = Boolean(onFocusNode);
        return (
          <button
            key={n.id}
            type="button"
            onClick={clickable ? () => onFocusNode!(n) : undefined}
            title={`${n.kind} · ${n.id}${clickable ? " — focus on the graph + open provenance" : ""}`}
            disabled={!clickable}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontWeight: 600,
              padding: "3px 8px",
              borderRadius: 999,
              border: `1px solid ${tone}66`,
              background: `${tone}1f`,
              color: "var(--frame-text, #c9d1d9)",
              cursor: clickable ? "pointer" : "default",
              maxWidth: 220,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: tone, flex: "0 0 auto" }} />
            {n.label}
          </button>
        );
      })}
    </div>
  );
}

/** Coverage bar + conflict flag — the at-a-glance trust readout above the ledger.
 *  Coverage is a BANDED, honest signal (known / total cited), not false precision. */
export function CoverageConflictHeader({ cited }: { cited: GraphNode[] }) {
  const buckets = classifyCited(cited);
  const cov = coverage(buckets);
  const pct = Math.round(cov * 100);
  const band = pct >= 70 ? EVIDENCE_TONE.known : pct >= 40 ? EVIDENCE_TONE.missing : EVIDENCE_TONE.conflicting;
  const hasConflict = buckets.conflicting.length > 0;
  const hasGap = buckets.missing.length > 0;
  return (
    <div style={{ ...diagBox, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--frame-text-muted)" }}>
          Coverage
        </span>
        <div style={{ flex: 1, height: 7, borderRadius: 999, background: "#21262d", overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: band }} />
        </div>
        <span style={{ fontSize: 12, fontWeight: 700, color: band, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <Flag tone={EVIDENCE_TONE.known} label={`${buckets.known.length} known`} />
        {hasGap && <Flag tone={EVIDENCE_TONE.missing} label={`${buckets.missing.length} missing / gap`} />}
        {hasConflict && <Flag tone={EVIDENCE_TONE.conflicting} label={`⚠ ${buckets.conflicting.length} conflicting`} strong />}
      </div>
    </div>
  );
}

function Flag({ tone, label, strong }: { tone: string; label: string; strong?: boolean }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: strong ? 700 : 600,
        padding: "2px 8px",
        borderRadius: 999,
        color: tone,
        background: `${tone}1f`,
        border: `1px solid ${tone}${strong ? "" : "66"}`,
      }}
    >
      {label}
    </span>
  );
}

export function EvidenceLedger({ cited }: { cited: GraphNode[] }) {
  const { known, missing, conflicting } = classifyCited(cited);
  const cols: { key: string; label: string; tone: string; nodes: GraphNode[] }[] = [
    { key: "known", label: "Known", tone: EVIDENCE_TONE.known, nodes: known },
    { key: "missing", label: "Missing / gap", tone: EVIDENCE_TONE.missing, nodes: missing },
    { key: "conflicting", label: "Conflicting", tone: EVIDENCE_TONE.conflicting, nodes: conflicting },
  ];
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={diagCaption}>
        Known · Missing · Conflicting — graph-flagged, from the cited evidence
      </figcaption>
      <div style={{ ...diagBox, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {cols.map((c) => (
            <div key={c.key} style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  fontWeight: 700,
                  color: c.tone,
                  marginBottom: 4,
                }}
              >
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: c.tone, flex: "0 0 auto" }} />
                {c.label}
                <span style={{ color: "var(--frame-text-muted)", fontWeight: 600 }}>{c.nodes.length}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {c.nodes.length === 0 ? (
                  <span style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>—</span>
                ) : (
                  c.nodes.map((n) => (
                    <span
                      key={n.id}
                      title={`${n.kind} · ${n.id}`}
                      style={{
                        fontSize: 11,
                        color: "#c9d1d9",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        borderLeft: `2px solid ${c.tone}`,
                        paddingLeft: 6,
                      }}
                    >
                      {n.label}
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--frame-text-muted)",
            borderTop: "1px dashed #30363d",
            paddingTop: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span aria-hidden style={{ color: "#2dd4bf" }}>✓</span>
          Confidence boundary — answer bounded to {cited.length} cited node(s); claims outside the
          graph are refused (NOT_IN_GRAPH draws nothing).
        </div>
      </div>
    </figure>
  );
}

/* ---------------------------------------------------------------------------
 * Zoom affordances (observability ONLY — never a new fact source).
 *
 * Each in-chat figure gets an inline zoom cluster (− / reset / +) and an expand
 * (⤢) button that re-presents the SAME already-grounded figure in a fullscreen
 * lightbox. Force-graph uses its native crisp zoom; the SVG/Recharts figures use
 * a CSS transform. None of these fetch or alter data — they only re-view it.
 * ------------------------------------------------------------------------- */

/** A small square control button used in the figure zoom cluster. */
function ZoomBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width: 22,
        height: 22,
        borderRadius: 6,
        border: "1px solid #30363d",
        background: "#161b22",
        color: "#c9d1d9",
        cursor: "pointer",
        fontSize: 13,
        lineHeight: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {label}
    </button>
  );
}

/** Figure chrome: caption + a right-aligned zoom/expand cluster, then the content.
 *  Any handler omitted hides its button. `fill` makes the figure a flex column that
 *  fills its parent's height (used inside the fullscreen modal for the graph). */
function FigureFrame({
  caption,
  onZoomIn,
  onZoomOut,
  onReset,
  onExpand,
  fill,
  children,
}: {
  caption?: string;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onReset?: () => void;
  onExpand?: () => void;
  fill?: boolean;
  children: React.ReactNode;
}) {
  return (
    <figure
      style={fill ? { margin: 0, display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } : { margin: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        {caption ? <figcaption style={{ ...diagCaption, marginBottom: 0 }}>{caption}</figcaption> : <span />}
        <div style={{ display: "flex", gap: 4, flex: "0 0 auto" }}>
          {onZoomOut && <ZoomBtn label="−" title="Zoom out" onClick={onZoomOut} />}
          {onReset && <ZoomBtn label="⟳" title="Reset zoom" onClick={onReset} />}
          {onZoomIn && <ZoomBtn label="+" title="Zoom in" onClick={onZoomIn} />}
          {onExpand && <ZoomBtn label="⤢" title="Expand to fullscreen" onClick={onExpand} />}
        </div>
      </div>
      {fill ? <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>{children}</div> : children}
    </figure>
  );
}

/** Fullscreen lightbox for a figure. Closes on Esc, backdrop click, or ×. */
function FigureModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(2,8,18,.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#0d1117",
          border: "1px solid #30363d",
          borderRadius: 10,
          width: "min(1100px, 94vw)",
          height: "min(82vh, 820px)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 80px rgba(2,8,18,.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            padding: "8px 12px",
            borderBottom: "1px solid #21262d",
          }}
        >
          <span style={{ fontSize: 12, color: "var(--frame-text-muted)" }}>{title}</span>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              border: "1px solid #30363d",
              background: "#161b22",
              color: "#c9d1d9",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>{children}</div>
      </div>
    </div>
  );
}

/** CSS-transform zoom state for the SVG / Recharts figures (clamped 0.5×–3×). */
function useCssZoom() {
  const [scale, setScale] = useState(1);
  const clamp = (v: number) => Math.min(3, Math.max(0.5, Number(v.toFixed(3))));
  return {
    scale,
    zoomIn: () => setScale((s) => clamp(s * 1.2)),
    zoomOut: () => setScale((s) => clamp(s / 1.2)),
    reset: () => setScale(1),
  };
}

/** Wraps borderless figure content (a chart/SVG) with CSS-scale zoom + expand. The
 *  content scales inside a scrollable box so zoomed-in figures pan, not clip. */
function CssZoomFigure({
  caption,
  onExpand,
  children,
}: {
  caption?: string;
  onExpand?: () => void;
  children: React.ReactNode;
}) {
  const { scale, zoomIn, zoomOut, reset } = useCssZoom();
  return (
    <FigureFrame caption={caption} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} onExpand={onExpand}>
      <div style={{ ...diagBox, overflow: "auto" }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left", width: `${100 / Math.min(1, scale)}%` }}>
          {children}
        </div>
      </div>
    </FigureFrame>
  );
}

/** Nudge a react-force-graph's native zoom by a factor (crisp, not CSS-scaled). */
function zoomBy(ref: React.MutableRefObject<any>, factor: number) {
  const fg = ref.current;
  if (!fg?.zoom) return;
  const z = typeof fg.zoom === "function" ? fg.zoom() : 1;
  fg.zoom(Math.max(0.2, Math.min(8, (z || 1) * factor)), 250);
}

/** The measured force-graph render core — used both inline and (taller) in the
 *  modal. `fill` measures the container height; otherwise a fixed pixel height. */
function ForceSubgraph({
  nodes,
  edges,
  fgRef,
  height = 300,
  fill,
}: {
  nodes: GraphNode[];
  edges: GraphPayload["edges"];
  fgRef: React.MutableRefObject<any>;
  height?: number;
  fill?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 640, h: height });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (w: number, h: number) =>
      setSize({ w: Math.floor(w) || 640, h: fill ? Math.floor(h) || 400 : height });
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (cr) measure(cr.width, cr.height);
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    measure(r.width, r.height);
    return () => ro.disconnect();
  }, [fill, height]);

  const data = useMemo(
    () => ({
      nodes: nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
      links: edges.map((e) => ({ source: e.source, target: e.target })),
    }),
    [nodes, edges]
  );
  useEffect(() => {
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(400, 40), 300);
    return () => clearTimeout(t);
  }, [data, size.w, size.h, fgRef]);

  return (
    <div
      ref={wrapRef}
      style={{
        ...diagBox,
        width: "100%",
        ...(fill ? { flex: 1, minHeight: 0, height: "100%" } : { height: size.h }),
      }}
    >
      <ForceGraph2D
        ref={fgRef}
        width={size.w}
        height={size.h - 4}
        graphData={data}
        backgroundColor="#0d1117"
        cooldownTicks={80}
        onEngineStop={() => fgRef.current?.zoomToFit?.(400, 40)}
        linkColor={() => "#30363d"}
        linkWidth={() => 1.5}
        nodeRelSize={6}
        nodeCanvasObject={(node: any, ctx, scale) => {
          const r = 6;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = colorOf(node.kind);
          ctx.fill();
          if (scale > 0.5) {
            ctx.font = `${10 / scale}px system-ui`;
            ctx.fillStyle = "#c9d1d9";
            ctx.textAlign = "center";
            ctx.fillText(node.label, node.x, node.y - r - 3 / scale);
          }
        }}
      />
    </div>
  );
}

/** Force-graph figure with its own native-zoom cluster (and optional expand). */
function ForceSubgraphZoomable({
  nodes,
  edges,
  caption,
  height,
  fill,
  onExpand,
}: {
  nodes: GraphNode[];
  edges: GraphPayload["edges"];
  caption?: string;
  height?: number;
  fill?: boolean;
  onExpand?: () => void;
}) {
  const fgRef = useRef<any>(null);
  return (
    <FigureFrame
      caption={caption}
      fill={fill}
      onZoomIn={() => zoomBy(fgRef, 1.3)}
      onZoomOut={() => zoomBy(fgRef, 1 / 1.3)}
      onReset={() => fgRef.current?.zoomToFit?.(400, 40)}
      onExpand={onExpand}
    >
      <ForceSubgraph nodes={nodes} edges={edges} fgRef={fgRef} height={height} fill={fill} />
    </FigureFrame>
  );
}

/** react-force-graph-2d subgraph of just the cited nodes + their connecting edges.
 *  Measures its container so it spreads to the full available width; inline zoom +
 *  a fullscreen lightbox are pure view affordances over the same grounded data. */
export function EvidenceSubgraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphPayload["edges"] }) {
  const [expanded, setExpanded] = useState(false);
  const caption = "Evidence subgraph (cited nodes only)";
  return (
    <>
      <ForceSubgraphZoomable nodes={nodes} edges={edges} caption={caption} height={300} onExpand={() => setExpanded(true)} />
      {expanded && (
        <FigureModal title={caption} onClose={() => setExpanded(false)}>
          <ForceSubgraphZoomable nodes={nodes} edges={edges} fill />
        </FigureModal>
      )}
    </>
  );
}

/** Recharts bar chart of real PRR/ROR on the cited SignalStat node(s). */
export function StatChart({
  rows,
}: {
  rows: { name: string; id: string; prr: number | null; ror: number | null }[];
}) {
  // Recharts wants numbers; null bars simply don't render (no fabricated value).
  const data = rows.map((r) => ({
    name: r.name.replace(/^Disproportionality\s*/i, "").trim() || r.id,
    PRR: r.prr ?? undefined,
    ROR: r.ror ?? undefined,
  }));
  const [expanded, setExpanded] = useState(false);
  const caption = "Disproportionality (PRR / ROR) — real signal metrics";
  const chart = (h: number | string) => (
    <div style={{ height: h, padding: 8 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
          <XAxis dataKey="name" tick={{ fill: "#8b949e", fontSize: 10 }} />
          <YAxis tick={{ fill: "#8b949e", fontSize: 10 }} />
          <Tooltip
            contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 12 }}
            labelStyle={{ color: "#c9d1d9" }}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="PRR" fill="#bc8cff" radius={[3, 3, 0, 0]}>
            {data.map((_, i) => (
              <Cell key={i} />
            ))}
          </Bar>
          <Bar dataKey="ROR" fill="#58a6ff" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
  return (
    <>
      <CssZoomFigure caption={caption} onExpand={() => setExpanded(true)}>
        {chart(200)}
      </CssZoomFigure>
      {expanded && (
        <FigureModal title={caption} onClose={() => setExpanded(false)}>
          <CssZoomFigure>{chart("60vh")}</CssZoomFigure>
        </FigureModal>
      )}
    </>
  );
}

/** Mermaid flow of the hero AE→Drug→Target→Pathway chain, built from REAL cited
 *  nodes + edges. We only emit a Mermaid edge when both endpoints were cited and
 *  a real edge connects them — so the flow can never show a path the graph
 *  didn't return. */
export function HeroFlow({ nodes, edges }: { nodes: GraphNode[]; edges: GraphPayload["edges"] }) {
  const [svg, setSvg] = useState<string>("");
  const [expanded, setExpanded] = useState(false);
  const idRef = useRef(`mmd-${Math.random().toString(36).slice(2)}`);
  const caption = "Hero mechanism flow (cited path)";

  const def = useMemo(() => {
    const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
    const safe = (s: string) => s.replace(/["\n]/g, " ").slice(0, 40);
    const lines = ["flowchart LR"];
    // Declare a node box per cited node, kind-coloured.
    for (const n of nodes) {
      lines.push(`  ${nodeKey(n.id)}["${safe(n.label)}"]`);
    }
    // One arrow per REAL connecting edge between cited nodes.
    for (const e of edges) {
      if (labelOf.has(e.source) && labelOf.has(e.target)) {
        lines.push(`  ${nodeKey(e.source)} --> ${nodeKey(e.target)}`);
      }
    }
    return lines.join("\n");
  }, [nodes, edges]);

  useEffect(() => {
    let alive = true;
    mermaid
      .render(idRef.current, def)
      .then(({ svg }) => alive && setSvg(svg))
      .catch(() => alive && setSvg(""));
    return () => {
      alive = false;
    };
  }, [def]);

  if (!svg) return null;
  // Mermaid output is our own deterministic, escaped definition (securityLevel:strict).
  const flow = <div style={{ padding: 10 }} dangerouslySetInnerHTML={{ __html: svg }} />;
  return (
    <>
      <CssZoomFigure caption={caption} onExpand={() => setExpanded(true)}>
        {flow}
      </CssZoomFigure>
      {expanded && (
        <FigureModal title={caption} onClose={() => setExpanded(false)}>
          <CssZoomFigure>{flow}</CssZoomFigure>
        </FigureModal>
      )}
    </>
  );
}

/** Mermaid node ids must be identifier-safe; map the graph id deterministically. */
function nodeKey(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9]/g, "_");
}

const diagBox: React.CSSProperties = {
  border: "1px solid #30363d",
  borderRadius: 8,
  background: "#0d1117",
};
const diagCaption: React.CSSProperties = {
  fontSize: 11,
  color: "var(--frame-text-muted)",
  marginBottom: 4,
};
