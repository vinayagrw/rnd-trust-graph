/**
 * Hop rail — turns the hero narration from a pretty animation into an AUDITABLE
 * object. Lists every hop of the deterministic path upfront (reasoning shown
 * before it's narrated), shows the exact relationship/predicate that justified
 * each step, highlights in lockstep with the canvas, marks which nodes the live
 * narration actually cited, and opens a hop's provenance on click.
 */
import type { ExplanationPath, GraphNode } from "@rnd/shared";
import { nodeColor } from "@rnd/shared";

interface Props {
  path: ExplanationPath;
  activeIndex: number; // 0-based index of the current hop (count - 1)
  revealedCount: number; // how many hops are revealed so far
  citedIds: Set<string>; // node IDs the live narration grounded itself on
  onHopClick: (n: GraphNode) => void;
  /**
   * Which surface the rail sits on. "canvas" = the dark graph-canvas overlay
   * (ExplanationBeat hero); "frame" = a light card surface (AnswerCanvas). The
   * default keeps the existing dark-overlay rendering. Picking the wrong family
   * here is what made the AnswerCanvas hops near-white-on-white.
   */
  tone?: "canvas" | "frame";
}

/** Surface-aware colour families so text always contrasts with its host card. */
const TONES = {
  canvas: {
    text: "var(--canvas-text, #e6edf3)",
    muted: "var(--canvas-text-muted, #9aa4b2)",
    border: "var(--canvas-border, rgba(255,255,255,.08))",
    predBg: "rgba(188,140,255,.18)",
    predText: "#d7bbff",
    citedText: "#56d364",
  },
  frame: {
    text: "var(--frame-text, #0a2540)",
    muted: "var(--frame-text-muted, #5b6b7f)",
    border: "var(--frame-border, #d7dfea)",
    predBg: "rgba(125,77,189,.14)",
    predText: "#6b3fa0",
    citedText: "#1a7f37",
  },
} as const;

export function HopRail({
  path,
  activeIndex,
  revealedCount,
  citedIds,
  onHopClick,
  tone = "canvas",
}: Props) {
  const t = TONES[tone];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: t.muted,
          marginBottom: 2,
        }}
      >
        Reasoning · {path.hops.length} hops {path.deductive && "· deductive · auto-accept"}
      </div>
      {path.hops.map((h, i) => {
        const isActive = i === activeIndex;
        const isRevealed = i < revealedCount;
        const isCited = citedIds.has(h.node.id);
        return (
          <button
            key={h.node.id}
            className="btn"
            onClick={() => onHopClick(h.node)}
            title="Open this hop's provenance"
            style={{
              display: "flex",
              alignItems: "flex-start", // top-align so the disc sits with line 1 when labels wrap
              gap: 8,
              textAlign: "left",
              padding: "5px 8px",
              borderRadius: 8,
              cursor: "pointer",
              opacity: isRevealed ? 1 : 0.42, // future hops dim — reasoning shown, not yet walked
              background: isActive ? "rgba(121,184,255,.16)" : "transparent",
              border: isActive ? "1px solid rgba(121,184,255,.6)" : `1px solid ${t.border}`,
              color: t.text,
            }}
          >
            <span
              style={{
                flex: "0 0 auto",
                width: 18,
                height: 18,
                borderRadius: "50%",
                background: nodeColor(h.node.kind),
                color: "#0d1117",
                fontSize: 11,
                fontWeight: 700,
                display: "grid",
                placeItems: "center",
              }}
            >
              {h.index}
            </span>
            <span style={{ flex: 1, minWidth: 0, lineHeight: 1.4, overflowWrap: "anywhere" }}>
              {h.edge && (
                <span
                  style={{
                    fontFamily: "ui-monospace, Menlo, monospace",
                    fontSize: 10.5,
                    padding: "1px 5px",
                    borderRadius: 4,
                    background: t.predBg,
                    color: t.predText,
                    marginRight: 6,
                    whiteSpace: "nowrap",
                  }}
                >
                  {h.edge.kind}
                </span>
              )}
              {/* Full label wraps (no truncation) + tooltip — long provenance
                  strings like FAERS windows / PMIDs stay fully readable. */}
              <span style={{ fontSize: 13 }} title={h.node.label}>
                {h.node.label}
              </span>
              <span style={{ fontSize: 11, color: t.muted, marginLeft: 6 }}>{h.node.kind}</span>
            </span>
            {isCited && (
              <span
                title="The live narration cited this node — grounded, on-path"
                style={{
                  flex: "0 0 auto",
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 6px",
                  borderRadius: 999,
                  background: "rgba(63,185,80,.18)",
                  color: t.citedText,
                  border: "1px solid rgba(63,185,80,.5)",
                }}
              >
                ✓ cited
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
