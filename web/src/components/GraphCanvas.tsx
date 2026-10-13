/**
 * Dark, luminous graph canvas (the one dark surface in the clinical chrome).
 * Renders the R&D Trust Graph and dims everything not yet revealed so the
 * Beat-2 path "lights up" hop by hop.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphPayload, GraphNode, GraphEdge } from "@rnd/shared";
import { nodeColor, CANVAS_DARK, CANVAS_LIGHT, readinessColor } from "@rnd/shared";
import { useMotion } from "../lib/motion.js";

export interface GraphCanvasProps {
  graph: GraphPayload;
  /** Node ids currently revealed (full opacity). Empty = show all at full. */
  revealed?: Set<string>;
  /** Node ids to pulse as the "active" hop. */
  active?: Set<string>;
  /** Node ids forming the current reasoning / answer path. Every edge whose BOTH
   *  endpoints are in this set gets flowing particles + a bright stroke, so the
   *  whole path "flows" (not just the single active hop). Beat 2 passes the
   *  revealed hero-path nodes; Beat 4 passes the cited-answer nodes. */
  pathNodes?: Set<string>;
  /** Search matches: ringed bright + labelled, and zoomed into view. */
  highlight?: Set<string>;
  /** True while a search query is in effect (dims everything not matched). */
  searchActive?: boolean;
  /** Render a built-in node search bar above the canvas (self-contained match +
   *  highlight + zoom). Opt-in so every beat's canvas gets search for free. */
  searchable?: boolean;
  /** Readiness colouring overlay (Beat 1). nodeId -> 0..100. */
  readiness?: Map<string, number>;
  /** Trust lens — node ids a human reviewer verified (HUMAN_APPROVED edge).
   *  Drawn as a small green check stamp. Derived from real edges only. */
  verified?: Set<string>;
  /** Trust lens — node ids below the readiness band. Drawn as a dashed red halo
   *  (distinct from the amber search halo). Derived from /api/risk only. */
  lowConfidence?: Set<string>;
  /** Trust lens — node ids a SHACL/data-quality rule (or a human reviewer) has
   *  flagged. Drawn as a small amber "!" stamp at the node's upper-LEFT (mirror of
   *  the green verified stamp at upper-right, so a node can show both). Derived
   *  from /api/risk findings (flags.length > 0) only. */
  flagged?: Set<string>;
  /** Projector-survival light theme for bright rooms. */
  lightCanvas?: boolean;
  /** Optional filters control (the beat's <FiltersRail>). When provided, a
   *  floating "Filters" button appears WHILE EXPANDED so the same node-kind /
   *  readiness / trust filters stay reachable in full screen on every page.
   *  In normal mode the beat already renders the rail beside the canvas, so this
   *  slot is shown only in the fullscreen overlay. */
  filtersSlot?: ReactNode;
  onNodeClick?: (node: GraphNode) => void;
  /** Click an edge → open the edge detail / tag panel. */
  onEdgeClick?: (edge: GraphEdge) => void;
  width?: number;
  height?: number;
}

interface FGNode extends GraphNode {
  x?: number;
  y?: number;
}

/**
 * Robust, string-keyed visual lookups. Kept independent of the NodeKind union so
 * NEW backend kinds (e.g. RegulatoryDoc, GeneticAssociation) render correctly
 * even before shared/src/types.ts is updated — unknown kinds fall back safely.
 */
const KIND_RADIUS: Record<string, number> = {
  AdverseEvent: 9,
  LiteratureAbstract: 6,
  ClinicalTrial: 6,
  OntologySlice: 6,
  RegulatoryDoc: 6,
  GeneticAssociation: 7,
  ExternalPipeline: 8, // F8: slightly larger so the dashed synthetic node is legible
};
const DEFAULT_RADIUS = 7;

function nodeRadius(kind: string): number {
  return KIND_RADIUS[kind] ?? DEFAULT_RADIUS;
}

export function GraphCanvas({
  graph,
  revealed,
  active,
  pathNodes,
  highlight,
  searchActive = false,
  searchable = false,
  readiness,
  verified,
  lowConfidence,
  flagged,
  lightCanvas = false,
  filtersSlot,
  onNodeClick,
  onEdgeClick,
  width,
  height = 560,
}: GraphCanvasProps) {
  const fgRef = useRef<any>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  // Guards the auto-fit so it runs only on the FIRST layout settle for a given
  // dataset/viewport. Dragging a node reheats the simulation and fires
  // onEngineStop again — without this the post-drag fit would snap the user's
  // manual zoom/pan back to the fitted view (the "canvas resets on drag" bug).
  const didFitRef = useRef(false);
  const pal = lightCanvas ? CANVAS_LIGHT : CANVAS_DARK;
  // Motion is an app-level toggle (default ON), NOT the OS media query, so the
  // signature flow stays visible on machines that disable animations by policy.
  const reduceMotion = !useMotion();

  // Fullscreen / expand. When on, the whole canvas (search bar included) lifts
  // into a fixed overlay covering the viewport; `measuredH` lets the force-graph
  // fill that height (in normal mode the `height` prop still governs).
  const [isFull, setIsFull] = useState(false);
  const [measuredH, setMeasuredH] = useState(0);

  // Built-in node search (opt-in via `searchable`). Pure client-side label/id
  // match over the already-fetched payload — no new query, no LLM. When enabled
  // it OVERRIDES the external highlight/searchActive props so the host doesn't
  // have to thread search state; when disabled those external props still apply.
  const [query, setQuery] = useState("");
  const internalMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchable || !q) return null;
    const hit = new Set<string>();
    for (const n of graph.nodes) {
      if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) hit.add(n.id);
    }
    return hit;
  }, [searchable, query, graph.nodes]);
  const effHighlight = searchable ? internalMatches ?? undefined : highlight;
  const effSearchActive = searchable ? query.trim().length > 0 : searchActive;

  // Fill the parent's width responsively. A fixed 900px canvas left a black
  // gutter on wide monitors (the "right black screen") — measure the container.
  const [measuredW, setMeasuredW] = useState<number>(width ?? 900);
  useEffect(() => {
    if (width != null) return; // explicit width overrides auto-measure
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setMeasuredW(Math.floor(w));
    });
    ro.observe(el);
    setMeasuredW(Math.floor(el.clientWidth) || 900);
    return () => ro.disconnect();
  }, [width]);
  const canvasW = width ?? measuredW;

  // Measure the canvas area's height so the force-graph can fill the overlay when
  // expanded (the area flex-grows in fullscreen; in normal mode this just tracks
  // the fixed `height`). Used only when `isFull`.
  useEffect(() => {
    const el = canvasAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h && h > 0) setMeasuredH(Math.floor(h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const effectiveHeight = isFull ? measuredH || height : height;

  // Esc closes the overlay; lock body scroll + re-fit the graph while expanded.
  useEffect(() => {
    if (!isFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFull(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(400, 60), 120);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
    };
  }, [isFull]);

  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((n) => ({ ...n })),
      links: graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        kind: e.kind,
        label: e.label,
        tags: e.tags,
        provenance: e.provenance,
      })),
    }),
    [graph]
  );

  // Re-fit the graph into view whenever the data or viewport changes, so nodes
  // never drift into a corner off-screen (the cause of the "mostly black" view).
  useEffect(() => {
    if (!graph.nodes.length) return;
    // New data / viewport → allow exactly one auto-fit as the layout re-settles.
    didFitRef.current = false;
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(400, 60), 350);
    return () => clearTimeout(t);
  }, [graph, canvasW, height]);

  // When a search yields matches, ease the viewport onto them so the highlighted
  // nodes are actually brought into view (not just ringed somewhere off-screen).
  useEffect(() => {
    if (!effHighlight || effHighlight.size === 0) return;
    const t = setTimeout(() => {
      fgRef.current?.zoomToFit?.(500, 80, (n: any) => effHighlight.has(n.id ?? n));
    }, 120);
    return () => clearTimeout(t);
  }, [effHighlight]);

  const isRevealed = (id: string) => !revealed || revealed.size === 0 || revealed.has(id);
  // An edge is "on the path" when BOTH its endpoints are path nodes — so the whole
  // reasoning/answer path flows (particles + bright stroke), not just one hop. Needs
  // ≥2 path nodes to have any internal edge, so a single active node stays a pulse.
  const isPathEdge = (l: any) => {
    if (!pathNodes || pathNodes.size < 2) return false;
    const s = (l.source as any)?.id ?? l.source;
    const t = (l.target as any)?.id ?? l.target;
    return pathNodes.has(s) && pathNodes.has(t);
  };
  const searchDims = effSearchActive && !!effHighlight && effHighlight.size > 0;

  return (
    <div
      ref={wrapRef}
      style={
        isFull
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              background: pal.canvas,
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }
          : { width: "100%", display: "flex", flexDirection: "column", gap: searchable ? 8 : 0 }
      }
    >
    {searchable && (
      <CanvasSearchBar value={query} onChange={setQuery} matchCount={internalMatches?.size ?? 0} />
    )}
    <div
      ref={canvasAreaRef}
      style={{
        position: "relative",
        width: "100%",
        height: isFull ? undefined : height,
        flex: isFull ? "1 1 auto" : undefined,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
    <FullscreenToggle isFull={isFull} onToggle={() => setIsFull((v) => !v)} />
    {isFull && filtersSlot && <FullscreenFilters>{filtersSlot}</FullscreenFilters>}
    {data.nodes.length === 0 && (
      <div
        role="status"
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        <div
          style={{
            background: "rgba(12,20,32,.78)",
            color: "#e8eef6",
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 10,
            padding: "12px 16px",
            textAlign: "center",
            maxWidth: 280,
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>No nodes match the current filters</div>
          <div style={{ fontSize: 12, opacity: 0.82, marginTop: 3 }}>
            Adjust or clear the filters to see the graph.
          </div>
        </div>
      </div>
    )}
    <ForceGraph2D
      ref={fgRef}
      width={canvasW}
      height={effectiveHeight}
      graphData={data}
      backgroundColor={pal.canvas}
      cooldownTicks={120}
      // Keep the render loop alive so the flowing-particle "lines" animate
      // continuously (active hop + the whole reasoning/answer path), on every beat.
      // Without this, react-force-graph pauses redraw once the layout cools, which
      // freezes the particles the moment the graph settles. When reduced-motion is
      // requested we let it pause (particles are suppressed anyway → no wasted frames).
      autoPauseRedraw={reduceMotion}
      onEngineStop={() => {
        // Fit only on the first settle for this dataset/viewport. A node drag
        // reheats the sim and fires this again on re-settle; re-fitting there
        // would discard the user's manual zoom/pan (the "resets on drag" bug).
        if (didFitRef.current) return;
        didFitRef.current = true;
        fgRef.current?.zoomToFit?.(400, 60);
      }}
      linkDirectionalParticles={(l: any) => {
        if (reduceMotion) return 0;
        const tgt = (l.target as any).id ?? l.target;
        if (active && active.has(tgt)) return 4; // the pulsing current-hop edge
        return isPathEdge(l) ? 3 : 0; // flow along the WHOLE path, everywhere
      }}
      linkDirectionalParticleColor={() => pal.edgeActive}
      linkColor={(l: any) => {
        const tgt = (l.target as any).id ?? l.target;
        if (active && active.has(tgt)) return pal.edgeActive;
        if (isPathEdge(l)) return pal.edgeActive; // path edges read as a bright line
        return isRevealed(tgt) ? pal.edge : pal.edgeIdle;
      }}
      linkWidth={(l: any) => {
        const tgt = (l.target as any).id ?? l.target;
        // Active path separates by luminance AND weight (>=3px); idle stays thin.
        if (active && active.has(tgt)) return 3.5;
        if (isPathEdge(l)) return 3;
        return isRevealed(tgt) ? 2.5 : 1.2;
      }}
      // Native hover tooltip: the human-friendly relationship type + provenance,
      // and any reviewer tags. Read-only — just surfaces what the edge already carries.
      linkLabel={(l: any) => {
        const type = l.label ?? l.kind ?? "";
        const p = l.provenance ?? {};
        const prov = [p.sourceSystem, p.license, p.timestamp].filter(Boolean).join(" · ");
        const tags = (l.tags ?? []).length ? `\ntags: ${(l.tags ?? []).join(", ")}` : "";
        return `${type}${prov ? `\n${prov}` : ""}${tags}`;
      }}
      // Paint the relationship type on the edge (Part 1) plus any reviewer #tags
      // (Part 3). Drawn "after" the link so text sits on top of the line. Declutter:
      // only render once the user has zoomed in past a threshold so a dense graph
      // stays legible; honours the reveal-dim state like linkColor.
      linkCanvasObjectMode={() => "after"}
      linkCanvasObject={(l: any, ctx, globalScale) => {
        if (globalScale < 1.3) return;
        const s = l.source;
        const t = l.target;
        if (!s || !t || typeof s !== "object" || typeof t !== "object") return;
        if (s.x == null || t.x == null) return;
        const tgt = (l.target as any).id ?? l.target;
        const dim = !isRevealed(tgt) || (searchDims && !!effHighlight && !effHighlight.has(tgt));
        const type = (l.label ?? l.kind ?? "") as string;
        const tags: string[] = l.tags ?? [];
        const text = type + (tags.length ? "  " + tags.map((g) => `#${g}`).join(" ") : "");
        if (!text) return;
        const mx = (s.x + t.x) / 2;
        const my = (s.y + t.y) / 2;
        const fontSize = 11 / globalScale;
        ctx.save();
        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const w = ctx.measureText(text).width;
        const padX = 4 / globalScale;
        const padY = 2 / globalScale;
        ctx.globalAlpha = dim ? 0.35 : 1;
        // Faint pill so the label reads over the edge/particles.
        ctx.fillStyle = lightCanvas ? "rgba(255,255,255,.82)" : "rgba(12,20,32,.78)";
        ctx.fillRect(mx - w / 2 - padX, my - fontSize / 2 - padY, w + padX * 2, fontSize + padY * 2);
        ctx.fillStyle = lightCanvas ? "#334155" : "#cdd7e4";
        ctx.fillText(text, mx, my);
        if (tags.length) {
          // Re-draw just the tag portion in an accent hue so reviewer tags stand out.
          const typeW = ctx.measureText(type + "  ").width;
          ctx.fillStyle = pal.edgeActive;
          ctx.textAlign = "left";
          ctx.fillText(tags.map((g) => `#${g}`).join(" "), mx - w / 2 + typeW, my);
        }
        ctx.restore();
      }}
      onLinkClick={(l: any) => {
        if (!onEdgeClick) return;
        const src = (l.source as any)?.id ?? l.source;
        const tgt = (l.target as any)?.id ?? l.target;
        onEdgeClick({
          id: l.id ?? `${src}-${l.kind}-${tgt}`,
          source: src,
          target: tgt,
          kind: l.kind,
          label: l.label,
          tags: l.tags,
          provenance: l.provenance,
        });
      }}
      nodeCanvasObject={(node: FGNode, ctx, globalScale) => {
        const revealedNode = isRevealed(node.id);
        const hasReadiness = readiness?.has(node.id) ?? false;
        const score = hasReadiness ? readiness!.get(node.id)! : null;
        // AdverseEvent is the largest (signal anchor); the WS1 metadata
        // modalities (literature / trials / ontology slices) render a touch
        // smaller so they read as a supporting layer, not core mechanism nodes.
        const r = nodeRadius(node.kind as string);
        // Node BODY always shows its kind colour (so the canvas matches the
        // Filters "Node kind" swatches). Readiness is encoded on the ring below
        // (colour + thickness), never on the fill.
        const base = nodeColor(node.kind as string);
        const isMatch = !!effHighlight && effHighlight.has(node.id);

        // Search dims everything not matched so the hit stands out; otherwise the
        // usual reveal alpha applies.
        // F8 — synthetic overlay nodes (competitor pipelines) always render at full
        // opacity (so the labelled overlay is legible) but with a DASHED border so
        // they can never be mistaken for real, grounded evidence.
        const isSynthetic = (node as { synthetic?: boolean }).synthetic === true;
        ctx.globalAlpha = isSynthetic ? 1 : searchDims && !isMatch ? 0.1 : revealedNode ? 1 : 0.18;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, r, 0, 2 * Math.PI);
        ctx.fillStyle = base;
        ctx.fill();
        if (isSynthetic) {
          ctx.setLineDash([2, 2]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#cbd5e1";
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r + 1, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Readiness: redundant encoding — hue + ring thickness (thicker = worse),
        // so the signal survives colour-vision deficiency and projection. The ring
        // is coloured by readiness (the body stays the kind colour).
        if (score != null) {
          ctx.lineWidth = score >= 70 ? 1 : score >= 40 ? 2.5 : 4;
          ctx.strokeStyle = readinessColor(score);
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r + 2.5, 0, 2 * Math.PI);
          ctx.stroke();
        }

        // Active hop: high-luminance ring (the "you are here" pulse target).
        if (active && active.has(node.id)) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = pal.edgeActive;
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r + 1.5, 0, 2 * Math.PI);
          ctx.stroke();
        }

        // Trust lens — low-confidence halo: a dashed red ring, distinct in colour
        // AND dash from the solid amber search halo, and at a smaller radius so a
        // node that is BOTH searched and low-confidence shows both rings.
        if (lowConfidence && lowConfidence.has(node.id)) {
          ctx.globalAlpha = 1;
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#de4a3b";
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r + 6.5, 0, 2 * Math.PI);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Search match: bright amber halo so the found node is unmistakable.
        if (isMatch) {
          ctx.globalAlpha = 1;
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = "#f7c948";
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, r + 4.5, 0, 2 * Math.PI);
          ctx.stroke();
        }

        // Trust lens — human-verified stamp: a small green disc + check at the
        // node's upper-right. A stamp, not a ring, so it never reads as readiness.
        if (verified && verified.has(node.id)) {
          ctx.globalAlpha = 1;
          const bx = node.x! + r * 0.85;
          const by = node.y! - r * 0.85;
          const br = Math.max(2.6, r * 0.5);
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, 2 * Math.PI);
          ctx.fillStyle = "#2bb673";
          ctx.fill();
          ctx.strokeStyle = pal.canvas;
          ctx.lineWidth = 1;
          ctx.stroke();
          // A tiny check glyph inside the disc.
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(0.9, br * 0.32);
          ctx.beginPath();
          ctx.moveTo(bx - br * 0.45, by + br * 0.05);
          ctx.lineTo(bx - br * 0.1, by + br * 0.42);
          ctx.lineTo(bx + br * 0.5, by - br * 0.4);
          ctx.stroke();
        }

        // Trust lens — flagged stamp: a small amber disc + "!" at the node's
        // upper-LEFT (mirror of the verified stamp at upper-right, so a node can
        // carry both). Surfaces SHACL / data-quality flags directly on the node.
        if (flagged && flagged.has(node.id)) {
          ctx.globalAlpha = 1;
          const fx = node.x! - r * 0.85;
          const fy = node.y! - r * 0.85;
          const fr = Math.max(2.6, r * 0.5);
          ctx.beginPath();
          ctx.arc(fx, fy, fr, 0, 2 * Math.PI);
          ctx.fillStyle = "#e0a93b";
          ctx.fill();
          ctx.strokeStyle = pal.canvas;
          ctx.lineWidth = 1;
          ctx.stroke();
          // A tiny "!" glyph inside the disc: a stem + a dot.
          ctx.strokeStyle = "#1b1300";
          ctx.lineWidth = Math.max(0.9, fr * 0.3);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(fx, fy - fr * 0.45);
          ctx.lineTo(fx, fy + fr * 0.12);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(fx, fy + fr * 0.48, Math.max(0.5, fr * 0.16), 0, 2 * Math.PI);
          ctx.fillStyle = "#1b1300";
          ctx.fill();
          ctx.lineCap = "butt";
        }

        if ((revealedNode && globalScale > 0.7) || isMatch) {
          ctx.globalAlpha = 1;
          ctx.font = `${11 / globalScale}px system-ui`;
          ctx.fillStyle = pal.label;
          ctx.textAlign = "center";
          ctx.fillText(node.label, node.x!, node.y! - r - 3 / globalScale);
          // Third redundant channel for readiness: on-node numeric badge.
          if (score != null) {
            ctx.font = `bold ${9 / globalScale}px system-ui`;
            ctx.fillStyle = pal.label;
            ctx.fillText(String(score), node.x!, node.y! + 3 / globalScale);
          }
        }
        ctx.globalAlpha = 1;
      }}
      onNodeClick={(node: any) => onNodeClick?.(node as GraphNode)}
    />
    </div>
    </div>
  );
}

/** Built-in canvas node search box — highlights + zooms matching nodes. Pure
 *  client-side label/id match; no query to the BFF, no LLM. */
function CanvasSearchBar({
  value,
  onChange,
  matchCount,
}: {
  value: string;
  onChange: (v: string) => void;
  matchCount: number;
}) {
  const active = value.trim().length > 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        background: "var(--frame-surface)",
        border: "1px solid var(--frame-border)",
        borderRadius: "var(--radius)",
        flex: "0 0 auto",
      }}
    >
      <span aria-hidden style={{ fontSize: 14, color: "var(--frame-text-muted)" }}>
        ⌕
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search nodes…"
        aria-label="Search nodes in the graph"
        style={{
          flex: 1,
          minWidth: 0,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--frame-text)",
          fontSize: 13,
        }}
      />
      {active && (
        <span style={{ fontSize: 11, color: "var(--frame-text-muted)", whiteSpace: "nowrap" }}>
          {matchCount} match{matchCount === 1 ? "" : "es"}
        </span>
      )}
      {active && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="Clear search"
          aria-label="Clear search"
          style={{
            border: "1px solid var(--frame-border)",
            background: "transparent",
            color: "var(--frame-text-muted)",
            cursor: "pointer",
            width: 22,
            height: 22,
            borderRadius: 6,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** Expand / collapse the graph into a full-viewport overlay. Floats at the
 *  canvas's top-right; works on both the dark canvas and the light skin. */
function FullscreenToggle({ isFull, onToggle }: { isFull: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={isFull ? "Exit full screen (Esc)" : "Expand graph to full screen"}
      aria-label={isFull ? "Exit full screen" : "Expand graph to full screen"}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 5,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 9px",
        borderRadius: 6,
        cursor: "pointer",
        fontSize: 12,
        lineHeight: 1,
        color: "var(--frame-text)",
        background: "var(--frame-surface)",
        border: "1px solid var(--frame-border)",
        boxShadow: "0 1px 4px rgba(0,0,0,.25)",
      }}
    >
      <span aria-hidden style={{ fontSize: 14 }}>{isFull ? "⤧" : "⤢"}</span>
      {isFull ? "Exit" : "Full screen"}
    </button>
  );
}

/** Floating filters affordance shown only while the canvas is expanded. Keeps the
 *  beat's own <FiltersRail> reachable in full screen — same node-kind / readiness
 *  / trust filters, same state — without the rail eating canvas width by default.
 *  Collapsed to a button; expands to a scrollable panel anchored top-left. */
function FullscreenFilters({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "absolute", top: 8, left: 8, zIndex: 6, display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? "Hide filters" : "Show filters"}
        aria-label={open ? "Hide filters" : "Show filters"}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: 12,
          lineHeight: 1,
          color: "var(--frame-text)",
          background: "var(--frame-surface)",
          border: "1px solid var(--frame-border)",
          boxShadow: "0 1px 4px rgba(0,0,0,.25)",
        }}
      >
        <span aria-hidden style={{ fontSize: 13 }}>⛃</span>
        {open ? "Hide filters" : "Filters"}
      </button>
      {open && (
        <div style={{ width: 210, maxHeight: "calc(100vh - 80px)", overflowY: "auto" }}>
          {children}
        </div>
      )}
    </div>
  );
}
