/**
 * @rnd/dashboards — the declarative DashboardSpec contract.
 *
 * A generative dashboard is composed by the LLM (or a deterministic template
 * fallback) and rendered by a TRUSTED frontend widget registry that reuses the
 * existing grounded primitives (GroundedDiagrams / GraphCanvas / recharts /
 * Mermaid-strict). The spec is the seam between them.
 *
 * GROUNDED-BY-CONSTRUCTION — the invariant the whole design turns on:
 *   - The spec is STRUCTURALLY INERT. A widget can only name a `kind`, a free-text
 *     `title`, a subset of already-cited node ids, and (for a metric tile) one of a
 *     FIXED enum of server-computed metrics. There is NO field in which a number,
 *     URL, HTML string, or Mermaid source can be expressed. The renderer owns every
 *     value; the composer only ever chooses WHICH widget and over WHICH cited nodes.
 *   - `citedNodeIds` is the answer's real citation set (ids the read-only agent
 *     touched, intersected with the live graph). Every `widget.nodeIds` MUST be a
 *     subset of it — enforced by the BFF Zod schema before emit.
 *   - HITL / approval affordances are DELIBERATELY NOT expressible here. Approval
 *     dialogs are host-chrome only (see CopilotChatBeat `useHumanInTheLoop`), so a
 *     composed spec can never forge an "Approve" control (UI-impersonation guard).
 *
 * This file holds PLAIN TYPES only. `@rnd/shared` is consumed as raw TS by both
 * workspaces and carries no zod dependency; the authoritative runtime schema lives
 * in the BFF (`bff/src/dashboards/schema.ts`, Zod v4), and the web renderer
 * re-declares a light Zod v3 arg schema at the tool-call boundary.
 */

import type { RoutineCadence } from "./types.js";

/** Widget kinds — each maps 1:1 to an existing grounded render primitive. */
export type DashboardWidgetKind =
  | "citation-chips" // CitationChips — clickable cited-node chips
  | "coverage-header" // CoverageConflictHeader — coverage % + conflict/gap flags
  | "evidence-ledger" // EvidenceLedger — Known / Missing / Conflicting
  | "evidence-subgraph" // EvidenceSubgraph — force-graph of cited nodes + real edges
  | "stat-chart" // StatChart — PRR/ROR bars (only when SignalStat nodes are cited)
  | "hero-flow" // HeroFlow — Mermaid AE→Drug→Target→Pathway (only when hero AE cited)
  | "metric"; // a single KPI tile whose value comes ONLY from `metric` below

/** The FIXED set of server-computed metrics a `metric` tile may show. There is no
 *  way to supply a literal value — the renderer derives each from data it already
 *  holds (the faithfulness verdict, the cited-node count, the coverage classifier). */
export type DashboardMetric = "faithfulness" | "cited-count" | "coverage";

/** One tile. `nodeIds` narrows the cited set this tile draws from (omit = all
 *  cited). `metric` is required iff `kind === "metric"`. No other data channel. */
export interface DashboardWidget {
  /** Stable id — used to merge/patch a tile in place on a follow-up turn (Phase 2). */
  id: string;
  kind: DashboardWidgetKind;
  /** Free-text heading, rendered as escaped text (never interpreted as HTML). */
  title?: string;
  /** Cited node ids this widget draws from; MUST be ⊆ `DashboardSpec.citedNodeIds`. */
  nodeIds?: string[];
  /** Only for `kind: "metric"` — which fixed server metric to display. */
  metric?: DashboardMetric;
  /** Presentational column span (1 = half width, 2 = full width). */
  span?: 1 | 2;
}

/** How a spec was produced: `llm` = composed by the model; `template` = the
 *  deterministic safety-net builder (invalid/timeout/repair-exhausted/non-grounded). */
export type DashboardSource = "llm" | "template";

/** A complete generative dashboard. Emitted over the AG-UI `render_dashboard`
 *  tool call, and the persisted unit for save/share (Phase 3). */
export interface DashboardSpec {
  /** Schema version — bump on any breaking shape change. */
  version: 1;
  /** Dashboard heading (free text, escaped on render). */
  title: string;
  /** The question this dashboard answers — header subtitle + audit context. */
  intent?: string;
  widgets: DashboardWidget[];
  /** The grounding root: the answer's real cited node ids. Non-empty by contract. */
  citedNodeIds: string[];
  source: DashboardSource;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 8 — certified-tile audit record.
 *
 * The TRUST payload behind a "certified" tile. Computed by TRUSTED BFF code (never
 * the model) and delivered ALONGSIDE the spec on the `render_dashboard` tool call —
 * NOT inside the inert spec (a composed spec can never forge a certification). It
 * composes the app's existing observability ledgers: the FinOps entry (which model,
 * and `estimated:false` = a real live call, the definitive live-vs-cached proof) and
 * the answer's faithfulness verdict (the eval signal), plus which curated
 * verified-query patterns the composed widgets matched.
 * ──────────────────────────────────────────────────────────────────────────── */
export interface DashboardAudit {
  /** The model that composed this dashboard (from the FinOps ledger). */
  model?: string;
  /** False ⇒ a real live model call recorded real token usage (live-mode proof);
   *  true/absent ⇒ estimated or cached — the badge stays "unverified live". */
  estimated?: boolean;
  /** The grounded answer's faithfulness score (0..1), when a verdict was produced. */
  faithfulnessScore?: number;
  /** The faithfulness band (`high` | `medium` | `low`) for the badge colour. */
  faithfulnessBand?: string;
  /** Ids of the curated verified-query patterns the composed widgets matched. */
  verifiedQueryIds: string[];
  /** How many widgets are certified (⊆ the spec's widgets). */
  certifiedCount: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 7 — live agent-patched dashboards.
 *
 * A follow-up turn composes a NEW dashboard; rather than replacing the board
 * wholesale, we MERGE it into the prior one by widget id — append-only by default
 * (existing tiles never reflow), update-in-place when an id recurs. This pure
 * function is the engine; the web keeps a single-lineage store around it, and the
 * renderer pulses the widgets that actually changed. Grounding is preserved: the
 * merged `citedNodeIds` is the UNION, and the renderer resolves every id against the
 * live graph (unknown ids are dropped, never fabricated).
 * ──────────────────────────────────────────────────────────────────────────── */

/** The result of merging a follow-up dashboard into the prior one. */
export interface MergedDashboard {
  spec: DashboardSpec;
  /** Widget ids that were added or updated by the merge — for the change pulse. */
  changedIds: string[];
}

/** Merge `next` into `prev` by widget id. `prev == null` ⇒ `next` is the first board
 *  (every widget is "changed"). Existing widgets keep their position and are updated
 *  in place when their id recurs in `next`; genuinely new widgets are appended. The
 *  merged spec's `citedNodeIds` is the de-duplicated union so no grounding is lost. */
export function mergeDashboard(prev: DashboardSpec | null, next: DashboardSpec): MergedDashboard {
  if (!prev) {
    return { spec: next, changedIds: next.widgets.map((w) => w.id) };
  }

  const nextById = new Map(next.widgets.map((w) => [w.id, w]));
  const changed: string[] = [];

  // 1. Keep prior widgets in order; update in place where `next` re-declares the id.
  const merged: DashboardWidget[] = prev.widgets.map((prevW) => {
    const incoming = nextById.get(prevW.id);
    if (!incoming) return prevW;
    // Only mark as changed when the incoming widget actually differs.
    if (JSON.stringify(incoming) !== JSON.stringify(prevW)) changed.push(prevW.id);
    return incoming;
  });

  // 2. Append widgets that are new to this lineage (never reflow existing tiles).
  const priorIds = new Set(prev.widgets.map((w) => w.id));
  for (const w of next.widgets) {
    if (!priorIds.has(w.id)) {
      merged.push(w);
      changed.push(w.id);
    }
  }

  const citedNodeIds = Array.from(new Set([...prev.citedNodeIds, ...next.citedNodeIds]));

  return {
    spec: {
      version: 1,
      // The latest turn owns the heading/intent/source (it's the current question).
      title: next.title,
      intent: next.intent ?? prev.intent,
      widgets: merged,
      citedNodeIds,
      source: next.source,
    },
    changedIds: changed,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 9 — scheduled dashboard snapshots + delta briefs.
 *
 * A `DashboardSchedule` recomposes a saved question's dashboard on a cadence,
 * HEADLESS, through the SAME grounded composer the chat uses. It is pure
 * ORCHESTRATION config (like a `PlaybookRoutine`): it decides WHEN and over WHICH
 * already-cited nodes a board is re-composed; it holds no answers and writes no
 * graph triples. Each fire produces a `DashboardSnapshot` whose `brief` summarises
 * what changed vs the prior snapshot (via `mergeDashboard`'s `changedIds`).
 * ──────────────────────────────────────────────────────────────────────────── */

/** A recurring schedule that recomposes one saved dashboard on a cadence. Keyed by
 *  a stable `key` (one schedule per key — upsert). Mirrors `PlaybookRoutine`. */
export interface DashboardSchedule {
  id: string;
  /** Stable key for the saved question/board this schedule snapshots (one per key). */
  key: string;
  /** Human title for the board (header + brief context). */
  title: string;
  /** The grounded question this board answers — replayed headless each fire. */
  question: string;
  /** The answer's real cited node ids — the grounding root the composer filters to. */
  citedNodeIds: string[];
  cadence: RoutineCadence;
  /** 5-field cron (min hour dom month dow). Presets persist as their cron too. */
  cron: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  /** Pointer into the snapshot history for the most recent snapshot. */
  lastSnapshotId?: string;
  /** Computed on read (NOT persisted): next fire time in epoch ms, or null. */
  nextRunAt?: number | null;
}

/** One recorded recomposition of a scheduled dashboard — a light audit/history
 *  entry plus the delta brief. Holds the composed spec so the NEXT snapshot can
 *  diff against it; never a new answer source (the spec is inert). */
export interface DashboardSnapshot {
  id: string;
  scheduleId: string;
  key: string;
  title: string;
  startedAt: number;
  finishedAt?: number;
  status: "ok" | "error";
  /** Whether the scheduler fired it or a user pressed "Run now". */
  trigger: "schedule" | "manual";
  /** How the spec was produced (llm | template), when one was composed. */
  source?: DashboardSource;
  widgetCount: number;
  /** Widget ids added/changed vs the prior snapshot (from `mergeDashboard`). */
  changedIds: string[];
  /** One-line human brief, e.g. "6 widgets · 2 changed vs prior". */
  brief: string;
  /** The composed spec captured at snapshot time — the diff base for the next run. */
  spec?: DashboardSpec;
  error?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Feature 10 — publish / save / share.
 *
 * A `SavedDashboard` is a chat-composed board turned into a durable, refreshable
 * record. It persists the INERT `DashboardSpec` plus the TRUSTED `DashboardAudit`
 * (never inside the spec). Persistence writes NO graph triples; the optional
 * "Send → Review" governance wrap routes a review request through the existing HITL
 * queue (record-decision-only, empty ops), so a published board carries a
 * reversible, reviewer-stamped audit trail.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A saved/published dashboard record (persisted unit for save/share). */
export interface SavedDashboard {
  id: string;
  title: string;
  /** The inert composed spec. */
  spec: DashboardSpec;
  /** The trusted audit record that rode alongside the spec at compose time. */
  audit?: DashboardAudit;
  savedAt: number;
  updatedAt: number;
  savedBy?: string;
}
