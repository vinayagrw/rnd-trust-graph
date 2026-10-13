/**
 * The per-tile gate — hermetic, no LLM/Neo4j. Proves the extracted gate keeps the
 * composer's trust guarantees: a valid tile compiles with HOST-owned params and
 * SERVER-derived provenance; an unknown field or a low-quality shape is rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GraphPayload, GraphNode, GraphEdge } from "@rnd/shared";
import { bindFromGraph } from "./bind.js";
import { tileIRSchema } from "./schema.js";
import { gateRawTile } from "./gate.js";

const nodes: GraphNode[] = [
  { id: "n1", kind: "Drug", label: "Drug A" },
  { id: "n2", kind: "AdverseEvent", label: "AE B" },
  { id: "n3", kind: "AdverseEvent", label: "AE C" },
];
const edges: GraphEdge[] = [{ id: "e1", source: "n1", target: "n2", kind: "TARGETS" }];
const graph: GraphPayload = { nodes, edges };
const cited = ["n1", "n2", "n3"];

const setup = async () => {
  const { datasets, fieldMenu } = await bindFromGraph(graph, cited);
  const schema = tileIRSchema(fieldMenu);
  const ctx = { nodeIds: cited, rowCount: datasets.cited.length };
  return { schema, fieldMenu, ctx };
};

const barByKind = { title: "By kind", dataset: "cited", mark: "bar", encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } } };

test("a valid tile compiles with host-owned params and server-derived provenance", async () => {
  const { schema, fieldMenu, ctx } = await setup();
  const res = gateRawTile(barByKind, schema, fieldMenu, ctx);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.tile.provenance?.nodeIds, cited, "provenance comes from ctx, not the model");
  assert.ok(Array.isArray((res.tile.vlSkeleton as any).params), "the host always stamps a selection param");
  assert.ok(res.score >= 0.6);
  assert.equal(res.tile.appropriateness, res.score);
});

test("an unknown field is rejected with the schema reason", async () => {
  const { schema, fieldMenu, ctx } = await setup();
  const bad = { title: "Bad", dataset: "cited", mark: "bar", encoding: { x: { field: "not_a_field" } } };
  const res = gateRawTile(bad, schema, fieldMenu, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.issues, /not in dataset "cited"/);
});

test("a bare count (schema-valid, low-quality) is critic-gated", async () => {
  const { schema, fieldMenu, ctx } = await setup();
  const bare = { title: "Lonely", dataset: "cited", mark: "bar", encoding: { y: { aggregate: "count" } } };
  const res = gateRawTile(bare, schema, fieldMenu, ctx);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.issues, /low-information/);
});
