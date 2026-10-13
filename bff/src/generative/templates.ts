import type { FieldMenuEntry, GenerativeBoard } from "@rnd/shared";
import { tileIRSchema, compileTile } from "./schema.js";

export function templateBoard(citedNodeIds: string[], fieldMenu: FieldMenuEntry[]): GenerativeBoard {
  if (fieldMenu.length === 0) return { version: 1, tiles: [], citedNodeIds, source: "template" };
  const schema = tileIRSchema(fieldMenu);
  // Both template tiles read the `cited` dataset, which is one row per cited node.
  const ctx = { nodeIds: citedNodeIds, rowCount: citedNodeIds.length };
  const tiles = [
    compileTile(schema.parse({
      title: "Cited evidence by kind", dataset: "cited", mark: "bar",
      rationale: "A count by category reads best as a bar chart.",
      encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" }, color: { field: "kind", type: "nominal" } },
    }), "tmpl-kind", ctx),
    compileTile(schema.parse({
      title: "Most connected cited nodes", dataset: "cited", mark: "bar",
      rationale: "Ranking nodes by degree compares one quantity across named items.",
      encoding: { x: { field: "degree", type: "quantitative" }, y: { field: "label", type: "nominal" } },
    }), "tmpl-degree", ctx),
  ];
  return { version: 1, tiles, citedNodeIds, source: "template" };
}
