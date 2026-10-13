import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTile, applyRefinement, restoreTile, revisionCount, currentBoard, resetGenerative, subscribe, applyBoardMeta, applyComposedBoard } from "./generativeStore.js";
import type { GenerativeBoard } from "@rnd/shared";
import { getSelection, setSelection, subscribeFilter, narrowDatasets } from "./filterStore.js";
import type { FieldMenuEntry, GenerativeDatasets, GenerativeTile } from "@rnd/shared";

/** Tile helper — configurable id + a marker in the skeleton so distinct calls
 *  produce distinct signatures. */
const tile = (id: string, marker: string | number = id): GenerativeTile => ({
  id,
  title: id,
  vlSkeleton: { mark: "bar", data: { name: "cited" }, __marker: marker },
  dataset: "cited",
});

const datasets: GenerativeDatasets = { cited: [{ id: "n1" }], metrics: [], edges: [] };
const fieldMenu: FieldMenuEntry[] = [{ name: "id", vlType: "nominal", cardinality: 1, dataset: "cited" }];

test("same-run streaming deltas accumulate tiles (update-by-id)", () => {
  resetGenerative();
  applyTile(tile("w1"), datasets, fieldMenu, { runId: "r1" });
  applyTile(tile("w1", "w1-v2"), datasets, fieldMenu, { runId: "r1" });
  applyTile(tile("w2"), datasets, fieldMenu, { runId: "r1" });
  const board = currentBoard();
  assert.deepEqual(board.tiles.map((t) => t.id), ["w1", "w2"]);
  // update-by-id: the w1 entry reflects the LATEST delta, not the first.
  assert.deepEqual(board.tiles[0].vlSkeleton.__marker, "w1-v2");
});

test("re-applying an already-applied tile is a cache hit with no notify", () => {
  resetGenerative();
  applyTile(tile("a"), datasets, fieldMenu, { runId: "r1" });
  let hits = 0;
  const off = subscribe(() => { hits++; });
  applyTile(tile("a"), datasets, fieldMenu, { runId: "r1" });
  off();
  assert.equal(hits, 0);
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), ["a"]);
});

test("a NEW runId rolls back to the committed tile set (failed run's partials vanish)", () => {
  resetGenerative();
  // r1 reconciles (final) — [a] is the committed base.
  applyTile(tile("a"), datasets, fieldMenu, { runId: "r1", final: true });
  // r2 streams a partial [p] and never finalizes.
  applyTile(tile("p"), datasets, fieldMenu, { runId: "r2" });
  // r3 streams [c] — partial p is rolled back, committed a is kept.
  applyTile(tile("c"), datasets, fieldMenu, { runId: "r3" });
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), ["a", "c"]);
});

test("a stale re-render of a retired run is dropped without notify", () => {
  resetGenerative();
  applyTile(tile("a"), datasets, fieldMenu, { runId: "r1" });
  applyTile(tile("b"), datasets, fieldMenu, { runId: "r2" });
  let hits = 0;
  const off = subscribe(() => { hits++; });
  // Historical transcript re-render replays r1's delta after r2 took over.
  applyTile(tile("a"), datasets, fieldMenu, { runId: "r1" });
  off();
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), ["b"]); // current board, not a merge
  assert.equal(hits, 0);
});

test("a byte-identical final (sig-cache hit) still commits — the next run keeps the tile", () => {
  resetGenerative();
  // r1 streams delta [t1]...
  const t1 = tile("t1");
  applyTile(t1, datasets, fieldMenu, { runId: "r1" });
  // ...and its FINAL reconcile is byte-identical to the delta → sig-cache hit.
  // It must STILL commit (ported c8f24d7 regression, tile-shaped).
  applyTile(t1, datasets, fieldMenu, { runId: "r1", final: true });
  // The next run rolls back to the committed base — t1 must survive, not be discarded.
  applyTile(tile("t2"), datasets, fieldMenu, { runId: "r2" });
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), ["t1", "t2"]);
});

test("no-runId calls merge legacy-style (no gate)", () => {
  resetGenerative();
  applyTile(tile("a"), datasets, fieldMenu);
  applyTile(tile("b"), datasets, fieldMenu);
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), ["a", "b"]);
});

test("tile cap: 6 tiles max, a new id beyond the cap is ignored", () => {
  resetGenerative();
  for (let i = 1; i <= 8; i++) {
    applyTile(tile(`t${i}`), datasets, fieldMenu, { runId: "r1" });
  }
  const board = currentBoard();
  assert.equal(board.tiles.length, 6);
  assert.deepEqual(board.tiles.map((t) => t.id), ["t1", "t2", "t3", "t4", "t5", "t6"]);
});

// --- Phase 5: refine-a-tile revision history --------------------------------

test("applyRefinement replaces a tile in place and stacks the prior version for restore", () => {
  resetGenerative();
  applyTile(tile("g1", "v1"), datasets, fieldMenu, { runId: "r1" });
  assert.equal(revisionCount("g1"), 0);

  const ok = applyRefinement(tile("g1", "v2"), datasets, fieldMenu);
  assert.equal(ok, true);
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), ["g1"]);
  assert.equal(currentBoard().tiles[0].vlSkeleton.__marker, "v2");
  assert.equal(revisionCount("g1"), 1, "the prior version is now restorable");
});

test("restoreTile walks the most recent refinement back, and reports when nothing remains", () => {
  resetGenerative();
  applyTile(tile("g1", "v1"), datasets, fieldMenu, { runId: "r1" });
  applyRefinement(tile("g1", "v2"), datasets, fieldMenu);
  applyRefinement(tile("g1", "v3"), datasets, fieldMenu);

  assert.equal(restoreTile("g1"), true);
  assert.equal(currentBoard().tiles[0].vlSkeleton.__marker, "v2");
  assert.equal(restoreTile("g1"), true);
  assert.equal(currentBoard().tiles[0].vlSkeleton.__marker, "v1");
  // Nothing left to restore.
  assert.equal(restoreTile("g1"), false);
  assert.equal(revisionCount("g1"), 0);
});

test("applyRefinement on an unknown tile id is a no-op (refine only edits existing tiles)", () => {
  resetGenerative();
  let hits = 0;
  const off = subscribe(() => { hits++; });
  const ok = applyRefinement(tile("ghost"), datasets, fieldMenu);
  off();
  assert.equal(ok, false);
  assert.equal(hits, 0);
  assert.deepEqual(currentBoard().tiles.map((t) => t.id), []);
});

test("resetGenerative clears refine history too", () => {
  resetGenerative();
  applyTile(tile("g1", "v1"), datasets, fieldMenu, { runId: "r1" });
  applyRefinement(tile("g1", "v2"), datasets, fieldMenu);
  assert.equal(revisionCount("g1"), 1);
  resetGenerative();
  assert.equal(revisionCount("g1"), 0);
});

test("applyBoardMeta surfaces the host-owned layout/filters/score on currentBoard", () => {
  resetGenerative();
  applyTile(tile("t1"), datasets, fieldMenu, { runId: "r1", final: true });
  applyBoardMeta({
    layout: "hero-rail",
    filters: [{ field: "kind", dataset: "cited", kind: "dropdown", vlType: "nominal", label: "Kind", options: ["Drug"] }],
    boardScore: 0.82,
    boardRationale: "hero-rail layout · 3 tiles · board score 82%.",
  });
  const board = currentBoard();
  assert.equal(board.layout, "hero-rail");
  assert.equal(board.boardScore, 0.82);
  assert.match(board.boardRationale ?? "", /82%/);
  assert.deepEqual(board.filters?.map((f) => f.field), ["kind"]);
  assert.equal(board.fieldMenu?.length, fieldMenu.length);
});

test("resetGenerative clears board meta too", () => {
  resetGenerative();
  applyBoardMeta({ layout: "bento", boardScore: 0.5 });
  assert.equal(currentBoard().layout, "bento");
  resetGenerative();
  const board = currentBoard();
  assert.equal(board.layout, null);
  assert.equal(board.boardScore, null);
  assert.equal(board.filters, null);
});

test("applyComposedBoard replaces the whole board (tiles + meta) and exposes its cited set", () => {
  resetGenerative();
  // A prior streamed board exists...
  applyTile(tile("old1"), datasets, fieldMenu, { runId: "r1", final: true });
  const board: GenerativeBoard = {
    version: 1,
    source: "llm",
    citedNodeIds: ["nA", "nB"],
    layout: "bento",
    filters: [],
    boardScore: 0.9,
    boardRationale: "bento · 2 tiles",
    tiles: [
      { id: "b1", title: "b1", vlSkeleton: { mark: "arc" }, dataset: "cited", provenance: { nodeIds: ["nA", "nB"], fields: [], rowCount: 2 } },
      { id: "b2", title: "b2", vlSkeleton: { mark: "point" }, dataset: "metrics", provenance: { nodeIds: ["nA"], fields: [], rowCount: 1 } },
    ],
  };
  applyComposedBoard(board, datasets, fieldMenu);
  const now = currentBoard();
  assert.deepEqual(now.tiles.map((t) => t.id), ["b1", "b2"], "the streamed board is fully replaced");
  assert.equal(now.layout, "bento");
  assert.equal(now.boardScore, 0.9);
  assert.deepEqual(now.citedNodeIds.sort(), ["nA", "nB"], "cited set is the union of the tiles' provenance");
  // A subsequent NEW streaming run rolls back to THIS board as its committed base.
  applyTile(tile("c"), datasets, fieldMenu, { runId: "r2" });
  assert.deepEqual(currentBoard().tiles.map((t) => t.id).sort(), ["b1", "b2", "c"], "the composed board is the rollback base, not empty");
});

test("filterStore: setSelection notifies subscribers, null clears the selection", () => {
  setSelection(null);
  let hits = 0;
  const off = subscribeFilter(() => { hits++; });
  setSelection(["n1", "n2"]);
  assert.deepEqual(getSelection(), ["n1", "n2"]);
  assert.equal(hits, 1);
  setSelection(null);
  assert.equal(getSelection(), null);
  assert.equal(hits, 2);
  off();
});

test("narrowDatasets narrows ALL THREE datasets — a cited-only filter left metrics/edges tiles ignoring the selection", () => {
  const datasets: GenerativeDatasets = {
    cited: [{ id: "AE-AFIB" }, { id: "DRUG-BTK" }, { id: "PT-201" }],
    metrics: [
      { nodeId: "AE-AFIB", metric: "prr", value: 5.1 },
      { nodeId: "PT-201", metric: "age", value: 61 },
    ],
    edges: [
      { source: "DRUG-BTK", target: "AE-AFIB", kind: "CAUSES" },
      { source: "PT-201", target: "AE-AFIB", kind: "REPORTS" },
      { source: "PT-202", target: "LIT-1", kind: "CITES" }, // touches neither selected node
    ],
  };

  const out = narrowDatasets(datasets, ["AE-AFIB", "DRUG-BTK"]);
  assert.deepEqual(out.cited.map((r) => r.id), ["AE-AFIB", "DRUG-BTK"]);
  // metrics joins back on nodeId — PT-201's row must drop with it.
  assert.deepEqual(out.metrics.map((r) => r.nodeId), ["AE-AFIB"]);
  // edges keep INCIDENT rows: DRUG-BTK→AE-AFIB is internal, PT-201→AE-AFIB is incident on a
  // selected node, PT-202→LIT-1 touches neither and drops.
  assert.equal(out.edges.length, 2);
  assert.equal(out.edges.some((r) => r.source === "PT-202"), false);
});

test("narrowDatasets on an empty selection returns the datasets BY REFERENCE (no re-embed churn)", () => {
  const datasets: GenerativeDatasets = { cited: [{ id: "a" }], metrics: [], edges: [] };
  assert.equal(narrowDatasets(datasets, null), datasets);
  assert.equal(narrowDatasets(datasets, []), datasets);
});

test("selecting a SINGLE node still leaves its incident edges — an internal-only rule would blank the edges tile", () => {
  const datasets: GenerativeDatasets = {
    cited: [{ id: "AE-AFIB" }],
    metrics: [],
    edges: [{ source: "DRUG-BTK", target: "AE-AFIB", kind: "CAUSES" }],
  };
  assert.equal(narrowDatasets(datasets, ["AE-AFIB"]).edges.length, 1);
});
