import test from "node:test";
import assert from "node:assert/strict";
import { LOCKED_EMBED_OPTIONS, denyAllLoader, prepareSpec, selectedIds } from "./VegaTile.js";
import { COLORBLIND_SCHEME } from "./vegaTheme.js";

test("embed options are the locked-runtime set", () => {
  assert.equal(LOCKED_EMBED_OPTIONS.ast, true);
  assert.equal(LOCKED_EMBED_OPTIONS.actions, false);
  assert.equal(LOCKED_EMBED_OPTIONS.renderer, "canvas");
  assert.equal(LOCKED_EMBED_OPTIONS.loader, denyAllLoader);
});

test("deny-all loader rejects every operation", async () => {
  for (const op of ["load", "http", "file"] as const) {
    await assert.rejects(() => (denyAllLoader as Record<string, (u: string) => Promise<string>>)[op]("https://x"), /blocked/);
  }
  assert.equal(denyAllLoader.sanitize && (await denyAllLoader.sanitize("https://x", {}).catch(() => null)), null);
});

test("prepareSpec strips usermeta and injects ONLY the named dataset", () => {
  const out = prepareSpec(
    { vlSkeleton: { data: { name: "cited" }, mark: "bar", usermeta: { embedOptions: { ast: false } } }, dataset: "cited", id: "t", title: "t" },
    { cited: [{ id: "n1" }], metrics: [], edges: [] },
  );
  assert.equal("usermeta" in out, false);
  assert.deepEqual(out.datasets, { cited: [{ id: "n1" }] });
});

test("prepareSpec applies the HOST's theme config — the model can never supply one", () => {
  const tile = {
    // A skeleton that TRIES to smuggle a config through (the compiler cannot emit
    // one, but the host must win regardless).
    vlSkeleton: { data: { name: "cited" }, mark: "bar", config: { background: "url(evil)" } },
    dataset: "cited" as const,
    id: "t",
    title: "t",
  };
  const dark = prepareSpec(tile, { cited: [], metrics: [], edges: [] });
  const cfg = dark.config as Record<string, Record<string, unknown>>;
  assert.equal(cfg.background, "transparent");
  assert.deepEqual(cfg.range.category, [...COLORBLIND_SCHEME]);

  // The theme follows the host's mode, not the spec.
  const light = prepareSpec(tile, { cited: [], metrics: [], edges: [] }, "light");
  const lightCfg = light.config as Record<string, Record<string, unknown>>;
  assert.notEqual(lightCfg.axis.labelColor, cfg.axis.labelColor);
});

test("selectedIds resolves an AGGREGATED selection back to node ids through the bound rows", () => {
  // A bar of count-by-kind: the clicked mark is a GROUP, so its tuple carries no id at all.
  // Vega projects the selection onto the dimension ("kind"), and the rows turn that into nodes.
  const cited = [
    { id: "DRUG-BTK", kind: "Drug", flagged: false },
    { id: "DRUG-X", kind: "Drug", flagged: true },
    { id: "AE-AFIB", kind: "AdverseEvent", flagged: false },
  ];
  const clickedDrugBar = { unit: "x", kind: ["Drug"] };
  assert.deepEqual(selectedIds(clickedDrugBar, cited, "id"), ["DRUG-BTK", "DRUG-X"]);

  // Multi-field predicate (a stacked segment: kind AND flagged) narrows to one node.
  assert.deepEqual(
    selectedIds({ unit: "x", kind: ["Drug"], flagged: [true] }, cited, "id"),
    ["DRUG-X"],
  );

  // Single-tuple signal shape, on a metrics tile — resolves via `nodeId`, not `id`.
  const metrics = [
    { nodeId: "STAT-BTK-AFIB", metric: "prr", value: 5.1 },
    { nodeId: "GA-OT-BTK-AFIB", metric: "otScore", value: 0.29 },
  ];
  const tupleSignal = { unit: "x", fields: [{ field: "metric" }], values: ["otScore"] };
  assert.deepEqual(selectedIds(tupleSignal, metrics, "nodeId"), ["GA-OT-BTK-AFIB"]);

  // An edges selection resolves through `source`.
  const edges = [{ source: "DRUG-BTK", target: "AE-AFIB", kind: "CAUSES" }];
  assert.deepEqual(selectedIds({ unit: "x", kind: ["CAUSES"] }, edges, "source"), ["DRUG-BTK"]);

  // Unrecognised / empty signal fails closed to "no selection" rather than throwing.
  assert.deepEqual(selectedIds(null, cited, "id"), []);
  assert.deepEqual(selectedIds({ unit: "x" }, cited, "id"), []);
});
