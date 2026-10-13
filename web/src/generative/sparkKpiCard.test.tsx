/**
 * Tests for the Generative Studio's SparkKpiCard (host-owned KPI + sparkline).
 *
 * `sparkPoints` is a PURE function of (rows, field) — tested WITHOUT rendering React,
 * with hand-computed normalised points. The render tests use `renderToStaticMarkup`
 * (no effects): both the headline number and the polyline are pure functions of props
 * (computed host-side from `datasets[tile.dataset]`), so the markup is fully determined.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { SparkKpiCard, sparkPoints, SPARK_WIDTH, SPARK_HEIGHT, SPARK_PAD } from "./SparkKpiCard.js";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test("sparkPoints normalises a series: x evenly spaced, MAX at top and MIN at bottom", () => {
  const rows = [{ value: 2 }, { value: 4 }, { value: 6 }];
  const pts = sparkPoints(rows, "value");
  assert.equal(pts.length, 3);
  // x: pad, mid, width-pad
  const innerW = SPARK_WIDTH - 2 * SPARK_PAD;
  assert.ok(near(pts[0].x, SPARK_PAD), `x0 ${pts[0].x}`);
  assert.ok(near(pts[1].x, SPARK_PAD + innerW / 2), `x1 ${pts[1].x}`);
  assert.ok(near(pts[2].x, SPARK_PAD + innerW), `x2 ${pts[2].x}`);
  // y: min (2) at bottom, max (6) at top, mid (4) between
  const innerH = SPARK_HEIGHT - 2 * SPARK_PAD;
  assert.ok(near(pts[0].y, SPARK_PAD + innerH), `y for min should be bottom, got ${pts[0].y}`);
  assert.ok(near(pts[2].y, SPARK_PAD), `y for max should be top, got ${pts[2].y}`);
  assert.ok(near(pts[1].y, SPARK_PAD + innerH / 2), `y for mid, got ${pts[1].y}`);
  // strictly rising values → strictly falling y (upward line)
  assert.ok(pts[0].y > pts[1].y && pts[1].y > pts[2].y, "rising series draws upward");
});

test("sparkPoints skips non-numeric cells but keeps row order for the rest", () => {
  const rows = [{ value: 6 }, { value: null }, { value: "n/a" }, { value: 2 }];
  const pts = sparkPoints(rows, "value");
  assert.equal(pts.length, 2, "only the two numbers become points");
  // 6 is the max (top), 2 the min (bottom)
  assert.ok(pts[0].y < pts[1].y, "first (6) is higher on screen than second (2)");
});

test("sparkPoints: a flat series is drawn on the mid-line; a single point is centred", () => {
  const flat = sparkPoints([{ value: 5 }, { value: 5 }], "value");
  const mid = SPARK_PAD + (SPARK_HEIGHT - 2 * SPARK_PAD) / 2;
  assert.ok(flat.every((p) => near(p.y, mid)), "flat series sits on the mid-line");

  const one = sparkPoints([{ value: 9 }], "value");
  assert.equal(one.length, 1);
  assert.ok(near(one[0].x, SPARK_WIDTH / 2), "a single point is centred");
});

test("sparkPoints returns [] for no field or no numeric values", () => {
  assert.deepEqual(sparkPoints([{ value: 1 }], undefined), []);
  assert.deepEqual(sparkPoints([{ other: "x" }], "value"), []);
  assert.deepEqual(sparkPoints([], "value"), []);
});

const DATASETS: GenerativeDatasets = {
  cited: [],
  metrics: [
    { nodeId: "n1", metric: "ROR", value: 2 },
    { nodeId: "n2", metric: "ROR", value: 4 },
    { nodeId: "n3", metric: "ROR", value: 6 },
  ],
  edges: [],
};

function sparkTile(kpi: GenerativeTile["kpi"]): GenerativeTile {
  return { id: "s1", title: "ROR trend", dataset: "metrics", vlSkeleton: {}, role: "spark", span: 1, kpi };
}

test("SparkKpiCard renders the host aggregate number and a polyline of the series", () => {
  // mean(2,4,6) = 4
  const html = renderToStaticMarkup(
    <SparkKpiCard tile={sparkTile({ aggregate: "mean", field: "value", label: "Mean ROR" })} datasets={DATASETS} />,
  );
  assert.match(html, /data-testid="generative-spark-card"/);
  assert.match(html, /data-testid="generative-spark-line"/);
  assert.match(html, /<polyline/);
  assert.match(html, />4</); // host-computed mean
  assert.match(html, /Mean ROR/);
  assert.match(html, /3 metrics rows/);
});

test("SparkKpiCard recomputes from a filtered dataset (pure function of props)", () => {
  const tile = sparkTile({ aggregate: "sum", field: "value", label: "Total ROR" });
  const full = renderToStaticMarkup(<SparkKpiCard tile={tile} datasets={DATASETS} />);
  assert.match(full, />12</); // 2 + 4 + 6

  const filtered: GenerativeDatasets = { ...DATASETS, metrics: DATASETS.metrics.slice(0, 2) };
  const narrowed = renderToStaticMarkup(<SparkKpiCard tile={tile} datasets={filtered} />);
  assert.match(narrowed, />6</); // 2 + 4
  assert.match(narrowed, /2 metrics rows/);
});

test("SparkKpiCard with fewer than two points draws no line but still shows the number", () => {
  const html = renderToStaticMarkup(
    <SparkKpiCard tile={sparkTile({ aggregate: "mean", field: "value", label: "Mean ROR" })} datasets={{ ...DATASETS, metrics: [DATASETS.metrics[0]] }} />,
  );
  assert.doesNotMatch(html, /generative-spark-line/); // only one point → no sparkline
  assert.match(html, />2</); // the number is still shown
});
