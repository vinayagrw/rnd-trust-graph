/**
 * Beat 3 — multimodal resolve. Click the pathology-image or omics node; its
 * pre-computed embedding resolves (real Neo4j vector kNN) to the ontology
 * concept the explanation path already traverses. "Graph over multimodal data,
 * not just structured records."
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphPayload, GraphNode, GraphEdge, ResolveResult, RiskReport } from "@rnd/shared";
import { api } from "../api.js";
import { GraphCanvas } from "../components/GraphCanvas.js";
import { FiltersRail } from "../components/FiltersRail.js";
import { FiltersPopover } from "../components/FiltersPopover.js";
import { verifiedNodeIds, lowConfidenceIds } from "../lib/trust.js";
import { applyFilters, EMPTY_FILTERS, type GraphFilters } from "../lib/filterGraph.js";

export function MultimodalBeat({
  onNodeClick,
  onEdgeClick,
  lightCanvas,
  refreshKey,
}: {
  onNodeClick: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge) => void;
  lightCanvas?: boolean;
  /** Bumped by App after a governed HITL apply/revert (or manual flag) so this
   *  beat refetches the graph + /api/risk (trust lens stays live). */
  refreshKey?: number;
}) {
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] });
  const [report, setReport] = useState<RiskReport>();
  const [result, setResult] = useState<ResolveResult>();
  const [busy, setBusy] = useState(false);
  // Last-click-wins guard: each resolve gets a sequence number; a slower earlier
  // response is ignored if a newer click has since fired (and so is any response
  // that lands after unmount), preventing out-of-order results.
  const resolveSeq = useRef(0);

  useEffect(() => {
    api.graph("hero").then(setGraph).catch(() => {});
    api.risk().then(setReport).catch(() => {}); // readiness drives the low-confidence halo
    return () => {
      resolveSeq.current += 1; // invalidate any in-flight resolve on unmount
    };
  }, [refreshKey]);

  async function handleClick(node: GraphNode) {
    if (node.kind === "PathologyImage" || node.kind === "OmicsProfile") {
      const seq = ++resolveSeq.current;
      setBusy(true);
      try {
        const res = await api.resolve(node.id);
        if (seq !== resolveSeq.current) return; // a newer click (or unmount) superseded this one
        setResult(res);
      } finally {
        if (seq === resolveSeq.current) setBusy(false);
      }
    } else {
      onNodeClick(node);
    }
  }

  const top = result?.matches[0];
  const active = useMemo(() => {
    if (!result || !top) return new Set<string>();
    return new Set([result.sourceNodeId, top.concept.id]);
  }, [result, top]);

  // Trust lens + filters (derived purely from served payloads). The resolve
  // highlight (`active`) is kept regardless so a filter can't hide a match.
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
  const shown = useMemo(
    () => applyFilters(graph, filters, readiness, verified, flaggedSet, active),
    [graph, filters, readiness, verified, flaggedSet, active],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
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
            onNodeClick={handleClick}
            onEdgeClick={onEdgeClick}
            height={500}
          />
        </div>
      </div>
      <div style={{ padding: "10px 12px", color: "var(--canvas-text)", fontSize: 13 }}>
        {!result && (
          <span style={{ opacity: 0.8 }}>
            Click the <b style={{ color: "#ff7b72" }}>pathology image</b> or{" "}
            <b style={{ color: "#a5d6ff" }}>omics</b> node to resolve it into the graph.
          </span>
        )}
        {busy && <span> resolving…</span>}
        {top && (
          <div>
            <strong>{result!.sourceNodeId}</strong> → <strong>{top.concept.label}</strong>{" "}
            <span style={{ opacity: 0.7 }}>(cosine {top.score.toFixed(3)})</span>{" "}
            {top.onPath && <span className="badge-live">✓ on the explanation path</span>}
            {result!.matches.length > 1 && (
              <div style={{ marginTop: 4, opacity: 0.75 }}>
                Runners-up it did <i>not</i> pick:{" "}
                {result!.matches
                  .slice(1, 4)
                  .map((m) => `${m.concept.label} (${m.score.toFixed(3)})`)
                  .join(" · ")}
              </div>
            )}
            <div style={{ marginTop: 4, opacity: 0.7 }}>
              Real kNN over Neo4j&rsquo;s native vector index — embeddings pre-computed offline,
              retrieval live. The ranked alternatives show this is similarity, not a lookup table.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
