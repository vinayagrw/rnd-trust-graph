/**
 * @rnd/dashboards — the curated VERIFIED-QUERY registry (Feature 8).
 *
 * A generative dashboard's tiles are composed by the model, so a tile is only as
 * trustworthy as the query behind it. This registry is the app's small, HAND-CURATED
 * catalogue of widget patterns whose underlying computation has been validated as
 * sound (the pharmacovigilance queries the demo actually stands behind). A composed
 * widget is "certified" when its kind — drawn over cited nodes of the required kinds —
 * matches one of these patterns.
 *
 * TRUST POSTURE: certification is computed HERE, by trusted BFF code, over the REAL
 * cited nodes (id + kind, already intersected with the live graph). It is NEVER read
 * from the untrusted spec — a composed spec is structurally inert and cannot carry a
 * `certified` flag, so the model can never forge a certification. The result rides
 * ALONGSIDE the spec on the `render_dashboard` tool call (see `agent.ts` emit +
 * `aguiBridge.ts`), and the frontend renders a badge only for the widget ids named
 * here.
 *
 * Pure + dependency-free (types only) so it is unit-testable without a graph or CLI.
 */
import type { DashboardSpec, DashboardWidget, GraphNode, NodeKind } from "@rnd/shared";

/** A validated widget pattern. A widget matches when its `kind` equals `widgetKind`
 *  AND its cited nodes satisfy the kind requirements below. */
export interface VerifiedQuery {
  /** Stable id — surfaced in the audit record (`DashboardAudit.verifiedQueryIds`). */
  id: string;
  /** Human label for the badge tooltip. */
  label: string;
  /** The widget kind this pattern certifies. */
  widgetKind: DashboardWidget["kind"];
  /** Every one of these node kinds must be present among the widget's cited nodes. */
  requiresAllKinds?: NodeKind[];
  /** At least one of these node kinds must be present (provenance-bearing evidence). */
  requiresAnyKinds?: NodeKind[];
  /** Minimum number of cited nodes the widget must draw over (default 1). */
  minNodes?: number;
}

/** The curated catalogue. Deliberately small — only patterns we stand behind. */
export const VERIFIED_QUERIES: readonly VerifiedQuery[] = [
  {
    id: "vq-signal-disproportionality",
    label: "Disproportionality signal (PRR/ROR over a SignalStat)",
    widgetKind: "stat-chart",
    requiresAllKinds: ["SignalStat"],
  },
  {
    id: "vq-mechanism-flow",
    label: "Mechanism chain (adverse event → drug → target/pathway)",
    widgetKind: "hero-flow",
    requiresAllKinds: ["AdverseEvent", "Drug"],
  },
  {
    id: "vq-evidence-provenance",
    label: "Evidence ledger with cited provenance",
    widgetKind: "evidence-ledger",
    requiresAnyKinds: ["Evidence", "LiteratureAbstract", "RegulatoryDoc", "ClinicalTrial"],
  },
  {
    id: "vq-relational-subgraph",
    label: "Grounded relational subgraph (≥2 connected cited nodes)",
    widgetKind: "evidence-subgraph",
    minNodes: 2,
  },
] as const;

/** The cited nodes a widget actually draws over (its `nodeIds` subset, or all cited
 *  when the widget names none). Mirrors the renderer's `subset()`. */
function widgetNodes(
  widget: DashboardWidget,
  cited: Pick<GraphNode, "id" | "kind">[],
): Pick<GraphNode, "id" | "kind">[] {
  if (!widget.nodeIds || widget.nodeIds.length === 0) return cited;
  const want = new Set(widget.nodeIds);
  return cited.filter((n) => want.has(n.id));
}

/** Certify a single widget: return the matched verified-query id, or null. */
export function certifyWidget(
  widget: DashboardWidget,
  cited: Pick<GraphNode, "id" | "kind">[],
): string | null {
  const nodes = widgetNodes(widget, cited);
  const kinds = new Set(nodes.map((n) => n.kind));
  for (const q of VERIFIED_QUERIES) {
    if (q.widgetKind !== widget.kind) continue;
    if (nodes.length < (q.minNodes ?? 1)) continue;
    if (q.requiresAllKinds && !q.requiresAllKinds.every((k) => kinds.has(k))) continue;
    if (q.requiresAnyKinds && !q.requiresAnyKinds.some((k) => kinds.has(k))) continue;
    return q.id;
  }
  return null;
}

/** Certify every widget in a spec. Returns the certified widget ids and the unique
 *  set of verified-query ids they matched (for the audit record). */
export function certifySpec(
  spec: DashboardSpec,
  cited: Pick<GraphNode, "id" | "kind">[],
): { certified: string[]; verifiedQueryIds: string[] } {
  const certified: string[] = [];
  const queryIds = new Set<string>();
  for (const w of spec.widgets) {
    const q = certifyWidget(w, cited);
    if (q) {
      certified.push(w.id);
      queryIds.add(q);
    }
  }
  return { certified, verifiedQueryIds: Array.from(queryIds) };
}
