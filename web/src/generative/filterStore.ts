/**
 * @rnd/web — tiny cross-filter store for the Generative Studio tile grid (Task 8).
 * Selecting a mark's ids in one `VegaTile` narrows the sibling tiles' datasets;
 * `null` clears the selection back to "show everything". In-memory only.
 */
import type { GenerativeDatasets } from "@rnd/shared";

let selection: string[] | null = null;
const listeners = new Set<() => void>();

export function setSelection(ids: string[] | null): void {
  selection = ids;
  for (const listener of listeners) listener();
}

export function getSelection(): string[] | null {
  return selection;
}

export function subscribeFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Narrow EVERY bound dataset to a node selection — pure, so it is testable on its own.
 *
 * Why all three: tiles used to be bound only to `cited`, so narrowing `cited` alone was
 * coherent. Once tiles could select `metrics` and `edges` (the rich-binding upgrade), a
 * cited-only filter left those tiles ignoring the selection — a half-filtered board, and a
 * provenance drawer that printed "rows as drawn" over rows the chart never drew. Each
 * dataset therefore carries its own join back to a node id:
 *   - `cited`   → `id`      (one row per node)
 *   - `metrics` → `nodeId`  (tidy-long: one row per numeric attribute of a node)
 *   - `edges`   → `source` OR `target` — INCIDENT edges, not just internal ones. Selecting a
 *     single node must still show the evidence attached to it; an internal-only (AND) rule
 *     would blank the edges tile for every single-node selection.
 *
 * An empty/absent selection returns the datasets by reference (no copy, no re-embed churn).
 */
export function narrowDatasets(
  datasets: GenerativeDatasets,
  selection: string[] | null,
): GenerativeDatasets {
  if (!selection || selection.length === 0) return datasets;
  const ids = new Set(selection);
  return {
    cited: datasets.cited.filter((row) => ids.has(String(row.id))),
    metrics: datasets.metrics.filter((row) => ids.has(String(row.nodeId))),
    edges: datasets.edges.filter((row) => ids.has(String(row.source)) || ids.has(String(row.target))),
  };
}
