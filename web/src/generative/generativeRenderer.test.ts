import { test } from "node:test";
import assert from "node:assert/strict";
import { generativeArgsSchema } from "./generativeRenderer.js";

/** Regression for the Zod v3 "undeclared keys are stripped" gotcha that bit
 *  `dashboardRenderer` once: a delta payload's `runId` (no `final` yet) must
 *  survive `.parse()` untouched. */
test("args schema preserves runId on a delta payload (no final)", () => {
  const parsed = generativeArgsSchema.parse({
    tile: { id: "t1", title: "t1", vlSkeleton: { mark: "bar" }, dataset: "cited" },
    datasets: { cited: [{ id: "n1" }], edges: [] },
    fieldMenu: [{ name: "id", vlType: "nominal", cardinality: 1 }],
    runId: "run-123",
  });
  assert.equal(parsed.runId, "run-123");
  assert.equal(parsed.final, undefined);
  assert.equal((parsed.tile as { id: string }).id, "t1");
});

/** Same regression, final-reconcile shape: both `runId` AND `final` must
 *  survive together. */
test("args schema preserves runId AND final together on a final board payload", () => {
  const parsed = generativeArgsSchema.parse({
    board: { version: 1, tiles: [], citedNodeIds: [], source: "llm" },
    datasets: { cited: [], edges: [] },
    fieldMenu: [],
    runId: "run-456",
    final: true,
  });
  assert.equal(parsed.runId, "run-456");
  assert.equal(parsed.final, true);
});

test("args schema tolerates a minimal payload (all keys optional)", () => {
  const parsed = generativeArgsSchema.parse({});
  assert.equal(parsed.runId, undefined);
  assert.equal(parsed.final, undefined);
  assert.equal(parsed.tile, undefined);
  assert.equal(parsed.board, undefined);
});
