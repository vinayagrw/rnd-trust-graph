/**
 * @rnd/generative — client half of the refine-a-tile lane (Phase 5).
 *
 * Posts one tile + a natural-language instruction to the read-only BFF refine route
 * and returns the refreshed board slice. The server re-binds from the tile's OWN cited
 * set and runs a single LLM round through the trusted schema/critic/compiler chain, so
 * the returned tile (when non-null) is as locked-down as a composed one. A null tile
 * means the model produced nothing acceptable — the caller leaves the prior tile standing.
 */
import type { FieldMenuEntry, GenerativeDatasets, GenerativeTile } from "@rnd/shared";

export interface RefineResponse {
  tile: GenerativeTile | null;
  datasets: GenerativeDatasets;
  fieldMenu: FieldMenuEntry[];
}

export async function requestRefine(tile: GenerativeTile, instruction: string): Promise<RefineResponse> {
  const res = await fetch("/api/generative/refine", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tile, instruction }),
  });
  if (!res.ok) throw new Error(`refine failed: ${res.status}`);
  return (await res.json()) as RefineResponse;
}
