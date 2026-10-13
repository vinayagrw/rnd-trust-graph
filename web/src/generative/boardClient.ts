/**
 * @rnd/generative — client half of the "More dashboards" lane.
 *
 * Posts an EXISTING cited-node set to the read-only BFF board route and returns a
 * freshly composed board over that same evidence — nudged (and deterministically
 * rotated) away from `avoidArchetype`, so each call yields a visibly DIFFERENT board.
 *
 * This is the honest home for a product request like "I need more dashboards": the
 * grounded-Q&A chat correctly refuses that (the graph holds no Dashboard node), but the
 * app CAN give you another view of the evidence you're already looking at. Same trusted
 * orchestrator, same cited set — no new grounding selection, no graph write.
 */
import type { FieldMenuEntry, GenerativeBoard, GenerativeDatasets, LayoutArchetype } from "@rnd/shared";

export interface MoreDashboardsResponse {
  board: GenerativeBoard;
  datasets: GenerativeDatasets;
  fieldMenu: FieldMenuEntry[];
}

export async function requestMoreDashboards(citedNodeIds: string[], avoidArchetype?: LayoutArchetype): Promise<MoreDashboardsResponse> {
  const res = await fetch("/api/generative/board", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ citedNodeIds, avoidArchetype }),
  });
  if (!res.ok) throw new Error(`board compose failed: ${res.status}`);
  return (await res.json()) as MoreDashboardsResponse;
}
