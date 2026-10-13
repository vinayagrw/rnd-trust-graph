/**
 * Render tests for the Generative Studio's KpiCard (T9).
 *
 * `renderToStaticMarkup` runs the component WITHOUT effects — which is exactly
 * right here: a KpiCard is a PURE function of its props (the number is computed
 * host-side from `datasets[tile.dataset]` via `tile.kpi`, never read from the
 * tile), so its markup is fully determined without a single effect running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { KpiCard } from "./KpiCard.js";

const DATASETS: GenerativeDatasets = {
  cited: [
    { id: "AE-AFIB", label: "Atrial fibrillation", kind: "AdverseEvent", value: 2 },
    { id: "DRUG-BTK", label: "Ibrutinib", kind: "Drug", value: 4 },
    { id: "AE-BLEED", label: "Bleeding", kind: "AdverseEvent", value: 6 },
  ],
  metrics: [],
  edges: [],
};

function tileWith(kpi: GenerativeTile["kpi"]): GenerativeTile {
  return {
    id: "k1",
    title: "Cited nodes",
    dataset: "cited",
    vlSkeleton: {},
    role: "kpi",
    span: 1,
    kpi,
    provenance: { nodeIds: ["AE-AFIB", "DRUG-BTK", "AE-BLEED"], fields: [], rowCount: 3 },
  };
}

test("a count KPI renders the host-computed row count", () => {
  const html = renderToStaticMarkup(
    <KpiCard tile={tileWith({ aggregate: "count", label: "Cited nodes" })} datasets={DATASETS} />,
  );
  assert.match(html, /data-testid="generative-kpi-card"/);
  assert.match(html, />3</); // the big number is the row count
  assert.match(html, /Cited nodes/); // the KPI label
  assert.match(html, /3 cited rows/); // the provenance strip, VegaTile-style
});

test("a mean KPI renders the host mean over the numeric column", () => {
  // (2 + 4 + 6) / 3 = 4
  const html = renderToStaticMarkup(
    <KpiCard tile={tileWith({ aggregate: "mean", field: "value", label: "Mean value" })} datasets={DATASETS} />,
  );
  assert.match(html, />4</);
  assert.match(html, /Mean value/);
});

test("a FILTERED (smaller) datasets prop yields a lower number — the value is recomputed from props", () => {
  const tile = tileWith({ aggregate: "sum", field: "value", label: "Total" });
  const full = renderToStaticMarkup(<KpiCard tile={tile} datasets={DATASETS} />);
  assert.match(full, />12</); // 2 + 4 + 6

  const filtered: GenerativeDatasets = { ...DATASETS, cited: [DATASETS.cited[0]] };
  const narrowed = renderToStaticMarkup(<KpiCard tile={tile} datasets={filtered} />);
  assert.match(narrowed, />2</); // only the first row survives → lower
  assert.match(narrowed, /1 cited row/); // singular
});

test("a KPI tile without a kpi descriptor renders a graceful em-dash", () => {
  const html = renderToStaticMarkup(<KpiCard tile={tileWith(undefined)} datasets={DATASETS} />);
  assert.match(html, /data-testid="generative-kpi-card"/);
  assert.match(html, /—/);
});

test("min and max aggregate over the numeric column, ignoring non-numbers", () => {
  const withHole: GenerativeDatasets = {
    ...DATASETS,
    cited: [{ value: 6 }, { value: null }, { value: "n/a" }, { value: 2 }],
  };
  const min = renderToStaticMarkup(
    <KpiCard tile={tileWith({ aggregate: "min", field: "value", label: "Min" })} datasets={withHole} />,
  );
  const max = renderToStaticMarkup(
    <KpiCard tile={tileWith({ aggregate: "max", field: "value", label: "Max" })} datasets={withHole} />,
  );
  assert.match(min, />2</);
  assert.match(max, />6</);
});
