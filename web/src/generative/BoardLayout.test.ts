/**
 * BoardLayout's per-archetype width pattern — the source of structural variety.
 *
 * The six archetypes used to collapse into one 2-column look; `tileWidth` gives each
 * its own 12-column rhythm. These assertions pin those rhythms so a board genuinely
 * looks DIFFERENT per archetype (the "more archetypes" ask), and so KPI cards always
 * sit in a dense strip regardless of archetype.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tileWidth } from "./BoardLayout.js";

test("small-multiples is a wall of equal thirds (every chart 1/3 of the 12-col grid)", () => {
  for (const pos of [0, 1, 2, 3]) assert.equal(tileWidth("small-multiples", false, pos), 4);
});

test("master-detail is one dominant chart beside stacked narrows", () => {
  assert.equal(tileWidth("master-detail", false, 0), 8);
  assert.equal(tileWidth("master-detail", false, 1), 4);
  assert.equal(tileWidth("master-detail", false, 2), 4);
});

test("hero-rail leads with a full-width hero then a rail of halves", () => {
  assert.equal(tileWidth("hero-rail", false, 0), 12);
  assert.equal(tileWidth("hero-rail", false, 1), 6);
});

test("bento has a magazine rhythm: wide, narrow, narrow, repeating", () => {
  assert.deepEqual([0, 1, 2, 3].map((p) => tileWidth("bento", false, p)), [8, 4, 4, 8]);
});

test("uniform archetypes (analytic-grid, kpi-grid) render charts as equal halves", () => {
  assert.equal(tileWidth("analytic-grid", false, 0), 6);
  assert.equal(tileWidth("kpi-grid", false, 1), 6);
});

test("KPI cards always sit in a dense strip (never a hero/half), whatever the archetype", () => {
  assert.equal(tileWidth("kpi-grid", true, 0), 3); // 4 across
  assert.equal(tileWidth("bento", true, 0), 4); // 3 across
  assert.equal(tileWidth("hero-rail", true, 0), 4);
});

test("the archetypes produce more than one distinct chart-width signature (not all the same look)", () => {
  const sig = (a: Parameters<typeof tileWidth>[0]) => [0, 1, 2].map((p) => tileWidth(a, false, p)).join(",");
  const signatures = new Set(
    (["hero-rail", "master-detail", "bento", "small-multiples", "analytic-grid", "kpi-grid"] as const).map(sig),
  );
  assert.ok(signatures.size >= 4, `expected >=4 distinct layouts, got ${signatures.size}`);
});
