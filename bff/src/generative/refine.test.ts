/**
 * Refine-a-tile lane — hermetic tests. The LLM transport (`run`, same shape as
 * `runClaudeCode`) is dependency-injected, so `refineTile` is exercised end to end
 * with no real CLI: scripted token streams stand in for the model's reply, and the
 * REAL trust chain (tileIRSchema / autoFixIR / scoreTile / compileTile) runs against
 * them exactly as in production.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { FieldMenuEntry, GenerativeTile } from "@rnd/shared";
import type { ClaudeCodeRunOpts, ClaudeCodeResult } from "../llm/claudeCode.js";
import { compileTile, tileIRSchema, type CompileContext } from "./schema.js";
import { refineTile } from "./refine.js";

const fieldMenu: FieldMenuEntry[] = [
  { name: "kind", vlType: "nominal", cardinality: 3, dataset: "cited" },
  { name: "label", vlType: "nominal", cardinality: 4, dataset: "cited" },
  { name: "degree", vlType: "quantitative", cardinality: 4, dataset: "cited" },
  { name: "metric", vlType: "nominal", cardinality: 3, dataset: "metrics" },
  { name: "value", vlType: "quantitative", cardinality: 3, dataset: "metrics" },
  { name: "nodeId", vlType: "nominal", cardinality: 2, dataset: "metrics" },
];

const ctx: CompileContext = { nodeIds: ["n1", "n2"], rowCount: 4 };

/** A prior compiled tile: a count-by-kind bar, id `gen-abc`. */
const priorTile: GenerativeTile = compileTile(
  tileIRSchema(fieldMenu).parse({
    title: "Cited by kind",
    dataset: "cited",
    mark: "bar",
    encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } },
  }),
  "gen-abc",
  ctx,
);

/** Fake provider: streams a scripted reply as `token` events, records prompts. */
function scriptedProvider(script: string) {
  const prompts: string[] = [];
  const run = async (opts: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> => {
    prompts.push(opts.prompt);
    for (let i = 0; i < script.length; i += 5) opts.sink({ type: "token", text: script.slice(i, i + 5) });
    return { ok: true };
  };
  return { run, prompts, callCount: () => prompts.length };
}

function tilesBuffer(tiles: Record<string, unknown>[]): string {
  return JSON.stringify({ tiles });
}

test("a valid refinement returns a NEW tile that keeps the prior id, provenance and exploratory status", async () => {
  const provider = scriptedProvider(
    tilesBuffer([
      { title: "Signal by metric", dataset: "metrics", mark: "bar", encoding: { x: { field: "metric", type: "nominal" }, y: { field: "value", type: "quantitative" } } },
    ]),
  );
  const out = await refineTile(priorTile, "chart the numeric signal values instead", fieldMenu, ctx, { run: provider.run });

  assert.ok(out, "a valid refinement yields a tile");
  assert.equal(out!.id, "gen-abc", "same id — the client replaces the tile in place");
  assert.equal(out!.status, "exploratory");
  assert.equal(out!.dataset, "metrics", "the refined tile switched dataset as instructed");
  assert.equal((out!.vlSkeleton as { mark?: string }).mark, "bar");
  assert.deepEqual(out!.provenance?.nodeIds, ["n1", "n2"], "provenance re-derived from the SAME cited set");
  assert.equal(provider.callCount(), 1, "exactly one LLM round");
});

test("the prompt shows the prior chart's encoding and the user's instruction", async () => {
  const provider = scriptedProvider(tilesBuffer([{ title: "x", dataset: "cited", mark: "point", encoding: { x: { field: "degree", type: "quantitative" }, y: { field: "label", type: "nominal" } } }]));
  await refineTile(priorTile, "swap it to points", fieldMenu, ctx, { run: provider.run });
  const prompt = provider.prompts[0]!;
  assert.match(prompt, /swap it to points/);
  assert.match(prompt, /"mark":"bar"/, "the prior mark is shown to the model");
  assert.match(prompt, /kind \(nominal/, "the dataset-scoped field menu is present");
});

test("a blank instruction never calls the model and leaves the tile alone", async () => {
  const provider = scriptedProvider(tilesBuffer([{ title: "x", dataset: "cited", mark: "bar", encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } } }]));
  const out = await refineTile(priorTile, "   ", fieldMenu, ctx, { run: provider.run });
  assert.equal(out, null);
  assert.equal(provider.callCount(), 0, "no LLM round for an empty instruction");
});

test("an unparseable / off-grammar reply yields null (prior tile stands)", async () => {
  const provider = scriptedProvider(tilesBuffer([{ title: "bad", dataset: "cited", mark: "bar", encoding: { x: { field: "not_a_field", type: "nominal" } } }]));
  const out = await refineTile(priorTile, "do something", fieldMenu, ctx, { run: provider.run });
  assert.equal(out, null, "an unknown field fails the schema — no tile");
});

test("a low-quality shape (a bare count with no dimension) is rejected by the critic", async () => {
  const provider = scriptedProvider(tilesBuffer([{ title: "lone count", dataset: "cited", mark: "bar", encoding: { y: { aggregate: "count" } } }]));
  const out = await refineTile(priorTile, "just the count", fieldMenu, ctx, { run: provider.run });
  assert.equal(out, null, "the deterministic critic gates a low-information chart");
});

test("a run that throws resolves null instead of rejecting", async () => {
  const run = async (): Promise<ClaudeCodeResult> => {
    throw new Error("transport exploded");
  };
  const out = await refineTile(priorTile, "make it a line", fieldMenu, ctx, { run });
  assert.equal(out, null, "refine never throws — the prior tile stands");
});

test("an empty field menu is a no-op (nothing to refine against)", async () => {
  const provider = scriptedProvider(tilesBuffer([{ title: "x", dataset: "cited", mark: "bar", encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } } }]));
  const out = await refineTile(priorTile, "anything", [], ctx, { run: provider.run });
  assert.equal(out, null);
  assert.equal(provider.callCount(), 0);
});
