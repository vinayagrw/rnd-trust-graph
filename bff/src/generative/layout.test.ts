/**
 * Host-owned layout + filter derivation — pure, deterministic, no LLM/Neo4j.
 *
 * These prove the two trust properties that matter: filter controls are DERIVED
 * from the bound data (their kind follows the field's type/cardinality, their
 * options are the DISTINCT values actually present — never anything the model
 * said), and layout role/span is assigned by the host per archetype (the model
 * never gets to size a tile).
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GraphPayload, GraphNode, GraphEdge, GenerativeTile } from "@rnd/shared";
import { bindFromGraph } from "./bind.js";
import { deriveFilters, assignLayout, deriveKpi } from "./layout.js";

const nodes: GraphNode[] = [
  { id: "n1", kind: "Drug", label: "Drug A" },
  { id: "n2", kind: "AdverseEvent", label: "AE B" },
  { id: "n3", kind: "AdverseEvent", label: "AE C" },
];
const edges: GraphEdge[] = [{ id: "e1", source: "n1", target: "n2", kind: "TARGETS" }];
const graph: GraphPayload = { nodes, edges };
const bound = async () => bindFromGraph(graph, ["n1", "n2", "n3"]);

const mk = (id: string): GenerativeTile => ({ id, title: id, vlSkeleton: {}, dataset: "cited" });

test("deriveFilters follows the cardinality→control rule and options are the DISTINCT bound values", async () => {
  const { datasets, fieldMenu } = await bound();
  const controls = deriveFilters(fieldMenu, ["kind", "degree", "flagged"], datasets);
  const byField = new Map(controls.map((c) => [c.field, c]));

  const kind = byField.get("kind")!;
  assert.equal(kind.kind, "dropdown", "kind has 2 distinct → dropdown");
  assert.deepEqual(kind.options, ["AdverseEvent", "Drug"], "options are the distinct cited values, not anything model-supplied");

  const degree = byField.get("degree")!;
  assert.equal(degree.kind, "range", "degree is quantitative → range");
  assert.ok(Array.isArray(degree.domain) && typeof degree.domain[0] === "number", "range carries a numeric [min,max] domain");

  const flagged = byField.get("flagged")!;
  assert.equal(flagged.kind, "toggle", "a boolean field → toggle");
  // The toggle hands the UI the explicit "on" literal ("true"), NOT the alphabetical
  // option order (which sorts "false" first and would invert the filter).
  assert.deepEqual(flagged.options, ["true"], "toggle exposes the truthy 'on' literal, so checking it keeps the flagged nodes");
});

test("deriveFilters skips a name that is not a real bound field", async () => {
  const { datasets, fieldMenu } = await bound();
  const controls = deriveFilters(fieldMenu, ["kind", "not_a_field"], datasets);
  assert.deepEqual(controls.map((c) => c.field), ["kind"]);
});

test("assignLayout(hero-rail) makes the first CHART the hero (span 2), the rest detail (span 1)", () => {
  const out = assignLayout("hero-rail", [mk("a"), mk("b"), mk("c")]);
  assert.deepEqual(out.map((t) => [t.role, t.span]), [["hero", 2], ["detail", 1], ["detail", 1]]);
});

test("assignLayout keeps a KPI tile a span-1 kpi in ANY archetype, and heroes the first CHART", () => {
  const kpiTile: GenerativeTile = { ...mk("k"), kpi: { aggregate: "count", label: "Cited" } };
  const out = assignLayout("hero-rail", [kpiTile, mk("b"), mk("c")]);
  assert.deepEqual([out[0]!.role, out[0]!.span], ["kpi", 1]);
  assert.deepEqual([out[1]!.role, out[1]!.span], ["hero", 2]);
  assert.deepEqual([out[2]!.role, out[2]!.span], ["detail", 1]);
});

test("assignLayout(analytic-grid) is a uniform grid — every chart is detail/span1", () => {
  const out = assignLayout("analytic-grid", [mk("a"), mk("b"), mk("c")]);
  assert.deepEqual(out.map((t) => [t.role, t.span]), [["detail", 1], ["detail", 1], ["detail", 1]]);
});

test("deriveKpi over a cited slot counts rows; over a metrics slot it means the numeric value", async () => {
  const { fieldMenu } = await bound();
  const cited = deriveKpi({ role: "kpi", dataset: "cited", intent: "count of cited nodes" }, fieldMenu);
  assert.equal(cited.aggregate, "count");
  assert.ok(cited.label.length > 0);
});

test("assignLayout keeps gauge/spark tiles as span-1 KPI-family cards, NOT charts, and heroes the first chart", () => {
  const gauge: GenerativeTile = { ...mk("g"), role: "gauge", kpi: { aggregate: "mean", field: "value", label: "PRR" } };
  const spark: GenerativeTile = { ...mk("s"), role: "spark", kpi: { aggregate: "mean", field: "value", label: "ROR" } };
  const out = assignLayout("hero-rail", [gauge, spark, mk("c1"), mk("c2")]);
  assert.deepEqual([out[0]!.role, out[0]!.span], ["gauge", 1], "gauge role is PRESERVED (not flattened to kpi)");
  assert.deepEqual([out[1]!.role, out[1]!.span], ["spark", 1], "spark role is PRESERVED");
  // Only the two remaining CHART tiles enter the chart layout: first is the hero.
  assert.deepEqual([out[2]!.role, out[2]!.span], ["hero", 2]);
  assert.deepEqual([out[3]!.role, out[3]!.span], ["detail", 1]);
});

test("deriveKpi(gauge) attaches a host-derived domain from the bound metric's ACTUAL min/max", async () => {
  const { datasets, fieldMenu } = await bound();
  // Inject a tidy-long metrics series so there IS a numeric `value` column to bound.
  const withMetrics = {
    ...datasets,
    metrics: [
      { nodeId: "n1", metric: "PRR", value: 3 },
      { nodeId: "n2", metric: "PRR", value: 9 },
      { nodeId: "n3", metric: "PRR", value: 5 },
    ],
  };
  const menuWithValue = [...fieldMenu, { name: "value", vlType: "quantitative" as const, cardinality: 3, dataset: "metrics" as const }];
  const kpi = deriveKpi({ role: "gauge", dataset: "metrics", intent: "PRR level" }, menuWithValue, withMetrics);
  assert.equal(kpi.field, "value");
  assert.deepEqual(kpi.domain, [3, 9], "domain is the real [min,max] of the bound value column");
});

test("deriveKpi(gauge) has no domain when the slot has no numeric field to fold over", async () => {
  const { datasets, fieldMenu } = await bound();
  // A gauge over `cited` falls back to a count (no `value` field) → no meaningful domain.
  const kpi = deriveKpi({ role: "gauge", dataset: "cited", intent: "count" }, fieldMenu, datasets);
  assert.equal(kpi.aggregate, "count");
  assert.equal(kpi.domain, undefined);
});
