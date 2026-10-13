/**
 * @rnd/dashboards — per-surface lineage merge store (Feature 7, keyed for Studio in
 * a follow-up feature).
 *
 * A follow-up turn composes a NEW dashboard. Rather than replacing the board, we
 * MERGE it into the prior one (`mergeDashboard`) so the dashboard evolves in place as
 * the investigation continues — append-only by default, update-in-place when a widget
 * id recurs. This module holds the "current" board per `DashboardSurface` and feeds
 * the pure merge engine. The Conversation beat and the Dashboard Studio surface each
 * get their own isolated lineage so they never bleed into each other.
 *
 * Idempotency: a React tool-call renderer re-runs on every re-render with the SAME
 * incoming spec — CopilotKit re-renders the whole transcript on every message change,
 * so EVERY historical `render_dashboard` call replays here. A bounded sig→result
 * cache (`applied`) makes any already-applied spec an O(1) hit with no re-merge and
 * no notify (kills the O(N²) churn a single last-sig cache allowed). One exception:
 * a cache hit that carries `final` still marks the commit point — a run whose final
 * reconcile is byte-identical to one of its own deltas must not lose its commit —
 * so it commits the board AS IT STANDS and re-syncs the persisted envelope.
 *
 * Run-generation gate + commit/rollback: each streaming run carries a `runId` (and
 * `final: true` on its reconcile) ALONGSIDE the spec in the tool-call args — never
 * inside the inert spec. `committed` is the board as of the last FINAL reconcile;
 * when a genuinely NEW run starts we roll `current` back to it, so a failed run's
 * partial tiles never survive into the retry's merge. A re-render of a RETIRED run
 * (seen before, no longer active) is stale and dropped outright. Calls without a
 * runId (back-compat) skip the gate and merge exactly as before.
 *
 * Continuity: two genuinely unrelated boards (a fresh question with no shared widget
 * id and no shared cited node) start a NEW lineage instead of accumulating stale
 * tiles — so the board only "grows" while the user drills into the same subject.
 *
 * Grounding is untouched — merge only unions ids; the renderer still resolves every
 * id against the live graph and drops unknowns.
 */
import { mergeDashboard, type DashboardAudit, type DashboardSpec, type MergedDashboard } from "@rnd/shared";

export type DashboardSurface = "studio" | "conversation";

const STUDIO_KEY = "rtg.studio.board";

interface SurfaceState {
  current: DashboardSpec | null;
  /** Board as of the last FINAL reconcile — the rollback base when a new run starts
   *  (a failed run's partial tiles must not survive into the next run's merge). */
  committed: DashboardSpec | null;
  /** The active dashboard run; deltas from retired runs are stale and dropped. */
  runId: string | null;
  /** Every run id ever seen on this surface (bounded) — distinguishes a genuinely
   *  NEW run (roll back to committed) from a STALE re-render of a retired run (drop). */
  seenRuns: Set<string>;
  /** sig → merge result cache (bounded) — a re-render of an already-applied spec is
   *  an O(1) cache hit with NO re-merge, NO notify, NO persist (kills the O(N²) churn). */
  applied: Map<string, MergedDashboard>;
  certified: string[];
  audit: DashboardAudit | null;
}

function freshState(): SurfaceState {
  return {
    current: null,
    committed: null,
    runId: null,
    seenRuns: new Set(),
    applied: new Map(),
    certified: [],
    audit: null,
  };
}

const states: Record<DashboardSurface, SurfaceState> = {
  studio: freshState(),
  conversation: freshState(),
};

const listeners: Record<DashboardSurface, Set<() => void>> = {
  studio: new Set(),
  conversation: new Set(),
};

/** A stable content signature for an incoming spec (order-sensitive is fine — the
 *  composer/template emit deterministic order). */
function signature(spec: DashboardSpec): string {
  return JSON.stringify(spec);
}

/** True when `next` continues `prev`'s subject (shares a widget id or a cited node).
 *  Unrelated boards start a fresh lineage. */
function continues(prev: DashboardSpec, next: DashboardSpec): boolean {
  const prevWidgetIds = new Set(prev.widgets.map((w) => w.id));
  if (next.widgets.some((w) => prevWidgetIds.has(w.id))) return true;
  const prevCited = new Set(prev.citedNodeIds);
  return next.citedNodeIds.some((id) => prevCited.has(id));
}

function notify(surface: DashboardSurface): void {
  for (const listener of listeners[surface]) listener();
}

/** Persist the Studio board to sessionStorage as a versioned envelope:
 *  `{ current: DashboardSpec, committed: DashboardSpec | null }`. The committed
 *  base rides along so a tab reload can restore the working board for DISPLAY
 *  without promoting a never-finalized partial to the rollback base. */
function persistStudio(surface: DashboardSurface, st: SurfaceState): void {
  if (surface !== "studio" || !st.current) return;
  try {
    sessionStorage.setItem(STUDIO_KEY, JSON.stringify({ current: st.current, committed: st.committed }));
  } catch { /* best-effort (private mode / no DOM) */ }
}

/** Subscribe to merge/reset events for a surface. Returns an unsubscribe function. */
export function subscribe(surface: DashboardSurface, listener: () => void): () => void {
  listeners[surface].add(listener);
  return () => listeners[surface].delete(listener);
}

/** Merge an incoming board into the active lineage for `surface` and return the
 *  merged board plus the widget ids that changed (for the renderer's patch pulse).
 *  `meta` carries the transport-channel run metadata (`runId`, `final`) — optional,
 *  so callers without it (back-compat) merge exactly as before.
 *  Defaults to the "conversation" surface for back-compat with existing callers. */
export function applyIncoming(
  spec: DashboardSpec,
  surface: DashboardSurface = "conversation",
  meta?: { runId?: string; final?: boolean },
): MergedDashboard {
  const st = states[surface];

  // 1. Run gate (only when the call carries a runId).
  if (meta?.runId) {
    if (meta.runId === st.runId) {
      // Same run — fall through to the normal merge.
    } else if (st.seenRuns.has(meta.runId)) {
      // Stale re-render of a RETIRED run — drop: no merge, no notify, no persist.
      return { spec: st.current ?? spec, changedIds: [] };
    } else {
      // Genuinely NEW run: roll back to the committed base so a failed run's
      // uncommitted partials never survive into this run's merge.
      st.seenRuns.add(meta.runId);
      if (st.seenRuns.size > 100) {
        const oldest = st.seenRuns.values().next().value;
        if (oldest !== undefined) st.seenRuns.delete(oldest);
      }
      st.runId = meta.runId;
      st.current = st.committed;
      // A byte-identical delta from the NEW run must re-merge from the rolled-back
      // base, not hit a stale cache entry.
      st.applied.clear();
    }
  }

  // 2. Sig cache — an already-applied spec is an O(1) hit (no re-merge, no notify).
  const sig = signature(spec);
  const cached = st.applied.get(sig);
  if (cached) {
    if (meta?.final) {
      // A final that is byte-identical to an already-applied delta of the SAME run
      // still marks the commit point. Commit the board AS IT STANDS (`st.current`,
      // not `cached.spec` — within a run, current may have advanced past an
      // early-applied sig; the non-cached final path commits the post-merge current,
      // so this stays congruent) and keep the persisted envelope in sync. No notify
      // — current is unchanged.
      st.committed = st.current;
      persistStudio(surface, st);
    }
    return cached;
  }

  // 3. Merge (unchanged semantics).
  const base = st.current && continues(st.current, spec) ? st.current : null;
  const result = mergeDashboard(base, spec);
  st.current = result.spec;

  // 4. Commit point — the run's final reconcile becomes the next rollback base.
  if (meta?.final) st.committed = result.spec;

  // 5. Bounded cache write, studio persist, notify.
  if (st.applied.size >= 64) {
    const oldestKey = st.applied.keys().next().value;
    if (oldestKey !== undefined) st.applied.delete(oldestKey);
  }
  st.applied.set(sig, result);
  persistStudio(surface, st);
  notify(surface);
  return result;
}

/** Reset the lineage for a surface (e.g. when the conversation thread changes).
 *  Defaults to the "conversation" surface for back-compat with existing callers. */
export function resetLineage(surface: DashboardSurface = "conversation"): void {
  states[surface] = freshState();
  if (surface === "studio") {
    try { sessionStorage.removeItem(STUDIO_KEY); } catch { /* best-effort */ }
  }
  notify(surface);
}

let pendingStudioReset: ReturnType<typeof setTimeout> | null = null;

/** Deferred beat-leave reset. StrictMode's dev-only mount→cleanup→remount must not
 *  wipe the rehydrated board, so cleanup SCHEDULES the clear on a macrotask and the
 *  immediate remount cancels it; a real unmount lets it fire on the next tick. */
export function scheduleStudioReset(): void {
  cancelScheduledStudioReset();
  pendingStudioReset = setTimeout(() => {
    pendingStudioReset = null;
    resetLineage("studio");
  }, 0);
}

export function cancelScheduledStudioReset(): void {
  if (pendingStudioReset != null) {
    clearTimeout(pendingStudioReset);
    pendingStudioReset = null;
  }
}

/** Read the current merged spec for a surface (Studio pane pulls this on notify). */
export function currentSpec(surface: DashboardSurface): DashboardSpec | null {
  return states[surface].current;
}

/** Store the trusted (BFF-computed) certification + audit for a surface's current
 *  board. These ride alongside the spec on the final render_dashboard; the Studio
 *  pane reads them to show certified badges + the audit line + Save. */
export function setSurfaceTrust(surface: DashboardSurface, certified: string[], audit: DashboardAudit | null): void {
  states[surface].certified = certified;
  states[surface].audit = audit;
  notify(surface);
}

export function currentTrust(surface: DashboardSurface): { certified: string[]; audit: DashboardAudit | null } {
  return { certified: states[surface].certified, audit: states[surface].audit };
}

/** Restore a persisted Studio working board (survives a tab RELOAD; an intentional
 *  beat-leave clears it via resetLineage). The stored envelope carries BOTH the
 *  working board (`current`, restored for DISPLAY) and the last committed base
 *  (`committed`, the rollback base). A never-finalized partial (committed: null)
 *  is display-only — it must NOT become the rollback base, so the next run starts
 *  from the committed base and the partial disappears. A LEGACY bare-spec value
 *  (pre-envelope) hydrates as both (old behavior, one-deploy overlap).
 *  No-op for other surfaces / no storage. */
export function rehydrate(surface: DashboardSurface): void {
  if (surface !== "studio") return;
  try {
    const raw = sessionStorage.getItem(STUDIO_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { current?: DashboardSpec | null; committed?: DashboardSpec | null; widgets?: unknown };
    const legacy = Array.isArray(parsed?.widgets);
    const current = legacy ? (parsed as unknown as DashboardSpec) : parsed.current ?? null;
    const committed = legacy ? (parsed as unknown as DashboardSpec) : parsed.committed ?? null;
    if (!current) return;
    states.studio = { ...freshState(), current, committed };
    notify("studio");
  } catch { /* best-effort */ }
}
