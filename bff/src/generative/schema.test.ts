import test from "node:test";
import assert from "node:assert/strict";
import { tileIRSchema, compileTile } from "./schema.js";
import type { FieldMenuEntry } from "@rnd/shared";

const MENU: FieldMenuEntry[] = [
  { name: "kind", vlType: "nominal", cardinality: 3, dataset: "cited" },
  { name: "label", vlType: "nominal", cardinality: 4, dataset: "cited" },
  { name: "degree", vlType: "quantitative", cardinality: 4, dataset: "cited" },
  { name: "flagged", vlType: "nominal", cardinality: 2, dataset: "cited" },
];
const ok = {
  title: "AEs by kind", dataset: "cited", mark: "bar",
  encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } },
};

test("accepts a minimal valid IR tile", () => {
  const r = tileIRSchema(MENU).safeParse(ok);
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
});

for (const [name, bad] of Object.entries({
  usermeta: { ...ok, usermeta: { embedOptions: { ast: false } } },
  "inline data": { ...ok, data: { values: [{ a: 1 }] } },
  "data url": { ...ok, data: { url: "https://evil.example/x.json" } },
  "image mark": { ...ok, mark: "image" },
  "href channel": { ...ok, encoding: { ...ok.encoding, href: { field: "label" } } },
  // Selection is host-owned: ANY model-declared param is now an unknown key under .strict().
  "lasso selection": { ...ok, params: [{ name: "sel", select: "lasso" }] },
  "event override": { ...ok, params: [{ name: "sel", select: "point", on: "pointerover" }] },
  "a plain point selection (the model may not name a signal at all)": { ...ok, params: [{ name: "pick", select: "point" }] },
  "expression filter": { ...ok, transform: [{ filter: "datum.degree > 2" }] },
  "unknown field": { ...ok, encoding: { x: { field: "nope", type: "nominal" } } },
})) {
  test(`rejects ${name}`, () => {
    assert.equal(tileIRSchema(MENU).safeParse(bad).success, false);
  });
}

// --- Phase 2: wider marks + channels (heatmap/pie/facet/grouped-bar) ----------
const WIDE_MENU: FieldMenuEntry[] = [
  ...MENU,
  { name: "metric", vlType: "nominal", cardinality: 3, dataset: "metrics" },
  { name: "value", vlType: "quantitative", cardinality: 3, dataset: "metrics" },
  { name: "nodeId", vlType: "nominal", cardinality: 2, dataset: "metrics" },
];

test("accepts a heatmap (rect + x + y + color)", () => {
  const r = tileIRSchema(WIDE_MENU).safeParse({
    title: "kind × flag heatmap", dataset: "cited", mark: "rect",
    encoding: { x: { field: "kind", type: "nominal" }, y: { field: "flagged", type: "nominal" }, color: { aggregate: "count" } },
  });
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
});

test("accepts a pie (arc + theta + color) and a faceted small-multiple (column)", () => {
  const pie = tileIRSchema(WIDE_MENU).safeParse({
    title: "share by metric", dataset: "metrics", mark: "arc",
    encoding: { theta: { field: "value", type: "quantitative", aggregate: "sum" }, color: { field: "metric", type: "nominal" } },
  });
  assert.ok(pie.success, JSON.stringify(pie.success ? null : pie.error.issues));
  const facet = tileIRSchema(WIDE_MENU).safeParse({
    title: "value by node, per metric", dataset: "metrics", mark: "bar",
    encoding: { x: { field: "nodeId", type: "nominal" }, y: { field: "value", type: "quantitative" }, column: { field: "metric", type: "nominal" } },
  });
  assert.ok(facet.success, JSON.stringify(facet.success ? null : facet.error.issues));
});

test("compileTile passes new channels (xOffset) straight through", () => {
  const ir = tileIRSchema(WIDE_MENU).parse({
    title: "grouped", dataset: "metrics", mark: "bar",
    encoding: { x: { field: "nodeId", type: "nominal" }, y: { field: "value", type: "quantitative" }, xOffset: { field: "metric", type: "nominal" }, color: { field: "metric", type: "nominal" } },
  });
  const tile = compileTile(ir, "g1");
  assert.deepEqual((tile.vlSkeleton.encoding as Record<string, unknown>).xOffset, { field: "metric", type: "nominal" });
  assert.equal(tile.vlSkeleton.mark, "bar");
});

test("compileTile emits only allowlisted VL keys + named data", () => {
  const ir = tileIRSchema(MENU).parse({
    ...ok,
    transform: [{ filter: { field: "flagged", op: "=", value: true } }],
  });
  const tile = compileTile(ir, "t1");
  assert.deepEqual(tile.vlSkeleton.data, { name: "cited" });
  assert.deepEqual(Object.keys(tile.vlSkeleton).sort(),
    ["data", "encoding", "mark", "params", "title", "transform"]);
  assert.deepEqual(tile.vlSkeleton.transform, [{ filter: { field: "flagged", equal: true } }]);
});

test("the compiler ALWAYS emits a host-owned point selection, projected onto the tile's DIMENSIONS", () => {
  // Two bugs are fenced here. (1) Cross-filter used to depend on the model emitting `params` —
  // live, 0 of 4 tiles did, so clicking a mark did nothing. (2) Projecting onto the node key
  // failed on AGGREGATED tiles: `ok` is a count-by-kind bar, whose marks are groups with no
  // `id` column, so the selection matched nothing. Project onto the dimension instead.
  const aggregated = compileTile(tileIRSchema(MENU).parse(ok), "t1");
  assert.deepEqual(aggregated.vlSkeleton.params, [
    { name: "picked", select: { type: "point", fields: ["kind"] } },
  ]);

  // A non-aggregated tile projects onto every dimension it encodes.
  const perNode = tileIRSchema(MENU).parse({
    title: "by degree", dataset: "cited", mark: "bar",
    encoding: { x: { field: "degree", type: "quantitative" }, y: { field: "label", type: "nominal" } },
  });
  assert.deepEqual(compileTile(perNode, "t2").vlSkeleton.params, [
    { name: "picked", select: { type: "point", fields: ["degree", "label"] } },
  ]);

  // A tile with NO dimension at all (a bare aggregate) falls back to the dataset's node key.
  const bare = tileIRSchema(MENU).parse({
    title: "count", dataset: "cited", mark: "bar", encoding: { y: { aggregate: "count" } },
  });
  assert.deepEqual(compileTile(bare, "t3").vlSkeleton.params, [
    { name: "picked", select: { type: "point", fields: ["id"] } },
  ]);
});

test("compileTile carries server-derived provenance + the model's prose rationale, and never leaks either into the spec", () => {
  const ir = tileIRSchema(MENU).parse({
    ...ok,
    rationale: "A count by category reads best as a bar.",
    transform: [{ filter: { field: "flagged", op: "=", value: true } }],
  });
  const tile = compileTile(ir, "t1", { nodeIds: ["n1", "n2"], rowCount: 7 });

  assert.equal(tile.status, "exploratory");
  assert.equal(tile.rationale, "A count by category reads best as a bar.");
  assert.deepEqual(tile.provenance, {
    nodeIds: ["n1", "n2"],
    // encoding channels + transform filters, de-duplicated
    fields: ["kind", "flagged"],
    rowCount: 7,
  });
  // Neither rationale nor provenance may reach the rendered Vega-Lite spec.
  assert.equal("rationale" in tile.vlSkeleton, false);
  assert.equal("provenance" in tile.vlSkeleton, false);
});

test("compileTile without a context still yields empty (never undefined) provenance", () => {
  const tile = compileTile(tileIRSchema(MENU).parse(ok), "t2");
  assert.deepEqual(tile.provenance, { nodeIds: [], fields: ["kind"], rowCount: 0 });
});

test("a rationale longer than 200 chars is rejected (prose budget, not a data channel)", () => {
  const res = tileIRSchema(MENU).safeParse({ ...ok, rationale: "x".repeat(201) });
  assert.equal(res.success, false);
});
