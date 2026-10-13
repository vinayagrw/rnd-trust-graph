/**
 * Tests for the Generative Studio's GaugeCard (host-owned radial KPI).
 *
 * The geometry is a PURE function of (value, domain) — `gaugeGeometry` — so it is
 * tested WITHOUT rendering React, with hand-computed expectations. The render tests use
 * `renderToStaticMarkup` (no effects): the dial is a pure function of props, so its
 * markup is fully determined — the number is host-computed from `datasets[tile.dataset]`
 * via the `kpi` descriptor, never read from the tile.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { GaugeCard, gaugeGeometry, gaugePoint, GAUGE_CX, GAUGE_CY, GAUGE_R } from "./GaugeCard.js";
import { BoardLayout } from "./BoardLayout.js";

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

test("gaugeGeometry: midpoint of the domain → fraction 0.5, 90°, dial top", () => {
  const g = gaugeGeometry(5, [0, 10]);
  assert.ok(near(g.fraction, 0.5), `fraction ${g.fraction}`);
  assert.ok(near(g.angleDeg, 90), `angle ${g.angleDeg}`);
  // 90° is the top of the arc: (cx, cy - r).
  assert.ok(near(g.point.x, GAUGE_CX) && near(g.point.y, GAUGE_CY - GAUGE_R), `point ${JSON.stringify(g.point)}`);
});

test("gaugeGeometry: min → fraction 0, 180° (left end); max → fraction 1, 0° (right end)", () => {
  const lo = gaugeGeometry(0, [0, 10]);
  assert.ok(near(lo.fraction, 0) && near(lo.angleDeg, 180));
  assert.ok(near(lo.point.x, GAUGE_CX - GAUGE_R) && near(lo.point.y, GAUGE_CY), `left ${JSON.stringify(lo.point)}`);

  const hi = gaugeGeometry(10, [0, 10]);
  assert.ok(near(hi.fraction, 1) && near(hi.angleDeg, 0));
  assert.ok(near(hi.point.x, GAUGE_CX + GAUGE_R) && near(hi.point.y, GAUGE_CY), `right ${JSON.stringify(hi.point)}`);
});

test("gaugeGeometry clamps values outside the domain to [0,1]", () => {
  assert.ok(near(gaugeGeometry(-5, [0, 10]).fraction, 0), "below min clamps to 0");
  assert.ok(near(gaugeGeometry(999, [0, 10]).fraction, 1), "above max clamps to 1");
});

test("gaugeGeometry handles a non-[0,10] domain (partial fraction), and a null/degenerate domain → 0", () => {
  const g = gaugeGeometry(3, [1, 5]); // (3-1)/(5-1) = 0.5
  assert.ok(near(g.fraction, 0.5), `fraction ${g.fraction}`);
  assert.ok(near(gaugeGeometry(null, [0, 10]).fraction, 0), "no value → 0");
  assert.ok(near(gaugeGeometry(5, [4, 4]).fraction, 0), "degenerate domain → 0");
  assert.ok(near(gaugeGeometry(5, undefined).fraction, 0), "absent domain → 0");
});

test("gaugePoint is on the circle of radius r about (cx,cy)", () => {
  for (const a of [0, 45, 90, 135, 180]) {
    const p = gaugePoint(a);
    const d = Math.hypot(p.x - GAUGE_CX, p.y - GAUGE_CY);
    assert.ok(near(d, GAUGE_R, 1e-9), `radius at ${a}° = ${d}`);
  }
});

const DATASETS: GenerativeDatasets = {
  cited: [],
  metrics: [
    { nodeId: "n1", metric: "PRR", value: 2 },
    { nodeId: "n2", metric: "PRR", value: 6 },
    { nodeId: "n3", metric: "PRR", value: 4 },
  ],
  edges: [],
};

function gaugeTile(kpi: GenerativeTile["kpi"]): GenerativeTile {
  return { id: "g1", title: "Mean PRR", dataset: "metrics", vlSkeleton: {}, role: "gauge", span: 1, kpi };
}

test("GaugeCard renders the host mean and the dial arc from bound rows", () => {
  // mean(2,6,4) = 4
  const html = renderToStaticMarkup(
    <GaugeCard tile={gaugeTile({ aggregate: "mean", field: "value", label: "Mean PRR", domain: [0, 6] })} datasets={DATASETS} />,
  );
  assert.match(html, /data-testid="generative-gauge-card"/);
  assert.match(html, /data-testid="generative-gauge-arc"/);
  assert.match(html, /data-testid="generative-gauge-value-arc"/); // a value arc is drawn
  assert.match(html, />4</); // the host-computed mean
  assert.match(html, /range 0–6/); // the host-derived domain, never a model value
  assert.match(html, /3 metrics rows/); // provenance strip
});

test("GaugeCard is a pure function of props — a filtered dataset recomputes the value", () => {
  const tile = gaugeTile({ aggregate: "max", field: "value", label: "Max PRR", domain: [0, 6] });
  const full = renderToStaticMarkup(<GaugeCard tile={tile} datasets={DATASETS} />);
  assert.match(full, />6</); // max over all three rows

  const filtered: GenerativeDatasets = { ...DATASETS, metrics: [DATASETS.metrics[0]] };
  const narrowed = renderToStaticMarkup(<GaugeCard tile={tile} datasets={filtered} />);
  assert.match(narrowed, />2</); // only the first row survives → lower
  assert.match(narrowed, /1 metrics row/);
});

test("GaugeCard without a kpi descriptor renders a graceful em-dash and no value arc", () => {
  const html = renderToStaticMarkup(<GaugeCard tile={gaugeTile(undefined)} datasets={DATASETS} />);
  assert.match(html, /data-testid="generative-gauge-card"/);
  assert.match(html, /—/);
  assert.doesNotMatch(html, /generative-gauge-value-arc/);
});

test("BoardLayout routes role:gauge → GaugeCard and role:spark → SparkKpiCard, and both sit in the KPI strip (no chart)", () => {
  const gauge = gaugeTile({ aggregate: "mean", field: "value", label: "Mean PRR", domain: [0, 6] });
  const spark: GenerativeTile = { id: "s1", title: "ROR trend", dataset: "metrics", vlSkeleton: {}, role: "spark", span: 1, kpi: { aggregate: "mean", field: "value", label: "Mean ROR" } };
  const chart: GenerativeTile = { id: "c1", title: "By kind", dataset: "metrics", vlSkeleton: { data: { name: "metrics" }, mark: "bar", encoding: {} }, role: "detail", span: 1, status: "exploratory", provenance: { nodeIds: [], fields: ["metric"], rowCount: 3 } };
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[gauge, spark, chart]} datasets={DATASETS} archetype="kpi-grid" onSelect={() => {}} />,
  );
  assert.match(html, /data-testid="generative-gauge-card"/);
  assert.match(html, /data-testid="generative-spark-card"/);
  assert.match(html, /vega-tile-skeleton/); // the one true chart still renders as a VegaTile
  assert.doesNotMatch(html, /generative-gauge-card[^]*generative-gauge-card/); // exactly one gauge
  // gauge + spark take the dense KPI width (3 in kpi-grid); the chart takes chartPos 0's width.
  assert.match(html, /data-tile-width="3"[^]*data-tile-width="3"/);
});
