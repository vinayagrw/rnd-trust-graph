import test from "node:test";
import assert from "node:assert/strict";
import type { FieldMenuEntry } from "@rnd/shared";
import { templateBoard } from "./templates.js";

const fieldMenu: FieldMenuEntry[] = [
  { name: "kind", vlType: "nominal", cardinality: 2, dataset: "cited" },
  { name: "label", vlType: "nominal", cardinality: 3, dataset: "cited" },
  { name: "degree", vlType: "quantitative", cardinality: 2, dataset: "cited" },
  { name: "flagged", vlType: "nominal", cardinality: 2, dataset: "cited" },
];
const citedNodeIds = ["n1", "n2", "n3"];

test("non-empty menu -> 2 tiles: count-by-kind bar + top-degree bar, ids tmpl-kind/tmpl-degree", () => {
  const board = templateBoard(citedNodeIds, fieldMenu);
  assert.equal(board.version, 1);
  assert.equal(board.source, "template");
  assert.deepEqual(board.citedNodeIds, citedNodeIds);
  assert.equal(board.tiles.length, 2);
  assert.deepEqual(board.tiles.map((t) => t.id), ["tmpl-kind", "tmpl-degree"]);
});

test("each tile's vlSkeleton.data names the cited dataset", () => {
  const board = templateBoard(citedNodeIds, fieldMenu);
  for (const tile of board.tiles) {
    assert.deepEqual(tile.vlSkeleton.data, { name: "cited" });
    assert.equal(tile.dataset, "cited");
  }
});

test("tmpl-kind tile is a bar count-by-kind", () => {
  const board = templateBoard(citedNodeIds, fieldMenu);
  const tile = board.tiles.find((t) => t.id === "tmpl-kind")!;
  assert.equal(tile.vlSkeleton.mark, "bar");
  assert.deepEqual(tile.vlSkeleton.encoding, {
    x: { field: "kind", type: "nominal" },
    y: { aggregate: "count" },
    color: { field: "kind", type: "nominal" },
  });
});

test("tmpl-degree tile is a bar of most-connected cited nodes", () => {
  const board = templateBoard(citedNodeIds, fieldMenu);
  const tile = board.tiles.find((t) => t.id === "tmpl-degree")!;
  assert.equal(tile.vlSkeleton.mark, "bar");
  assert.deepEqual(tile.vlSkeleton.encoding, {
    x: { field: "degree", type: "quantitative" },
    y: { field: "label", type: "nominal" },
  });
});

test("deterministic: two calls with the same inputs deep-equal", () => {
  const a = templateBoard(citedNodeIds, fieldMenu);
  const b = templateBoard(citedNodeIds, fieldMenu);
  assert.deepEqual(a, b);
});

test("empty menu -> empty tiles board, still carries citedNodeIds + source", () => {
  const board = templateBoard(citedNodeIds, []);
  assert.deepEqual(board, { version: 1, tiles: [], citedNodeIds, source: "template" });
});
