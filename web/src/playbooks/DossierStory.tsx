/**
 * DossierStory — narrates the *generated* safety-dossier run, beat by beat, with
 * live grounded visuals. This is the data-true counterpart to the static
 * `safety-dossier-story.html`: every figure here is derived STRICTLY from the run
 * payload's `citedNodeIds` intersected with the already-fetched graph (unknown ids
 * dropped, never faked) plus the per-step `faithfulness` the agent returned. It is
 * pure presentation — no new answer source, no fetch, no mutation.
 *
 * Reuses the proven grounded renderers from GroundedDiagrams (StatChart, HeroFlow,
 * EvidenceLedger, EvidenceSubgraph, CitationChips) so a step's citations pick the
 * right figure automatically:
 *   - SignalStat cited  -> PRR/ROR chart
 *   - hero AE cited     -> Drug→Target→Pathway→AE mechanism flow
 *   - any ask step      -> Known/Missing/Conflicting ledger of its cited nodes
 * The claim-trace, the cross-step faithfulness bar, and the route-to-reviewer card
 * surface run data that nothing else renders today.
 */
import { useMemo } from "react";
import type { DossierStepResult, GraphNode, GraphPayload } from "@rnd/shared";
import {
  CitationChips,
  EvidenceLedger,
  EvidenceSubgraph,
  HeroFlow,
  StatChart,
} from "../components/GroundedDiagrams.js";

const HERO_AE = "AE-MYOCARDITIS";

const BAND_COLOR: Record<string, string> = {
  high: "#0a7d4b",
  medium: "#9a6a00",
  low: "#b4231f",
};

/** A number-attr reader that never invents a value. */
function num(n: GraphNode | undefined, key: string): number | null {
  const v = n?.attrs?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface DossierStoryProps {
  /** The assembled dossier's steps, in order. */
  steps: DossierStepResult[];
  /** The live graph payload already fetched by the app — the source of all values. */
  graph: GraphPayload;
  /** "panel" = inline in the right-hand sheet; "full" = the dedicated wide surface. */
  layout?: "panel" | "full";
  /** Open the HITL review queue (checkpoint card). */
  onOpenHitl?: () => void;
}

export function DossierStory({ steps, graph, layout = "panel", onOpenHitl }: DossierStoryProps) {
  const byId = useMemo(() => {
    const m = new Map<string, GraphNode>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph]);

  const resolve = (ids?: string[]): GraphNode[] =>
    (ids ?? []).map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n));

  // Union of every cited node across the dossier — drives the closing subgraph.
  const unionCited = useMemo(() => {
    const seen = new Set<string>();
    const nodes: GraphNode[] = [];
    for (const s of steps) {
      for (const n of resolve(s.citedNodeIds)) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          nodes.push(n);
        }
      }
    }
    return nodes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, byId]);

  const unionEdges = useMemo(() => {
    const set = new Set(unionCited.map((n) => n.id));
    return graph.edges.filter((e) => set.has(e.source) && set.has(e.target));
  }, [graph.edges, unionCited]);

  const askSteps = steps.filter((s) => s.kind === "ask");

  return (
    <div className={layout === "full" ? "mx-auto w-full max-w-5xl" : "w-full"}>
      {/* Story header — title + cross-step faithfulness readout. */}
      <div className="mb-4">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Generated dossier — narrated, grounded to {unionCited.length} cited node
          {unionCited.length === 1 ? "" : "s"}
        </div>
        {askSteps.length > 0 && <FaithfulnessBar steps={askSteps} />}
      </div>

      {/* Per-step "beat" cards. */}
      <ol className="space-y-4">
        {steps.map((s, i) => (
          <StepBeat
            key={s.stepId}
            index={i + 1}
            step={s}
            cited={resolve(s.citedNodeIds)}
            graph={graph}
            byId={byId}
            onOpenHitl={onOpenHitl}
          />
        ))}
      </ol>

      {/* Closing union subgraph — the whole dossier's cited evidence, wired. */}
      {unionCited.length > 1 && (
        <div className="mt-5">
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            Dossier evidence map — every cited node + its real connections
          </div>
          <EvidenceSubgraph nodes={unionCited} edges={unionEdges} />
        </div>
      )}
    </div>
  );
}

/** One narrated step: heading, grounded answer, faithfulness claim-trace, and the
 *  figure(s) its citations select. */
function StepBeat({
  index,
  step,
  cited,
  graph,
  byId,
  onOpenHitl,
}: {
  index: number;
  step: DossierStepResult;
  cited: GraphNode[];
  graph: GraphPayload;
  byId: Map<string, GraphNode>;
  onOpenHitl?: () => void;
}) {
  const citedSet = useMemo(() => new Set(cited.map((n) => n.id)), [cited]);
  const subEdges = useMemo(
    () => graph.edges.filter((e) => citedSet.has(e.source) && citedSet.has(e.target)),
    [graph.edges, citedSet],
  );

  // PRR/ROR rows — only SignalStat nodes that actually carry a metric.
  const statRows = useMemo(
    () =>
      cited
        .filter((n) => n.kind === "SignalStat")
        .map((n) => ({ name: n.label, id: n.id, prr: num(n, "prr"), ror: num(n, "ror") }))
        .filter((r) => r.prr != null || r.ror != null),
    [cited],
  );
  const heroCited = citedSet.has(HERO_AE) && subEdges.length > 0;

  const band = step.faithfulness?.band;

  return (
    <li className="rounded-lg border bg-background p-4">
      {/* Heading row */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {index}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{step.kind}</span>
        <span className="text-sm font-semibold text-foreground">{step.title}</span>
        {band && (
          <span
            className="rounded-full border px-2 py-[1px] text-[10.5px]"
            style={{ color: BAND_COLOR[band], borderColor: BAND_COLOR[band] }}
          >
            faithfulness: {band} ({Math.round((step.faithfulness?.score ?? 0) * 100)}%)
          </span>
        )}
        {step.isFallback && (
          <span className="rounded-full border px-2 py-[1px] text-[10.5px] text-muted-foreground">
            offline / fallback
          </span>
        )}
      </div>

      {/* Grounded answer — the narration */}
      {step.answer && (
        <p className="mt-2 text-[12.5px] leading-relaxed text-foreground">{step.answer}</p>
      )}

      {/* Citation chips (non-clickable in the story). */}
      {cited.length > 0 && (
        <div className="mt-2">
          <CitationChips cited={cited} />
        </div>
      )}

      {/* Faithfulness claim-trace — currently rendered nowhere else. */}
      {step.faithfulness && <ClaimTrace faithfulness={step.faithfulness} byId={byId} />}

      {/* Checkpoint → route-to-reviewer card. */}
      {step.kind === "checkpoint" && (
        <RouteToReviewer pendingItemId={step.pendingItemId} onOpenHitl={onOpenHitl} />
      )}

      {/* Synth → closing marker. */}
      {step.kind === "synth" && (
        <div className="mt-2 rounded-md border border-primary/40 bg-primary/5 p-2.5 text-[12px] text-foreground">
          ✓ Dossier assembled — signal, mechanism, evidence, and reviewer routing bound into one
          grounded record.
        </div>
      )}

      {/* Grounded figures selected by this step's citations. */}
      {(statRows.length > 0 || heroCited || (step.kind === "ask" && cited.length > 0)) && (
        <div className="mt-3 flex flex-col gap-3">
          {statRows.length > 0 && <StatChart rows={statRows} />}
          {heroCited && <HeroFlow nodes={cited} edges={subEdges} />}
          {step.kind === "ask" && cited.length > 0 && <EvidenceLedger cited={cited} />}
        </div>
      )}
    </li>
  );
}

/** The per-claim ✓/✗ trace + any unsupported claims. Supporting nodes resolved to
 *  labels via the graph; unknown ids simply show their id (never invented). */
function ClaimTrace({
  faithfulness,
  byId,
}: {
  faithfulness: NonNullable<DossierStepResult["faithfulness"]>;
  byId: Map<string, GraphNode>;
}) {
  const claims = faithfulness.claims ?? [];
  const unsupported = faithfulness.unsupportedClaims ?? [];
  if (claims.length === 0 && unsupported.length === 0) return null;
  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  return (
    <div className="mt-3 rounded-md border p-2.5">
      <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        Claim trace — each assertion checked against the cited evidence
      </div>
      <ul className="flex flex-col gap-1.5">
        {claims.map((c, i) => (
          <li key={`c-${i}`} className="flex gap-2 text-[12px] leading-snug">
            <span
              aria-hidden
              style={{ color: c.supported ? BAND_COLOR.high : BAND_COLOR.low }}
              className="flex-none font-semibold"
            >
              {c.supported ? "✓" : "✗"}
            </span>
            <span className="min-w-0">
              <span className="text-foreground">{c.claim}</span>
              {c.supportingNodeIds.length > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  — {c.supportingNodeIds.map(labelOf).join(", ")}
                </span>
              )}
            </span>
          </li>
        ))}
        {unsupported.map((claim, i) => (
          <li key={`u-${i}`} className="flex gap-2 text-[12px] leading-snug">
            <span aria-hidden style={{ color: BAND_COLOR.low }} className="flex-none font-semibold">
              ✗
            </span>
            <span className="min-w-0 text-foreground">
              {claim}{" "}
              <span className="text-muted-foreground">— not found in cited evidence</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Route-to-reviewer status for a checkpoint step (non-blocking HITL). */
function RouteToReviewer({
  pendingItemId,
  onOpenHitl,
}: {
  pendingItemId?: string;
  onOpenHitl?: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-[12px] text-foreground">
      <span aria-hidden>⚖</span>
      <span>
        Routed to a human reviewer — awaiting sign-off
        {pendingItemId ? ` (queue item ${pendingItemId})` : ""}. The conclusion does not enter the
        dossier as final until approved.
      </span>
      {onOpenHitl && (
        <button type="button" className="underline" onClick={onOpenHitl}>
          open review queue
        </button>
      )}
    </div>
  );
}

/** Compact cross-step faithfulness bar — one column per ask step, height ∝ score. */
function FaithfulnessBar({ steps }: { steps: DossierStepResult[] }) {
  return (
    <div className="mt-2 flex items-end gap-3">
      {steps.map((s) => {
        const score = s.faithfulness?.score ?? 0;
        const band = s.faithfulness?.band ?? "low";
        const pct = Math.round(score * 100);
        return (
          <div key={s.stepId} className="flex flex-col items-center gap-1" title={`${s.title}: ${pct}%`}>
            <div className="flex h-10 w-8 items-end overflow-hidden rounded bg-muted">
              <div
                className="w-full"
                style={{ height: `${Math.max(6, pct)}%`, background: BAND_COLOR[band] }}
              />
            </div>
            <span className="text-[10px] font-medium tabular-nums" style={{ color: BAND_COLOR[band] }}>
              {pct}%
            </span>
            <span className="max-w-[64px] truncate text-[9px] text-muted-foreground">{s.title}</span>
          </div>
        );
      })}
    </div>
  );
}
