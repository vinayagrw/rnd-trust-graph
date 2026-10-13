import test from "node:test";
import assert from "node:assert/strict";
import type { FieldMenuEntry } from "@rnd/shared";
import { tileIRSchema } from "./schema.js";
import { scoreTile, autoFixIR, QUALITY_THRESHOLD } from "./critic.js";

const menu: FieldMenuEntry[] = [
  { name: "kind", vlType: "nominal", cardinality: 3, dataset: "cited" },
  { name: "label", vlType: "nominal", cardinality: 40, dataset: "cited" }, // high-cardinality
  { name: "degree", vlType: "quantitative", cardinality: 5, dataset: "cited" },
  { name: "value", vlType: "quantitative", cardinality: 3, dataset: "metrics" },
  { name: "metric", vlType: "nominal", cardinality: 8, dataset: "metrics" },
];
const parse = (ir: unknown) => tileIRSchema(menu).parse(ir);

test("a well-formed bar (count by kind) scores 1 with no issues", () => {
  const ir = parse({ title: "by kind", dataset: "cited", mark: "bar", encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } } });
  const c = scoreTile(ir, menu);
  assert.equal(c.score, 1);
  assert.deepEqual(c.issues, []);
});

test("line over a nominal x is penalised (moderate) but not fatal", () => {
  const ir = parse({ title: "bad line", dataset: "cited", mark: "line", encoding: { x: { field: "kind", type: "nominal" }, y: { field: "degree", type: "quantitative" } } });
  const c = scoreTile(ir, menu);
  assert.equal(c.score, 0.75);
  assert.match(c.issues.join(" "), /line\/area over a nominal x/);
});

test("arc without theta AND too many slices falls below threshold", () => {
  const ir = parse({ title: "bad pie", dataset: "metrics", mark: "arc", encoding: { color: { field: "metric", type: "nominal" } } });
  const c = scoreTile(ir, menu);
  assert.ok(c.score < QUALITY_THRESHOLD, `score ${c.score} should be < ${QUALITY_THRESHOLD}`);
  assert.match(c.issues.join(" "), /theta/);
});

test("boxplot without a quantitative field is fatal", () => {
  const ir = parse({ title: "bad box", dataset: "cited", mark: "boxplot", encoding: { x: { field: "kind", type: "nominal" } } });
  const c = scoreTile(ir, menu);
  assert.ok(c.score < QUALITY_THRESHOLD);
  assert.match(c.issues.join(" "), /boxplot needs a quantitative/);
});

test("a lone count with no dimension is low-information (fatal)", () => {
  const ir = parse({ title: "bare count", dataset: "cited", mark: "bar", encoding: { y: { aggregate: "count" } } });
  const c = scoreTile(ir, menu);
  assert.ok(c.score < QUALITY_THRESHOLD);
  assert.match(c.issues.join(" "), /low-information/);
});

test("categorical overplotting on a positional channel is penalised", () => {
  const ir = parse({ title: "too many bars", dataset: "cited", mark: "bar", encoding: { x: { field: "label", type: "nominal" }, y: { field: "degree", type: "quantitative" } } });
  const c = scoreTile(ir, menu);
  assert.equal(c.score, 0.75);
  assert.match(c.issues.join(" "), /categories/);
});

test("autoFixIR fills a missing channel type from the bound field menu", () => {
  const ir = parse({ title: "no types", dataset: "cited", mark: "bar", encoding: { x: { field: "kind" }, y: { field: "degree" } } });
  const fixed = autoFixIR(ir, menu);
  const enc = fixed.encoding as Record<string, { type?: string }>;
  assert.equal(enc.x!.type, "nominal");
  assert.equal(enc.y!.type, "quantitative");
});
