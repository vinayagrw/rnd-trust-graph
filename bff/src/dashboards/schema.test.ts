/**
 * DashboardSpec schema — the trust-boundary validator.
 *
 * Asserts the two structural guarantees: inertness (`.strict()` rejects any extra
 * field, so no value/url/html can be smuggled) and grounding (every widget node id
 * must be in the cited set; the cited set must be non-empty).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec } from "./schema.js";

const base = () => ({
  version: 1 as const,
  title: "Evidence dashboard",
  intent: "why myocarditis?",
  citedNodeIds: ["AE-MYOCARDITIS", "STAT-1"],
  source: "llm" as const,
  widgets: [
    { id: "w-metric", kind: "metric", metric: "faithfulness" },
    { id: "w-chips", kind: "citation-chips", nodeIds: ["AE-MYOCARDITIS"] },
  ],
});

test("accepts a valid grounded spec", () => {
  const res = validateSpec(base());
  assert.equal(res.ok, true);
});

test("rejects a widget node id that is not cited (grounding)", () => {
  const spec = base();
  spec.widgets[1].nodeIds = ["AE-NOT-CITED"];
  const res = validateSpec(spec);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.error, /un-cited/);
});

test("rejects an empty cited set", () => {
  const spec = { ...base(), citedNodeIds: [] };
  assert.equal(validateSpec(spec).ok, false);
});

test("rejects zero widgets", () => {
  const spec = { ...base(), widgets: [] };
  assert.equal(validateSpec(spec).ok, false);
});

test("rejects an unknown extra field (inertness / .strict)", () => {
  const spec = base() as Record<string, unknown>;
  // A smuggled value channel — must be refused, not ignored.
  (spec.widgets as Record<string, unknown>[])[0].value = "999";
  assert.equal(validateSpec(spec).ok, false);
});

test("rejects a top-level extra field (inertness / .strict)", () => {
  const spec = { ...base(), imageUrl: "http://evil.example/x.png" };
  assert.equal(validateSpec(spec).ok, false);
});

test("rejects a metric tile with no metric", () => {
  const spec = base();
  spec.widgets[0] = { id: "w-metric", kind: "metric" } as (typeof spec.widgets)[number];
  assert.equal(validateSpec(spec).ok, false);
});

test("rejects an unknown widget kind", () => {
  const spec = base();
  spec.widgets[1] = { id: "w-x", kind: "iframe" } as unknown as (typeof spec.widgets)[number];
  assert.equal(validateSpec(spec).ok, false);
});
