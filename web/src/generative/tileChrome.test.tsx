/**
 * Render tests for the Generative Studio's trust surfaces.
 *
 * These exist because Phase 4's provenance UI was previously typecheck-only: the status
 * pill, the provenance strip and the lineage drawer were never rendered by anything but a
 * browser, so a regression in them would have been invisible to the suite.
 *
 * `renderToStaticMarkup` runs the component tree WITHOUT effects, which is exactly right
 * here — VegaTile's only effect is the vega-embed import, so the markup under test is the
 * chrome (pill, strip, buttons, skeleton) and never touches the Vega runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { VegaTile } from "./VegaTile.js";
import { TileLineageDrawer } from "./TileLineageDrawer.js";
import { COLORBLIND_SCHEME, COLORBLIND_SCHEME_LIGHT, schemeFor } from "./vegaTheme.js";

const DATASETS: GenerativeDatasets = {
  cited: [
    { id: "AE-AFIB", label: "Atrial fibrillation", kind: "AdverseEvent", degree: 6, prr: 5.1 },
    { id: "DRUG-BTK", label: "Ibrutinib", kind: "Drug", degree: 4, prr: null },
  ],
  metrics: [{ nodeId: "STAT-BTK-AFIB", label: "Signal", kind: "Stat", metric: "prr", value: 5.1 }],
  edges: [{ source: "DRUG-BTK", target: "AE-AFIB", kind: "CAUSES" }],
};

const TILE: GenerativeTile = {
  id: "t1",
  title: "Signal strength by metric",
  dataset: "cited",
  vlSkeleton: { data: { name: "cited" }, mark: "bar", encoding: {} },
  appropriateness: 1,
  status: "exploratory",
  rationale: "Bars compare the named disproportionality measures side by side.",
  provenance: { nodeIds: ["AE-AFIB", "DRUG-BTK"], fields: ["prr", "kind"], rowCount: 2 },
};

test("an exploratory tile signals its state WITHOUT relying on colour (glyph + dashed border)", () => {
  const html = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.match(html, /exploratory/);
  assert.match(html, /⚗/); // the glyph carries the state for a colourblind reader
  assert.match(html, /border:1px dashed/); // ...as does the border STYLE, not just its hue
  assert.doesNotMatch(html, /✓ certified/); // the certified pill itself must not render
  assert.match(html, /data-testid="vega-tile-exploratory"/);
});

test("a certified tile flips to the solid-border check glyph", () => {
  const html = renderToStaticMarkup(
    <VegaTile tile={{ ...TILE, status: "certified" }} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.match(html, /✓ certified/);
  assert.match(html, /border:1px solid rgba\(35,134,54/);
});

test("the provenance strip names the cited count, the row count and the fields charted", () => {
  const html = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.match(html, /Grounded in 2 cited nodes/);
  assert.match(html, /2 cited rows/);
  assert.match(html, /fields: prr, kind/);
});

test("no per-tile quality meter — the critic is a gate, not a ranking (it would read the same on every tile)", () => {
  const html = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.doesNotMatch(html, /●/);
});

test("the Explain affordance appears only when a handler is wired", () => {
  const withHandler = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} onExplain={() => {}} />,
  );
  const without = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.match(withHandler, /Explain/);
  assert.doesNotMatch(without, /Explain/);
});

test("a tile renders its skeleton until vega-embed resolves (effects have not run here)", () => {
  const html = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.match(html, /vega-tile-skeleton/);
});

test("the lineage drawer shows the rationale, the server lineage, and the EXACT bound rows", () => {
  const html = renderToStaticMarkup(
    <TileLineageDrawer tile={TILE} datasets={DATASETS} onClose={() => {}} />,
  );
  // 1. model rationale, labelled as the model's
  assert.match(html, /model rationale/i);
  assert.match(html, /Bars compare the named disproportionality measures/);
  // 2. server-derived lineage
  assert.match(html, /Fields charted: prr, kind/);
  assert.match(html, /Grounded in 2 cited nodes/);
  // 3. the audit table — the real values, and a null rendered honestly as an em-dash
  assert.match(html, /Atrial fibrillation/);
  assert.match(html, /5\.1/);
  assert.match(html, /—/);
  // the critic score is stated as a gate, not shown as a rating
  assert.match(html, /gate, not a ranking/);
});

test("the drawer reflects the FILTERED datasets it is handed — it must not claim rows the chart never drew", () => {
  const filtered: GenerativeDatasets = { ...DATASETS, cited: [DATASETS.cited[0]] };
  const html = renderToStaticMarkup(
    <TileLineageDrawer tile={TILE} datasets={filtered} onClose={() => {}} />,
  );
  assert.match(html, /1 row as drawn/);
  assert.doesNotMatch(html, /Ibrutinib/);
});

test("refine controls appear only when a handler is wired, and the ↩ Restore button only with history", () => {
  const withRefine = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} onRefine={() => {}} />,
  );
  const without = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />,
  );
  assert.match(withRefine, /data-testid="vega-tile-refine"/);
  assert.match(withRefine, /Swap mark/);
  assert.match(withRefine, /Facet by kind/);
  assert.doesNotMatch(without, /data-testid="vega-tile-refine"/);

  // No restore affordance until a prior version exists.
  assert.doesNotMatch(withRefine, /↩ Restore/);
  const restorable = renderToStaticMarkup(
    <VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} onRefine={() => {}} onRestore={() => {}} restorable={2} />,
  );
  assert.match(restorable, /↩ Restore \(2\)/);
});

test("the light palette is the contrast-safe one — Okabe-Ito's yellow is invisible on white", () => {
  assert.deepEqual(schemeFor("dark"), [...COLORBLIND_SCHEME]);
  assert.deepEqual(schemeFor("light"), [...COLORBLIND_SCHEME_LIGHT]);
  assert.equal(COLORBLIND_SCHEME.includes("#F0E442" as never), true); // 1.32:1 on white
  assert.equal(COLORBLIND_SCHEME_LIGHT.includes("#F0E442" as never), false);
});

test("the provenance strip reports the rows ACTUALLY DRAWN when a cross-filter is active", () => {
  // Unfiltered: the compose-time count and the drawn count agree.
  const full = renderToStaticMarkup(<VegaTile tile={TILE} datasets={DATASETS} onSelect={() => {}} />);
  assert.match(full, /2 cited rows/);
  assert.doesNotMatch(full, /filtered/);

  // Filtered: the strip must not keep claiming the full compose-time count.
  const filtered: GenerativeDatasets = { ...DATASETS, cited: [DATASETS.cited[0]] };
  const html = renderToStaticMarkup(<VegaTile tile={TILE} datasets={filtered} onSelect={() => {}} />);
  assert.match(html, /1 of 2 cited rows \(filtered\)/);
});
