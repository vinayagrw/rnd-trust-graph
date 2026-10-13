/**
 * Beat 2 — the hero. Reveals the deterministic explanation path hop by hop.
 * Scripted mode auto-advances; live mode lets the presenter step + streams a
 * live narration (with cached fallback handled by the BFF).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ExplanationPath, GraphPayload, GraphNode, GraphEdge, RiskReport, FallbackReason } from "@rnd/shared";
import { GraphCanvas } from "../components/GraphCanvas.js";
import { HopRail } from "../components/HopRail.js";
import { ProvenanceStrip } from "../components/ProvenanceStrip.js";
import { FiltersRail } from "../components/FiltersRail.js";
import { FiltersPopover } from "../components/FiltersPopover.js";
import { AnswerCanvas } from "../components/AnswerCanvas.js";
import { api, stream } from "../api.js";
import { Button } from "../components/ui/button.js";
import { verifiedNodeIds, lowConfidenceIds } from "../lib/trust.js";
import { resolveCited } from "../lib/evidence.js";
import { applyFilters, isNoopFilter, EMPTY_FILTERS, type GraphFilters } from "../lib/filterGraph.js";

/** Presenter-friendly cause shown next to the "offline narration" badge. */
const REASON_LABEL: Record<FallbackReason, string> = {
  disabled: "live mode off",
  "spawn-failed": "claude CLI not found",
  "not-authenticated": "claude not logged in",
  "no-tools": "MCP tools unavailable",
  timeout: "live timed out",
  "empty-output": "no live output",
  ungrounded: "refused (off-path)",
  "api-error": "live call failed",
};

interface Props {
  graph: GraphPayload;
  path: ExplanationPath;
  mode: "scripted" | "live";
  liveMode: boolean;
  lightCanvas?: boolean;
  /** Bumped by App after a governed HITL apply/revert (or manual flag) so this
   *  beat refetches /api/risk — otherwise its trust lens (flag stamps + verified
   *  stamp) would stay frozen at the value fetched once on mount. */
  refreshKey?: number;
  onNodeClick: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge) => void;
}

/** Offline scripted narration assembled from the path (always available). */
function scriptedNarration(path: ExplanationPath, upto: number): string {
  const labels = path.hops.slice(0, upto).map((h) => h.node.label);
  if (labels.length === 0) return "";
  if (labels.length === 1) return `Starting from ${labels[0]}…`;
  return `${labels.join(" → ")}. A graph-validated, multi-hop path back to source evidence.`;
}

const reduceMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function ExplanationBeat({ graph, path, mode, liveMode, lightCanvas, refreshKey, onNodeClick, onEdgeClick }: Props) {
  const [count, setCount] = useState(1); // revealed hops
  const [paused, setPaused] = useState(false); // presenter can halt autoplay
  // Opt-in autoplay for LIVE mode: scripted mode auto-advances on its own, but in
  // the default live mode Beat 2 otherwise sits at hop 1 until the presenter steps.
  // Default OFF; honours prefers-reduced-motion (no autoplay when reduce is set).
  const [autoplay, setAutoplay] = useState(false);
  const [narration, setNarration] = useState("");
  const [isFallback, setIsFallback] = useState(false);
  // Why live degraded to scripted (timeout / not-authenticated / …), so the room
  // sees the cause next to the "offline narration" badge instead of a silent drop.
  const [fallbackReason, setFallbackReason] = useState<FallbackReason | undefined>();
  const [citedIds, setCitedIds] = useState<Set<string>>(new Set());
  // Reasoning-upfront staging: when the full path is reached in live mode we
  // first show the computed path with the narrator OFF for a brief beat, THEN
  // start the /narrate stream. `narrationStarted` flips once the stream begins.
  const [narrationStarted, setNarrationStarted] = useState(false);
  const cancelRef = useRef<null | (() => void)>(null);

  const revealed = useMemo(
    () => new Set(path.hops.slice(0, count).map((h) => h.node.id)),
    [path, count]
  );
  const active = useMemo(() => {
    const cur = path.hops[count - 1];
    return cur ? new Set([cur.node.id]) : new Set<string>();
  }, [path, count]);

  // Trust lens + filters. Readiness drives the low-confidence halo; the hero
  // path's nodes are ALWAYS kept so filtering can never break the hop reveal.
  const [report, setReport] = useState<RiskReport>();
  useEffect(() => {
    api.risk().then(setReport).catch(() => {});
  }, [refreshKey]);
  const [filters, setFilters] = useState<GraphFilters>(() => ({ ...EMPTY_FILTERS, kinds: new Set() }));
  const readiness = useMemo(
    () => new Map(report?.findings.map((f) => [f.nodeId, f.readiness]) ?? []),
    [report],
  );
  // Verified (green check) = HUMAN_APPROVED edges in the graph ∪ nodes a reviewer
  // approved a governed change about (report.humanReviewed) — so approving ANY
  // governed item marks the node, not only edge-adding approvals.
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
  const pathIds = useMemo(() => new Set(path.hops.map((h) => h.node.id)), [path]);
  const shown = useMemo(
    () => applyFilters(graph, filters, readiness, verified, flaggedSet, pathIds),
    [graph, filters, readiness, verified, flaggedSet, pathIds],
  );

  // Auto-advance — runs in scripted mode (always), and in live mode only when the
  // presenter opts into Autoplay. Never autoplay when the OS asks for reduced
  // motion (presenter then drives with Next/Back). Honours P1 a11y guidance.
  useEffect(() => {
    const autoEnabled = mode === "scripted" || (mode === "live" && autoplay);
    if (!autoEnabled || reduceMotion() || paused) return;
    if (count >= path.hops.length) return;
    const t = setTimeout(() => setCount((c) => Math.min(c + 1, path.hops.length)), 1600);
    return () => clearTimeout(t);
  }, [mode, autoplay, count, path.hops.length, paused]);

  // Narration: live stream when the full path is revealed in live mode; else scripted.
  // Reasoning-upfront: in live mode we hold a short beat after full reveal —
  // "here's what the graph computed" — before kicking the /narrate stream.
  useEffect(() => {
    const done = count >= path.hops.length;
    if (!done) {
      setNarration(scriptedNarration(path, count));
      setIsFallback(false);
      setFallbackReason(undefined);
      setNarrationStarted(false);
      return;
    }
    if (mode === "live" && liveMode) {
      let acc = "";
      setNarration("");
      setCitedIds(new Set());
      setNarrationStarted(false);
      cancelRef.current?.();

      const startNarration = () => {
        setNarrationStarted(true);
        cancelRef.current = stream(
          "/narrate",
          { beatId: path.pathId, pathId: path.pathId },
          (e) => {
            if (e.type === "token") setNarration((acc += e.text));
            else if (e.type === "citations") setCitedIds(new Set(e.nodeIds));
            else if (e.type === "done") {
              setIsFallback(e.isFallback);
              setFallbackReason(e.isFallback ? e.reason : undefined);
            } else if (e.type === "error") {
              setNarration(scriptedNarration(path, count));
              setIsFallback(true);
              setFallbackReason(undefined);
            }
          }
        );
      };

      // Honour reduced-motion: skip the artificial staging delay.
      const delay = reduceMotion() ? 0 : 900;
      const t = setTimeout(startNarration, delay);
      return () => {
        clearTimeout(t);
        cancelRef.current?.();
      };
    } else {
      setNarration(scriptedNarration(path, count));
      setIsFallback(false);
      setFallbackReason(undefined);
      setCitedIds(new Set());
      setNarrationStarted(false);
    }
    return () => cancelRef.current?.();
  }, [count, mode, liveMode, path]);

  const done = count >= path.hops.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <FiltersPopover>
          <FiltersRail graph={graph} filters={filters} onChange={setFilters} visibleCount={shown.nodes.length} />
        </FiltersPopover>
        <div style={{ flex: 1, minWidth: 0 }}>
          <GraphCanvas
            graph={shown}
            /* The scripted-walk reveal-dim (non-revealed nodes → 18% alpha) is a
               feature of the narration, not the Filters lens. Once a filter is
               engaged, applyFilters has already chosen what to show, so dimming a
               filtered-in node (e.g. a Flagged-only node that isn't on the
               reasoning path) would render it nearly invisible. Suppress reveal-
               dimming whenever a filter is active so survivors paint at full alpha. */
            revealed={isNoopFilter(filters) ? revealed : undefined}
            active={active}
            pathNodes={revealed}
            readiness={readiness}
            verified={verified}
            lowConfidence={lowConfidence}
            flagged={flaggedSet}
            searchable
            lightCanvas={lightCanvas}
            filtersSlot={<FiltersRail graph={graph} filters={filters} onChange={setFilters} visibleCount={shown.nodes.length} />}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            height={430}
          />
        </div>
      </div>
      <div style={{ padding: "10px 12px", color: "var(--canvas-text)" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
          <Button
            variant="control"
            size="brand"
            onClick={() => setCount((c) => Math.max(1, c - 1))}
            disabled={count <= 1}
          >
            ‹ Back
          </Button>
          <Button
            variant="control"
            size="brand"
            onClick={() => setCount((c) => Math.min(c + 1, path.hops.length))}
            disabled={done}
          >
            Next hop ›
          </Button>
          {mode === "scripted" && !reduceMotion() && (
            <Button
              variant="control"
              size="brand"
              onClick={() => setPaused((p) => !p)}
              disabled={done}
              title="Halt / resume auto-advance"
            >
              {paused ? "▶ Play" : "⏸ Pause"}
            </Button>
          )}
          {mode === "live" && !reduceMotion() && (
            <Button
              variant="control"
              size="brand"
              onClick={() => setAutoplay((a) => !a)}
              title="Auto-advance the hops in live mode (off by default)"
            >
              {autoplay ? "⏸ Autoplay on" : "▶ Autoplay"}
            </Button>
          )}
          <Button
            variant="control"
            size="brand"
            onClick={() => setCount(path.hops.length)}
            disabled={done}
            title="Jump to the final evidence node"
          >
            Skip to answer ⤓
          </Button>
          <Button variant="control" size="brand" onClick={() => { setCount(1); setPaused(false); }}>
            ⟲ Replay hero path
          </Button>
          {/* "You are here" step indicator — prominent, presenter-facing. */}
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: "2px 10px",
              borderRadius: 999,
              background: "var(--canvas-surface)",
              border: "1px solid var(--canvas-border)",
            }}
          >
            Hop {count} of {path.hops.length}
          </span>
          {isFallback && (
            <span
              className="badge-fallback"
              title={
                fallbackReason
                  ? `Live degraded to scripted: ${REASON_LABEL[fallbackReason]}. Click "Mode: live" to retry.`
                  : "Showing scripted narration."
              }
            >
              offline narration{fallbackReason ? ` · ${REASON_LABEL[fallbackReason]}` : ""}
            </span>
          )}
          {!isFallback && citedIds.size > 0 && (
            <span
              title="Every entity the narration names is one of these on-path nodes — enforced, not just requested."
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "2px 8px",
                borderRadius: 999,
                background: "rgba(63,185,80,.16)",
                color: "#56d364",
                border: "1px solid rgba(63,185,80,.5)",
              }}
            >
              ✓ grounded in {citedIds.size} on-path node{citedIds.size === 1 ? "" : "s"}
            </span>
          )}
        </div>
        {/* Always-on provenance for the ACTIVE hop — the regulatory "where did
            this come from" answer without a click. Updates as the presenter steps;
            the click-drawer still opens full detail. */}
        <ProvenanceStrip node={path.hops[count - 1]?.node} />
        {/* Inference trace — why the rule fires. Explainability only (no live OWL
            reasoner): the structural pattern that makes this a deductive,
            auto-accepted conclusion. */}
        {path.deductive && (
          <div
            title="Structural graph pattern — a path-exists fact, so it auto-accepts without human review."
            style={{
              margin: "6px 0 2px",
              fontSize: 12,
              color: "var(--canvas-text-muted, #9aa4b2)",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span aria-hidden>⚙</span>
            <span>
              Drug <b>TARGETS</b> Target ∧ Target <b>IN_PATHWAY</b> Pathway ⟹ candidate signal —
              structural, auto-accepted.
            </span>
          </div>
        )}
        {/* Reasoning-upfront: the full computed path is listed here before (and
            while) it's narrated — the hero becomes an auditable object, not just
            an animation. Rail highlights in lockstep with the canvas. */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(240px, 320px)",
            gap: 14,
            alignItems: "start",
          }}
        >
          <div style={{ margin: 0, minHeight: 40 }}>
            {done && mode === "live" && liveMode && !narrationStarted ? (
              <span
                style={{
                  fontSize: 13,
                  fontStyle: "italic",
                  color: "var(--canvas-text-muted, #9aa4b2)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
                title="The full deterministic path is computed and shown above — narration starts in a beat."
              >
                <span aria-hidden>◴</span> Reasoning computed — narrating…
              </span>
            ) : (
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{narration}</p>
            )}
          </div>
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            <HopRail
              path={path}
              activeIndex={count - 1}
              revealedCount={count}
              citedIds={citedIds}
              onHopClick={onNodeClick}
            />
          </div>
        </div>
        {/* KMC answer canvas for the hero answer — coverage + side-by-side
            conflict + supporting subgraph, from the nodes the narration cited. */}
        {citedIds.size > 0 && (
          <div style={{ marginTop: 12 }}>
            <AnswerCanvas
              cited={resolveCited(Array.from(citedIds), graph)}
              graph={graph}
              path={path}
              onFocusNode={onNodeClick}
            />
          </div>
        )}
      </div>
    </div>
  );
}
