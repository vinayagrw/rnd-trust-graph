/**
 * Deterministic dashboard template — the safety net.
 *
 * The composer's LLM path is primary (the user's choice), but the app must NEVER
 * render nothing and NEVER render something ungrounded. This pure function builds a
 * valid, grounded `DashboardSpec` from the answer's cited nodes alone — no LLM, no
 * I/O — and is used whenever the LLM spec fails validation, exhausts repairs, times
 * out, or live mode is unavailable. It mirrors the widget-selection logic that
 * `GroundedDiagrams` already applies (SignalStat → stat chart, hero AE → hero flow),
 * so the fallback looks like a first-class answer, not a degraded one.
 *
 * Deterministic by contract: same inputs → byte-identical spec (asserted in tests),
 * so the fallback is reproducible for audit.
 */
import type { DashboardSpec, DashboardWidget, GraphNode } from "@rnd/shared";

/** The pinned hero adverse-event id — cited ⇒ the Mermaid mechanism flow applies
 *  (same constant GroundedDiagrams keys its HeroFlow on). */
const HERO_AE = "AE-MYOCARDITIS";

export interface TemplateInput {
  /** The user's question — becomes the dashboard intent/subtitle. */
  question: string;
  /** The real cited nodes (already intersected with the live graph). */
  citedNodes: Pick<GraphNode, "id" | "kind">[];
  /** The router strategy, if known — currently informational (title only). */
  strategy?: string;
}

/** Build the deterministic grounded spec. Assumes ≥1 cited node (the caller only
 *  composes on a grounded, cited answer); returns a spec with `source: "template"`. */
export function templateDashboard(input: TemplateInput): DashboardSpec {
  const citedNodeIds = input.citedNodes.map((n) => n.id);
  const hasSignalStat = input.citedNodes.some((n) => n.kind === "SignalStat");
  const heroCited = citedNodeIds.includes(HERO_AE);

  // Stable, curated widget order — the same reading order GroundedDiagrams uses.
  const widgets: DashboardWidget[] = [
    { id: "w-metric-faithfulness", kind: "metric", metric: "faithfulness", span: 1 },
    { id: "w-metric-coverage", kind: "metric", metric: "coverage", span: 1 },
    { id: "w-chips", kind: "citation-chips", title: "Cited evidence", span: 2 },
    { id: "w-coverage", kind: "coverage-header", title: "Coverage & conflicts", span: 2 },
    { id: "w-ledger", kind: "evidence-ledger", title: "Known · Missing · Conflicting", span: 2 },
    { id: "w-subgraph", kind: "evidence-subgraph", title: "Evidence subgraph", span: 2 },
  ];

  if (hasSignalStat) {
    widgets.push({ id: "w-stat", kind: "stat-chart", title: "Disproportionality (PRR / ROR)", span: 2 });
  }
  if (heroCited) {
    widgets.push({ id: "w-hero", kind: "hero-flow", title: "Mechanism flow", span: 2 });
  }

  return {
    version: 1,
    title: "Evidence dashboard",
    intent: input.question.slice(0, 400),
    widgets,
    citedNodeIds,
    source: "template",
  };
}
