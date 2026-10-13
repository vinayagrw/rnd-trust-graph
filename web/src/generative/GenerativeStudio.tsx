/**
 * @rnd/generative — Generative Studio split-view (Task 11).
 *
 * Left pane: the existing `CopilotChatBeat` bound to the "generative" CopilotKit
 * agent (`agentId="generative"`) in `dashboardTarget="pane"` mode — grounded chat;
 * tiles it composes stream into the in-memory `generativeStore` (T8) instead of
 * rendering inline.
 * Right pane: a responsive grid of locked `VegaTile`s (T9) subscribed to that
 * store, cross-filtered by the tiny `filterStore` (T8) — selecting a mark in one
 * tile narrows the `cited` rows fed to every sibling tile (re-embed, v1).
 *
 * This lane is explicitly EXPLORATORY, not certified: the model only ever emits a
 * constrained Vega-Lite encoding skeleton referencing named datasets; the server
 * binds every value from already-cited graph nodes; the client renders it through
 * a locked-down vega-embed runtime (see `VegaTile.tsx`'s lockdown posture). No
 * graph writes, no new answer path — chat stays the existing grounded surface.
 */
import { useEffect, useMemo, useState } from "react";
import type { GraphPayload, GraphNode, GraphEdge, GenerativeDatasets, GenerativeTile, FieldMenuEntry, FilterControl, LayoutArchetype } from "@rnd/shared";
import { CopilotChatBeat } from "../beats/CopilotChatBeat.js";
import { BoardLayout } from "./BoardLayout.js";
import { FilterRail } from "./FilterRail.js";
import { TileLineageDrawer } from "./TileLineageDrawer.js";
import { subscribe, currentBoard, applyRefinement, restoreTile, revisionCount, applyComposedBoard } from "./generativeStore.js";
import { getSelection, setSelection, subscribeFilter, narrowDatasets } from "./filterStore.js";
import { applyControls, getControls, subscribeControls } from "./filterControls.js";
import { requestRefine } from "./refineClient.js";
import { requestMoreDashboards } from "./boardClient.js";

interface Props {
  graph: GraphPayload;
  lightCanvas?: boolean;
  onNodeClick: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge) => void;
  onOpenHitl?: () => void;
  refreshKey?: number;
}

/** Display-only prompt hints (the real submit happens through CopilotChatBeat's
 *  own composer in the left pane). */
const STARTERS = [
  "Chart the cited evidence for the checkpoint-inhibitor myocarditis signal — pick the best marks yourself.",
  "Visualize the relational subgraph behind the myocarditis signal as a chart.",
  "Build a quick exploratory chart of what's known, missing, and conflicting for the myocarditis signal.",
];

export function GenerativeStudio({ graph, lightCanvas, onNodeClick, onEdgeClick, onOpenHitl, refreshKey }: Props) {
  const [tiles, setTiles] = useState<GenerativeTile[]>(() => currentBoard().tiles);
  const [datasets, setDatasets] = useState<GenerativeDatasets | null>(() => currentBoard().datasets);
  const [fieldMenu, setFieldMenu] = useState<FieldMenuEntry[] | null>(() => currentBoard().fieldMenu);
  // HOST-owned board metadata (board mode) — the layout archetype, the derived filter
  // controls, and the "why this board" score/rationale. Null in single-pass mode.
  const [layout, setLayout] = useState<LayoutArchetype | null>(() => currentBoard().layout);
  const [filters, setFilters] = useState<FilterControl[] | null>(() => currentBoard().filters);
  const [boardScore, setBoardScore] = useState<number | null>(() => currentBoard().boardScore);
  const [boardRationale, setBoardRationale] = useState<string | null>(() => currentBoard().boardRationale);
  const [controls, setControlsState] = useState(() => getControls());
  const [selection, setSelectionState] = useState<string[] | null>(() => getSelection());
  const [safetyOpen, setSafetyOpen] = useState(false);
  /** The tile whose lineage drawer is open ("Explain this tile"), by id — held by
   *  id rather than by value so a streaming re-compose of the same tile keeps the
   *  drawer showing the CURRENT tile, not a stale snapshot. */
  const [explainId, setExplainId] = useState<string | null>(null);
  // Pop the tiles canvas out of the split view into a full-viewport overlay
  // (mirrors GraphCanvas's fullscreen: fixed inset:0 + Esc to exit).
  const [isFull, setIsFull] = useState(false);
  /** The tile id with a refine round in flight (one at a time) + a transient note
   *  when a refine returns nothing (the model couldn't express the ask). */
  const [refiningId, setRefiningId] = useState<string | null>(null);
  const [refineNote, setRefineNote] = useState<string | null>(null);
  /** Board mode: true = the orchestrated query-adaptive dashboard (`agentId="board"`) —
   *  picks a layout, derives filters, and ranks candidate charts to build the BEST board
   *  for the question (~1-2 min). This is the DEFAULT experience (the whole point of the
   *  Studio); `⚡ Fast charts` opts down to the single-pass lane (`agentId="generative"`). */
  const [boardMode, setBoardMode] = useState(true);
  /** "Why this board" panel — the deterministic board score + critic rationale, expanded. */
  const [whyOpen, setWhyOpen] = useState(false);
  /** "＋ More dashboards" — a re-compose of ANOTHER grounded board over the current cited
   *  evidence is in flight (the honest answer to "I need more dashboards"). */
  const [moreLoading, setMoreLoading] = useState(false);

  useEffect(() => {
    if (!isFull && !explainId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The drawer sits above the full-screen canvas, so Esc closes it first.
      if (explainId) setExplainId(null);
      else setIsFull(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isFull, explainId]);

  useEffect(() => {
    const off = subscribe(() => {
      const board = currentBoard();
      setTiles(board.tiles);
      setDatasets(board.datasets);
      setFieldMenu(board.fieldMenu);
      setLayout(board.layout);
      setFilters(board.filters);
      setBoardScore(board.boardScore);
      setBoardRationale(board.boardRationale);
    });
    return off;
  }, []);

  // The board's filter rail writes predicate state into `filterControls`; mirror it so
  // the tiles re-narrow. Separate store from the mark-click cross-filter (`filterStore`).
  useEffect(() => subscribeControls(() => setControlsState(getControls())), []);

  useEffect(() => {
    const off = subscribeFilter(() => setSelectionState(getSelection()));
    return off;
  }, []);

  // Cross-filter: a fresh object identity (only on selection change) so every VegaTile's
  // effect re-embeds against the narrowed rows. `narrowDatasets` narrows ALL THREE bound
  // datasets — a cited-only filter left metrics/edges tiles ignoring the selection.
  // Compose the two filter systems: predicate controls (the rail) THEN the id-based
  // cross-filter (a clicked mark). Both narrow by node id, so the result is their
  // intersection — exactly the semantics proven in filterControls.test.ts.
  const filteredDatasets = useMemo<GenerativeDatasets | null>(
    () => (datasets ? narrowDatasets(applyControls(datasets, controls, fieldMenu ?? []), selection) : null),
    [datasets, controls, fieldMenu, selection],
  );

  // Resolve the open drawer's tile from the LIVE board (it may have been re-composed
  // since the drawer opened); a tile that vanished closes the drawer implicitly.
  const explainTile = useMemo(
    () => (explainId ? tiles.find((t) => t.id === explainId) ?? null : null),
    [explainId, tiles],
  );

  const handleSelect = (ids: string[] | null) => {
    setSelection(ids);
    if (ids && ids.length === 1) {
      const node = graph.nodes.find((n) => n.id === ids[0]);
      if (node) onNodeClick(node);
    }
  };

  // Refine one tile by chat: one read-only LLM round on the BFF, then swap the tile
  // in place (recording the prior version for restore). A null result means the model
  // could not express the instruction — the prior tile stands and we say so briefly.
  const handleRefine = async (tile: GenerativeTile, instruction: string) => {
    if (refiningId) return; // one refine at a time
    setRefineNote(null);
    setRefiningId(tile.id);
    try {
      const { tile: refined, datasets: rebound, fieldMenu } = await requestRefine(tile, instruction);
      if (refined) applyRefinement(refined, rebound, fieldMenu);
      else setRefineNote(`Couldn't apply "${instruction.slice(0, 40)}" — the prior chart stands.`);
    } catch {
      setRefineNote("Refine failed to reach the server — the prior chart stands.");
    } finally {
      setRefiningId(null);
    }
  };

  const handleRestore = (tile: GenerativeTile) => {
    restoreTile(tile.id);
    setRefineNote(null);
  };

  // "＋ More dashboards" — the grounded answer to "I need more dashboards" (which the chat
  // correctly refuses as NOT_IN_GRAPH). Re-composes ANOTHER board over the SAME cited
  // evidence, rotated away from the current layout so it's a visibly different view.
  const handleMoreDashboards = async () => {
    if (moreLoading) return;
    const board = currentBoard();
    if (board.citedNodeIds.length === 0) {
      setRefineNote("No evidence yet — ask a grounded question first, then I can build more dashboards of it.");
      return;
    }
    setRefineNote(null);
    setMoreLoading(true);
    try {
      const { board: next, datasets, fieldMenu } = await requestMoreDashboards(board.citedNodeIds, board.layout ?? undefined);
      applyComposedBoard(next, datasets, fieldMenu);
    } catch {
      setRefineNote("Couldn't compose another dashboard — the current one stands.");
    } finally {
      setMoreLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 14, height: "100%", minHeight: 0 }}>
      <div style={{ flex: "0 0 38%", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <CopilotChatBeat
          agentId={boardMode ? "board" : "generative"}
          dashboardTarget="pane"
          graph={graph}
          lightCanvas={lightCanvas}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onOpenHitl={onOpenHitl}
          refreshKey={refreshKey}
        />
      </div>
      <div
        style={
          isFull
            ? {
                position: "fixed",
                inset: 0,
                zIndex: 1000,
                overflowY: "auto",
                padding: 16,
                background: "var(--frame-surface)",
              }
            : { flex: 1, minWidth: 0, overflowY: "auto", border: "1px solid var(--frame-border)", borderRadius: "var(--radius)", padding: 12, background: "var(--frame-surface)" }
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, position: "relative" }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--frame-text-muted)" }}>
            exploratory · not certified
          </span>
          <span style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>
            {tiles.length} tile{tiles.length === 1 ? "" : "s"}
          </span>
          {boardScore != null && (
            // "Why this board" — click to expand the deterministic board score + the critic's
            // rationale (which candidate charts were ranked, coverage/diversity notes). This is
            // how the user SEES the best board being chosen, not just handed one.
            <button
              type="button"
              onClick={() => setWhyOpen((v) => !v)}
              aria-expanded={whyOpen}
              title="Why this board? — the deterministic board score + how it was ranked"
              style={{
                fontSize: 11,
                padding: "1px 7px",
                borderRadius: 999,
                border: "1px solid rgba(46,160,67,.5)",
                background: whyOpen ? "rgba(46,160,67,.18)" : "rgba(46,160,67,.10)",
                color: "var(--frame-text)",
                cursor: "pointer",
              }}
            >
              ★ best board · {Math.round(boardScore * 100)}% {whyOpen ? "▲" : "▼"}
            </button>
          )}
          {tiles.length > 0 && (
            // "＋ More dashboards" — compose ANOTHER grounded board of the same evidence,
            // rotated to a different layout. The honest home for "I need more dashboards".
            <button
              type="button"
              onClick={handleMoreDashboards}
              disabled={moreLoading}
              title="Compose another dashboard of the SAME cited evidence — a different layout and charts"
              style={{
                fontSize: 11,
                padding: "1px 8px",
                borderRadius: 999,
                border: "1px solid rgba(88,166,255,.55)",
                background: moreLoading ? "rgba(88,166,255,.28)" : "rgba(88,166,255,.12)",
                color: "var(--frame-text)",
                cursor: moreLoading ? "progress" : "pointer",
              }}
            >
              {moreLoading ? "composing…" : "＋ More dashboards"}
            </button>
          )}
          {refineNote && (
            <span
              role="status"
              onClick={() => setRefineNote(null)}
              title="Dismiss"
              style={{ fontSize: 10, color: "rgba(217,119,6,0.95)", cursor: "pointer" }}
            >
              {refineNote} ✕
            </span>
          )}
          {selection && selection.length > 0 && (
            // The filter narrows EVERY tile's dataset, so it must be visible and clearable —
            // an invisible cross-filter reads as "the data changed", not "I filtered it".
            <button
              type="button"
              data-testid="generative-filter-chip"
              onClick={() => setSelection(null)}
              title="Clear the cross-filter — every tile returns to the full cited set"
              style={{
                fontSize: 10,
                padding: "1px 7px",
                borderRadius: 999,
                border: "1px solid rgba(88,166,255,.55)",
                background: "rgba(88,166,255,.16)",
                color: "var(--frame-text)",
                cursor: "pointer",
              }}
            >
              filtered to {selection.length} node{selection.length === 1 ? "" : "s"} ✕
            </button>
          )}
          <button
            type="button"
            onClick={() => setBoardMode((v) => !v)}
            aria-pressed={boardMode}
            title={boardMode
              ? "Board mode: the orchestrator composes a query-adaptive dashboard (layout + filters + best-of-N candidates), ~1–2 min per board"
              : "Fast mode: a single-pass set of charts (no layout/filters). Click for the full orchestrated dashboard."}
            style={{
              marginLeft: "auto",
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid var(--frame-border)",
              background: boardMode ? "rgba(46,160,67,.18)" : "transparent",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            {boardMode ? "🧠 Full dashboard" : "⚡ Fast charts"}
          </button>
          <button
            type="button"
            onClick={() => setIsFull((v) => !v)}
            aria-pressed={isFull}
            title={isFull ? "Exit full screen (Esc)" : "Pop the tiles canvas to full screen"}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid var(--frame-border)",
              background: isFull ? "rgba(88,166,255,.16)" : "transparent",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            {isFull ? "⤧ Exit" : "⤢ Full screen"}
          </button>
          <button
            type="button"
            onClick={() => setSafetyOpen((v) => !v)}
            aria-expanded={safetyOpen}
            style={{
              fontSize: 11,
              padding: "3px 8px",
              borderRadius: 6,
              border: "1px solid var(--frame-border)",
              background: safetyOpen ? "rgba(88,166,255,.16)" : "transparent",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            🛡 how this is safe
          </button>
          {safetyOpen && (
            <div
              role="dialog"
              style={{
                position: "absolute",
                top: "calc(100% + 6px)",
                right: 0,
                width: 320,
                zIndex: 50,
                background: "var(--frame-surface)",
                color: "var(--frame-text)",
                border: "1px solid var(--frame-border)",
                borderRadius: 10,
                boxShadow: "0 12px 32px rgba(0,0,0,.35)",
                padding: 12,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              The model only ever emits a constrained Vega-Lite encoding skeleton that references
              a named dataset — it never emits data values. The server binds every value from
              already-cited graph nodes and edges, so a tile can only ever chart evidence already
              grounded in this conversation. The client then renders that skeleton through a
              locked-down vega-embed runtime (AST-only interpreter, canvas renderer, no export/
              view-source actions, and a deny-all loader that blocks every external I/O
              primitive) — nothing in this lane can reach outside the page.
            </div>
          )}
        </div>

        {whyOpen && boardScore != null && (
          // The expanded "why this board" — archetype, score, and the critic's own notes.
          <div
            style={{
              marginBottom: 10,
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid rgba(46,160,67,.35)",
              background: "rgba(46,160,67,.07)",
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--frame-text)",
            }}
          >
            <strong>Why this board?</strong> The server planned a <em>{layout ?? "grid"}</em> layout, then
            composed each tile by ranking candidate chart shapes and keeping the highest-scoring, most
            distinct one — this board scored {Math.round(boardScore * 100)}% overall.
            {boardRationale ? <div style={{ marginTop: 4, opacity: 0.85 }}>{boardRationale}</div> : null}
          </div>
        )}

        {tiles.length === 0 || !filteredDatasets ? (
          <div style={{ color: "var(--frame-text-muted)", fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>
              {boardMode
                ? "✨ Ask a question — I'll compose the best query-adaptive dashboard for it."
                : "✨ Ask to chart your first tile."}
            </div>
            {boardMode && (
              <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                Board mode picks a layout, derives filter controls, and ranks candidate charts to build
                the best board for your question — it composes tile-by-tile over ~1–2 min. Prefer speed?
                Switch to <strong>⚡ Fast charts</strong>.
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {STARTERS.map((s) => (
                <div key={s} style={{ fontSize: 12, opacity: 0.8 }}>· {s}</div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            {filters && filters.length > 0 && (
              <div style={{ flex: "0 0 200px", minWidth: 0, position: "sticky", top: 0 }}>
                <FilterRail filters={filters} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <BoardLayout
                tiles={tiles}
                datasets={filteredDatasets}
                archetype={layout}
                onSelect={handleSelect}
                onExplain={(tile) => setExplainId(tile.id)}
                onRefine={handleRefine}
                onRestore={handleRestore}
                restorableFor={revisionCount}
                refiningId={refiningId}
              />
            </div>
          </div>
        )}
      </div>

      {explainTile && filteredDatasets && (
        <TileLineageDrawer
          tile={explainTile}
          datasets={filteredDatasets}
          onClose={() => setExplainId(null)}
        />
      )}
    </div>
  );
}
