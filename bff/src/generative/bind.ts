import type { GraphPayload, GenerativeDatasets, FieldMenuEntry, GenerativeDatasetName } from "@rnd/shared";
import { getFullGraph } from "../graph/queries.js";
import { getRiskReport } from "../graph/risk.js";

type Row = Record<string, string | number | boolean | null>;
type VlType = FieldMenuEntry["vlType"];

/** ISO-ish date at the start of a string (2026-07-13, 2026-07-13T…). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** Infer a Vega-Lite type for a column from its present (non-null) values.
 *  - all numbers            → quantitative
 *  - all ISO-date strings   → temporal
 *  - otherwise              → nominal
 *  `n.attrs` already coerced the vetted numeric keys (prr/ror/chi2/cases/records/
 *  otScore) to real numbers upstream (graph/queries.ts parseAttrs allow-list), so a
 *  quantitative metric column falls out naturally without re-parsing here. */
function inferType(values: (string | number)[]): VlType {
  const present = values.filter((v) => v !== undefined && v !== "");
  if (present.length === 0) return "nominal";
  if (present.every((v) => typeof v === "number")) return "quantitative";
  if (present.every((v) => typeof v === "string" && ISO_DATE.test(v))) return "temporal";
  return "nominal";
}

function cardinality(rows: Row[], field: string): number {
  const seen = new Set<string>();
  for (const r of rows) if (r[field] !== null && r[field] !== undefined) seen.add(String(r[field]));
  return seen.size;
}

/** Bind tabular datasets from ALREADY-CITED nodes only. Deterministic: sorted by id.
 *  `flaggedIds` — nodeIds with at least one live SHACL risk finding (readonly).
 *
 *  The model never sees a value — it picks charts over these SERVER-BOUND datasets:
 *  - `cited`  wide  : {id,label,kind,degree,flagged, ...parsed node attrs}
 *  - `metrics` long : {nodeId,label,kind,metric,value} — every numeric attribute
 *  - `edges`        : {source,target,kind} of the induced subgraph
 *  `fieldMenu` is DATASET-SCOPED so a tile's field refs validate against the dataset
 *  it selected (schema.ts). */
export function bindFromGraph(
  g: GraphPayload,
  citedNodeIds: string[],
  flaggedIds: Set<string> = new Set(),
): { datasets: GenerativeDatasets; fieldMenu: FieldMenuEntry[] } {
  const cited = new Set(citedNodeIds);
  const nodes = g.nodes.filter((n) => cited.has(n.id)).sort((a, b) => a.id.localeCompare(b.id));
  const edges = g.edges.filter((e) => cited.has(e.source) && cited.has(e.target));
  const degree = new Map<string, number>();
  for (const e of edges) { degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1); }

  // Union of parsed-attribute keys across the cited nodes, in first-seen (sorted-node) order.
  const attrKeys: string[] = [];
  const attrSeen = new Set<string>();
  for (const n of nodes) {
    for (const k of Object.keys(n.attrs ?? {})) {
      if (!attrSeen.has(k)) { attrSeen.add(k); attrKeys.push(k); }
    }
  }

  // `cited` wide rows: base columns + every attr key (missing → null).
  const citedRows: Row[] = nodes.map((n) => {
    const row: Row = { id: n.id, label: n.label, kind: n.kind, degree: degree.get(n.id) ?? 0, flagged: flaggedIds.has(n.id) };
    for (const k of attrKeys) {
      const v = n.attrs?.[k];
      row[k] = v === undefined ? null : v;
    }
    return row;
  });

  // `metrics` tidy-long rows: one row per NUMERIC attribute of a node.
  const metricRows: Row[] = [];
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n.attrs ?? {})) {
      if (typeof v === "number") metricRows.push({ nodeId: n.id, label: n.label, kind: n.kind, metric: k, value: v });
    }
  }

  const edgeRows: Row[] = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

  // Empty grounding → empty menu (composer short-circuits to the template).
  const fieldMenu: FieldMenuEntry[] = citedRows.length === 0 ? [] : [
    // cited (base)
    entry("cited", "kind", "nominal", citedRows),
    entry("cited", "label", "nominal", citedRows),
    entry("cited", "degree", "quantitative", citedRows),
    entry("cited", "flagged", "nominal", citedRows),
    // cited (parsed attrs, type inferred from their values)
    ...attrKeys.map((k) => entry("cited", k, inferType(citedRows.map((r) => r[k]).filter((v): v is string | number => v !== null && v !== undefined)), citedRows)),
    // metrics (only when there is at least one numeric attribute to explode)
    ...(metricRows.length > 0 ? [
      entry("metrics", "nodeId", "nominal", metricRows),
      entry("metrics", "label", "nominal", metricRows),
      entry("metrics", "kind", "nominal", metricRows),
      entry("metrics", "metric", "nominal", metricRows),
      entry("metrics", "value", "quantitative", metricRows),
    ] : []),
    // edges (only when the induced subgraph has any edges)
    ...(edgeRows.length > 0 ? [
      entry("edges", "source", "nominal", edgeRows),
      entry("edges", "target", "nominal", edgeRows),
      entry("edges", "kind", "nominal", edgeRows),
    ] : []),
  ];

  return { datasets: { cited: citedRows, metrics: metricRows, edges: edgeRows }, fieldMenu };
}

function entry(dataset: GenerativeDatasetName, name: string, vlType: VlType, rows: Row[]): FieldMenuEntry {
  return { name, vlType, cardinality: cardinality(rows, name), dataset };
}

export async function bindDatasets(citedNodeIds: string[]) {
  const [g, report] = await Promise.all([getFullGraph("all"), getRiskReport()]);
  const flaggedIds = new Set(report.findings.filter((f) => f.flags.length > 0).map((f) => f.nodeId));
  return bindFromGraph(g, citedNodeIds, flaggedIds);
}
