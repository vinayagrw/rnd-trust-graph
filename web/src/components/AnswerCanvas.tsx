/**
 * KMC Answer Canvas — the persistent, auditable rendering of a grounded answer.
 *
 * Composes, from the REAL cited nodes (citedNodeIds ∩ graph) and optional
 * deductive path:
 *   - coverage bar + conflict/gap flags (CoverageConflictHeader)
 *   - the deductive hop-path (HopRail) when a path is supplied
 *   - a side-by-side Known vs Conflicting comparison
 *   - the supporting evidence subgraph (EvidenceSubgraph)
 *
 * Grounded-by-construction: every panel is derived from served payloads; nothing
 * is invented. Renders nothing when there are no resolved cited nodes.
 */
import { useMemo } from "react";
import type { ExplanationPath, GraphNode, GraphPayload } from "@rnd/shared";
import { HopRail } from "./HopRail.js";
import {
  CitationChips,
  CoverageConflictHeader,
  EvidenceSubgraph,
} from "./GroundedDiagrams.js";
import { classifyCited, EVIDENCE_TONE } from "../lib/evidence.js";

interface Props {
  /** Real cited nodes (already intersected with the graph). */
  cited: GraphNode[];
  /** Live graph payload — source of the connecting edges for the subgraph. */
  graph: GraphPayload;
  /** Deductive derivation to show as a hop-path (e.g. /api/explain). Optional. */
  path?: ExplanationPath;
  /** Focus a node on the canvas + open its dossier. */
  onFocusNode?: (n: GraphNode) => void;
  /** Show the evidence subgraph (off when the host already renders one). */
  showSubgraph?: boolean;
  title?: string;
}

export function AnswerCanvas({
  cited,
  graph,
  path,
  onFocusNode,
  showSubgraph = true,
  title = "Answer · Known / Missing / Conflicting",
}: Props) {
  const citedSet = useMemo(() => new Set(cited.map((n) => n.id)), [cited]);
  const subEdges = useMemo(
    () => graph.edges.filter((e) => citedSet.has(e.source) && citedSet.has(e.target)),
    [graph.edges, citedSet],
  );
  const { known, conflicting } = useMemo(() => classifyCited(cited), [cited]);
  const citedIds = citedSet;

  if (cited.length === 0) return null;

  return (
    <div
      data-testid="answer-canvas"
      style={{
        background: "var(--frame-surface)",
        color: "var(--frame-text)",
        border: "1px solid var(--frame-border)",
        borderRadius: "var(--radius)",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        minHeight: 0,
      }}
    >
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "var(--frame-text-muted)" }}>
        {title}
      </div>

      <CitationChips cited={cited} onFocusNode={onFocusNode} />
      <CoverageConflictHeader cited={cited} />

      {/* Deductive hop-path — only when a derivation is supplied. */}
      {path && path.hops.length > 0 && (
        <div>
          <div style={subLabel}>Deductive derivation · {path.hops.length} hops</div>
          {/* Explicit inset surface so every hop row sits on the same light card —
              previously rows that overflowed bled onto the dark canvas behind. */}
          <div
            style={{
              maxHeight: 220,
              overflowY: "auto",
              background: "var(--frame-surface-2)",
              border: "1px solid var(--frame-border)",
              borderRadius: 8,
              padding: 6,
            }}
          >
            <HopRail
              path={path}
              activeIndex={-1}
              revealedCount={path.hops.length}
              citedIds={citedIds}
              onHopClick={onFocusNode ?? (() => {})}
              tone="frame"
            />
          </div>
          {/* Legend — disambiguate the ✓ cited flag so un-flagged hops don't read
              as "less important"; they're on-path, just not directly cited. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 6,
              fontSize: 10.5,
              color: "var(--frame-text-muted)",
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 999,
                background: "rgba(63,185,80,.18)",
                color: "#1a7f37",
                border: "1px solid rgba(63,185,80,.5)",
              }}
            >
              ✓ cited
            </span>
            <span>= node the answer grounded on · other hops are on-path, not directly cited</span>
          </div>
        </div>
      )}

      {/* Side-by-side conflict — Known evidence vs Conflicting, when a conflict
          is present. Makes the contradiction legible instead of a single count. */}
      {conflicting.length > 0 && (
        <div>
          <div style={subLabel}>Conflict — side by side</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <ConflictColumn title="Known / supporting" tone={EVIDENCE_TONE.known} nodes={known} onFocusNode={onFocusNode} />
            <ConflictColumn title="Conflicting" tone={EVIDENCE_TONE.conflicting} nodes={conflicting} onFocusNode={onFocusNode} />
          </div>
        </div>
      )}

      {showSubgraph && (
        <div>
          <div style={subLabel}>Supporting subgraph</div>
          <EvidenceSubgraph nodes={cited} edges={subEdges} />
        </div>
      )}
    </div>
  );
}

function ConflictColumn({
  title,
  tone,
  nodes,
  onFocusNode,
}: {
  title: string;
  tone: string;
  nodes: GraphNode[];
  onFocusNode?: (n: GraphNode) => void;
}) {
  return (
    <div
      style={{
        border: `1px solid ${tone}55`,
        borderRadius: 8,
        padding: 8,
        background: `${tone}12`,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: tone, marginBottom: 6 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: tone }} />
        {title}
        <span style={{ color: "var(--frame-text-muted)", fontWeight: 600 }}>{nodes.length}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {nodes.length === 0 ? (
          <span style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>—</span>
        ) : (
          nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={onFocusNode ? () => onFocusNode(n) : undefined}
              disabled={!onFocusNode}
              title={`${n.kind} · ${n.id}`}
              style={{
                textAlign: "left",
                fontSize: 11.5,
                color: "var(--frame-text, #c9d1d9)",
                background: "transparent",
                border: "none",
                borderLeft: `2px solid ${tone}`,
                paddingLeft: 6,
                cursor: onFocusNode ? "pointer" : "default",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {n.label}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

const subLabel: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--frame-text-muted)",
  marginBottom: 5,
};
