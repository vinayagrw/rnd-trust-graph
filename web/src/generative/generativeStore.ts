/**
 * @rnd/web — run-gated tile store for the Generative Studio lane (Task 8).
 *
 * Single surface (Generative Studio only), tiles keyed by id, **in-memory only**
 * (no sessionStorage/persist/rehydrate — unlike `dashboards/lineageStore.ts`, a
 * generative board is exploratory scratch work, not worth surviving a reload).
 *
 * The run-generation GATE is ported faithfully from `web/src/dashboards/lineageStore.ts`
 * `applyIncoming` (steps 1–5), adapted to per-tile deltas instead of whole-spec merges:
 *
 *   1. Run gate (only when the call carries a runId) — same run falls through; a
 *      RETIRED run (seen before, no longer current) is dropped outright (no merge,
 *      no notify); a genuinely NEW run rolls `tiles` back to `committed` (a failed
 *      run's uncommitted partial tiles must not survive into the retry) and clears
 *      the sig cache so a byte-identical delta re-merges from the rolled-back base.
 *   2. Sig cache (`applied`, bounded) — a re-render of an already-applied tile is an
 *      O(1) hit: no re-merge, no notify. **Exception (ported from commit c8f24d7):**
 *      a cache hit that carries `final` still marks the commit point — a run whose
 *      final reconcile is byte-identical to one of its own deltas must not lose its
 *      commit — so it commits the board AS IT STANDS and returns without notifying
 *      (the board itself is unchanged).
 *   3. Merge — `tiles.set(tile.id, tile)`, capped at 6 tiles: a brand-new id beyond
 *      the cap is silently ignored (an existing id may still update in place).
 *   4. Commit point — `final` promotes the current tile map to `committed`, the next
 *      run's rollback base.
 *   5. Bounded cache write + notify.
 *
 * Calls without a `runId` (back-compat / template boards) skip the gate entirely and
 * merge exactly as before — same as `lineageStore`'s no-runId path.
 */
import type { FieldMenuEntry, FilterControl, GenerativeBoard, GenerativeDatasets, GenerativeTile, LayoutArchetype } from "@rnd/shared";

const MAX_TILES = 6;
const MAX_SEEN_RUNS = 100;
const MAX_APPLIED = 64;

/** How many prior versions of a tile the refine lane keeps — enough to walk back a
 *  few missteps ("log scale" → "no, top 5" → "actually restore") without unbounded growth. */
const MAX_REVISIONS = 10;

interface GenerativeState {
  tiles: Map<string, GenerativeTile>;
  /** Board as of the last FINAL reconcile — the rollback base when a new run starts. */
  committed: Map<string, GenerativeTile>;
  /** Per-tile refine history (Phase 5): each successful refine pushes the PRIOR tile
   *  here so `restoreTile` can walk it back. Independent of the run gate/commit logic. */
  revisions: Map<string, GenerativeTile[]>;
  datasets: GenerativeDatasets | null;
  fieldMenu: FieldMenuEntry[] | null;
  /** HOST-owned board metadata from the final `generative` reconcile (board mode).
   *  Carried separately from tiles so a streamed delta never has to know the layout. */
  layout: LayoutArchetype | null;
  filters: FilterControl[] | null;
  boardScore: number | null;
  boardRationale: string | null;
  /** The active generative run; deltas from retired runs are stale and dropped. */
  runId: string | null;
  /** Every run id ever seen (bounded) — distinguishes a genuinely NEW run (roll back
   *  to committed) from a STALE re-render of a retired run (drop). */
  seenRuns: Set<string>;
  /** sig → already-merged marker (bounded) — kills O(N²) re-merge churn from replayed
   *  tool-call history. */
  applied: Set<string>;
}

function freshState(): GenerativeState {
  return {
    tiles: new Map(),
    committed: new Map(),
    revisions: new Map(),
    datasets: null,
    fieldMenu: null,
    layout: null,
    filters: null,
    boardScore: null,
    boardRationale: null,
    runId: null,
    seenRuns: new Set(),
    applied: new Set(),
  };
}

let state: GenerativeState = freshState();
const listeners = new Set<() => void>();

/** A stable content signature for an incoming tile (order-sensitive is fine — the
 *  compiler/template emit deterministic key order). */
function signature(tile: GenerativeTile): string {
  return JSON.stringify(tile);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to board changes. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Apply one incoming tile delta (or a template board's tile, one call per tile) to
 *  the active lineage. `meta` carries the transport-channel run metadata (`runId`,
 *  `final`) — optional, so callers without it (back-compat) merge exactly as before. */
export function applyTile(
  tile: GenerativeTile,
  datasets: GenerativeDatasets,
  fieldMenu: FieldMenuEntry[],
  meta?: { runId?: string; final?: boolean },
): void {
  // 1. Run gate (only when the call carries a runId).
  if (meta?.runId) {
    if (meta.runId === state.runId) {
      // Same run — fall through to the normal merge.
    } else if (state.seenRuns.has(meta.runId)) {
      // Stale re-render of a RETIRED run — drop: no merge, no notify.
      return;
    } else {
      // Genuinely NEW run: roll back to the committed base so a failed run's
      // uncommitted partials never survive into this run's merge.
      state.seenRuns.add(meta.runId);
      if (state.seenRuns.size > MAX_SEEN_RUNS) {
        const oldest = state.seenRuns.values().next().value;
        if (oldest !== undefined) state.seenRuns.delete(oldest);
      }
      state.runId = meta.runId;
      state.tiles = new Map(state.committed);
      // A byte-identical delta from the NEW run must re-merge from the rolled-back
      // base, not hit a stale cache entry.
      state.applied.clear();
    }
  }

  // 2. Sig cache — an already-applied tile is an O(1) hit (no re-merge, no notify).
  const sig = signature(tile);
  if (state.applied.has(sig)) {
    if (meta?.final) {
      // A final that is byte-identical to an already-applied delta of the SAME run
      // still marks the commit point — a run whose final reconcile matches one of
      // its own deltas must not lose its commit. Commit the board AS IT STANDS.
      state.committed = new Map(state.tiles);
    }
    return;
  }

  // 3. Merge — cap 6 tiles; a brand-new id beyond the cap is ignored (an existing
  //    id may still update in place).
  if (state.tiles.has(tile.id) || state.tiles.size < MAX_TILES) {
    state.tiles.set(tile.id, tile);
  }
  state.datasets = datasets;
  state.fieldMenu = fieldMenu;

  // 4. Commit point — the run's final reconcile becomes the next rollback base.
  if (meta?.final) state.committed = new Map(state.tiles);

  // 5. Bounded cache write, notify.
  if (state.applied.size >= MAX_APPLIED) {
    const oldest = state.applied.values().next().value;
    if (oldest !== undefined) state.applied.delete(oldest);
  }
  state.applied.add(sig);
  notify();
}

/**
 * Apply a REFINED tile (Phase 5) in place: push the tile currently at `next.id` onto
 * that tile's revision stack, then replace it. Returns false (no-op) if `next.id` is
 * not on the board — a refine only ever edits an existing tile, never adds one.
 *
 * Distinct from `applyTile`: refine bypasses the run gate/sig-cache entirely (it is a
 * user-initiated in-place edit of a settled board, not a streamed run delta) and it is
 * what maintains `revisions`. The refreshed `datasets`/`fieldMenu` (re-bound from the
 * tile's own cited set) are stored so every sibling tile keeps rendering.
 */
export function applyRefinement(
  next: GenerativeTile,
  datasets: GenerativeDatasets,
  fieldMenu: FieldMenuEntry[],
): boolean {
  const prior = state.tiles.get(next.id);
  if (!prior) return false;

  const stack = state.revisions.get(next.id) ?? [];
  stack.push(prior);
  if (stack.length > MAX_REVISIONS) stack.shift();
  state.revisions.set(next.id, stack);

  state.tiles.set(next.id, next);
  state.datasets = datasets;
  state.fieldMenu = fieldMenu;
  notify();
  return true;
}

/** Walk one refinement back: pop the most recent prior version of `tileId` and make it
 *  current again. Returns false when there is nothing to restore. */
export function restoreTile(tileId: string): boolean {
  const stack = state.revisions.get(tileId);
  if (!stack || stack.length === 0) return false;
  const prior = stack.pop()!;
  state.tiles.set(tileId, prior);
  notify();
  return true;
}

/** How many prior versions of a tile are available to restore (0 = none). Drives the
 *  "↩ Restore (n)" affordance so it only shows when a walk-back is possible. */
export function revisionCount(tileId: string): number {
  return state.revisions.get(tileId)?.length ?? 0;
}

/**
 * Apply the HOST-owned board metadata from the final `generative` reconcile (board
 * mode): the layout archetype, the derived filter controls, and the board score +
 * rationale. Separate from `applyTile` — tiles stream without knowing the layout, and
 * this lands once, on the final board, without touching the run gate. Notifies so the
 * Studio re-lays-out and mounts the filter rail.
 */
export function applyBoardMeta(meta: {
  layout?: LayoutArchetype;
  filters?: FilterControl[];
  boardScore?: number;
  boardRationale?: string;
}): void {
  // Assign UNCONDITIONALLY (undefined → null). This lands once per final reconcile
  // carrying the WHOLE board's meta, so a single-pass run (`compose=generative`), which
  // has no layout/filters/score, must CLEAR the previous board-mode meta — otherwise the
  // old board's filter rail + score stay mounted over the new fast-mode tiles.
  state.layout = meta.layout ?? null;
  state.filters = meta.filters ?? null;
  state.boardScore = meta.boardScore ?? null;
  state.boardRationale = meta.boardRationale ?? null;
  notify();
}

/**
 * Replace the whole board with one composed OUT OF BAND (the "More dashboards" REST
 * lane — `boardClient.requestMoreDashboards`), not streamed through the run gate. Sets
 * tiles + datasets + host-owned meta in one shot and makes it the committed base, so a
 * later streaming run rolls back to THIS board (not an empty one). Notifies once.
 */
export function applyComposedBoard(board: GenerativeBoard, datasets: GenerativeDatasets, fieldMenu: FieldMenuEntry[]): void {
  const tiles = new Map<string, GenerativeTile>();
  for (const t of board.tiles.slice(0, MAX_TILES)) tiles.set(t.id, t);
  state.tiles = tiles;
  state.committed = new Map(tiles);
  state.datasets = datasets;
  state.fieldMenu = fieldMenu;
  state.layout = board.layout ?? null;
  state.filters = board.filters ?? null;
  state.boardScore = board.boardScore ?? null;
  state.boardRationale = board.boardRationale ?? null;
  // A fresh externally-composed board: clear the run/sig gates so a subsequent streaming
  // run treats this as its rollback base and re-merges cleanly.
  state.runId = null;
  state.applied = new Set();
  notify();
}

/** Read the current generative board (Studio pane pulls this on notify). */
export function currentBoard(): {
  tiles: GenerativeTile[];
  datasets: GenerativeDatasets | null;
  fieldMenu: FieldMenuEntry[] | null;
  layout: LayoutArchetype | null;
  filters: FilterControl[] | null;
  boardScore: number | null;
  boardRationale: string | null;
  /** The cited evidence behind the current board (union of the tiles' provenance) —
   *  the exact set the "More dashboards" lane re-visualizes. */
  citedNodeIds: string[];
} {
  const tiles = Array.from(state.tiles.values());
  const cited = new Set<string>();
  for (const t of tiles) for (const id of t.provenance?.nodeIds ?? []) cited.add(id);
  return {
    tiles,
    datasets: state.datasets,
    fieldMenu: state.fieldMenu,
    layout: state.layout,
    filters: state.filters,
    boardScore: state.boardScore,
    boardRationale: state.boardRationale,
    citedNodeIds: [...cited],
  };
}

/** Reset the generative lineage (e.g. when the conversation thread changes / on
 *  beat-leave). In-memory only — no storage to clear. */
export function resetGenerative(): void {
  state = freshState();
  notify();
}
