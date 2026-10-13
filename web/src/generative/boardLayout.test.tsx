/**
 * Render tests for the Generative Studio's BoardLayout (T10).
 *
 * `renderToStaticMarkup` runs the tree WITHOUT effects — so a chart tile shows
 * VegaTile's skeleton/provenance chrome (its only effect is the vega-embed
 * import) and a KPI tile shows its host-computed card, all without a DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { BoardLayout } from "./BoardLayout.js";

const DATASETS: GenerativeDatasets = {
  cited: [
    { id: "AE-AFIB", label: "Atrial fibrillation", kind: "AdverseEvent", value: 2 },
    { id: "DRUG-BTK", label: "Ibrutinib", kind: "Drug", value: 4 },
  ],
  metrics: [],
  edges: [],
};

const KPI_TILE: GenerativeTile = {
  id: "kpi1",
  title: "Cited nodes",
  dataset: "cited",
  vlSkeleton: {},
  role: "kpi",
  span: 1,
  kpi: { aggregate: "count", label: "Cited nodes" },
  provenance: { nodeIds: ["AE-AFIB", "DRUG-BTK"], fields: [], rowCount: 2 },
};

const HERO_TILE: GenerativeTile = {
  id: "hero1",
  title: "Signal strength",
  dataset: "cited",
  vlSkeleton: { data: { name: "cited" }, mark: "bar", encoding: {} },
  role: "hero",
  span: 2,
  status: "exploratory",
  provenance: { nodeIds: ["AE-AFIB", "DRUG-BTK"], fields: ["value"], rowCount: 2 },
};

const DETAIL_TILE: GenerativeTile = {
  id: "detail1",
  title: "Per-kind detail",
  dataset: "cited",
  vlSkeleton: { data: { name: "cited" }, mark: "point", encoding: {} },
  role: "detail",
  span: 1,
  status: "exploratory",
  provenance: { nodeIds: ["AE-AFIB", "DRUG-BTK"], fields: ["kind"], rowCount: 2 },
};

test("the board uses the host-owned 12-col span grid", () => {
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[KPI_TILE]} datasets={DATASETS} archetype="kpi-grid" onSelect={() => {}} />,
  );
  assert.match(html, /data-testid="generative-board-layout"/);
  assert.match(html, /grid-template-columns:repeat\(12, ?minmax\(0, ?1fr\)\)/);
});

test("a hero chart leads a hero-rail full-width (span 12)", () => {
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[HERO_TILE]} datasets={DATASETS} archetype="hero-rail" onSelect={() => {}} />,
  );
  assert.match(html, /grid-column:span 12/); // hero-rail, first chart → full 12-col width
});

test("a role:kpi tile renders the KpiCard, not a VegaTile", () => {
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[KPI_TILE]} datasets={DATASETS} archetype="kpi-grid" onSelect={() => {}} />,
  );
  assert.match(html, /data-testid="generative-kpi-card"/);
  assert.doesNotMatch(html, /vega-tile-skeleton/);
});

test("a role:detail chart tile renders a VegaTile (skeleton + provenance markers)", () => {
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[DETAIL_TILE]} datasets={DATASETS} archetype="analytic-grid" onSelect={() => {}} />,
  );
  assert.match(html, /vega-tile-skeleton/); // VegaTile's chart-shaped placeholder
  assert.match(html, /vega-tile-provenance/); // ...and its provenance strip
  assert.doesNotMatch(html, /generative-kpi-card/);
});

test("a mixed board lays out each tile by role with archetype-owned widths", () => {
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[KPI_TILE, HERO_TILE, DETAIL_TILE]} datasets={DATASETS} archetype="bento" onSelect={() => {}} />,
  );
  assert.match(html, /generative-kpi-card/);
  assert.match(html, /vega-tile-skeleton/);
  // bento: KPI card sits in the dense strip (span 4); the first chart is the wide
  // magazine tile (span 8); the next chart is a narrow (span 4).
  assert.match(html, /grid-column:span 8/); // the wide bento chart
  assert.match(html, /grid-column:span 4/); // the KPI strip / narrow chart
});

test("Explain/Refine handlers are threaded through to the chart tiles", () => {
  const html = renderToStaticMarkup(
    <BoardLayout
      tiles={[HERO_TILE]}
      datasets={DATASETS}
      archetype="hero-rail"
      onSelect={() => {}}
      onExplain={() => {}}
      onRefine={() => {}}
      onRestore={() => {}}
      restorableFor={() => 2}
      refiningId={null}
    />,
  );
  assert.match(html, /Explain/); // onExplain wired → VegaTile shows the affordance
  assert.match(html, /data-testid="vega-tile-refine"/); // onRefine wired
  assert.match(html, /↩ Restore \(2\)/); // restorableFor > 0 → restore button
});

test("an empty board renders the layout root but no tiles", () => {
  const html = renderToStaticMarkup(
    <BoardLayout tiles={[]} datasets={DATASETS} archetype={null} onSelect={() => {}} />,
  );
  assert.match(html, /data-testid="generative-board-layout"/);
  assert.doesNotMatch(html, /vega-tile-skeleton/);
  assert.doesNotMatch(html, /generative-kpi-card/);
});
