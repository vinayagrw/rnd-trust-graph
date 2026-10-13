/**
 * HITL panel — the human-in-the-loop mutate + revert governance surface.
 *
 * Two halves:
 *   - PENDING QUEUE: proposed governed changes a reviewer can Approve / Reject /
 *     Escalate. Each shows the plain-English effect of approving. Approve calls
 *     POST /api/hitl/apply, which mutates the graph through the AUTHORIZED writer
 *     on the BFF (Neo4j write() + RDF store update — NEVER the read-only agent/MCP
 *     path) and returns the resulting ChangeSet.
 *   - AUDIT LOG: every change set with its status (applied / reverted) and a
 *     Revert button that replays its inverse ops to restore exact prior state.
 *
 * Reuses the scoped-Tailwind sheet idiom + shadcn Button from AdminPanel (mounted
 * under `.admin-root` so its styles never leak into the hand-styled beats). After
 * any apply/revert it calls onChanged() so App can refetch the graph + radar.
 */
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import {
  ShieldCheck,
  Check,
  X,
  ArrowUpRight,
  RotateCcw,
  Loader2,
  ChevronRight,
  Sparkles,
  MessageSquarePlus,
} from "lucide-react";
import type { HitlPendingItem, ChangeSet, ChangeOp } from "@rnd/shared";
import { hitlApi, type HitlDecision } from "../api.js";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import "../admin/admin.css";

/** Plain-English label for one reversible op (mirrors the BFF's describeOp — kept
 *  client-side so the audit detail renders the forward/inverse ops without a
 *  round-trip). */
function opLabel(op: ChangeOp): string {
  switch (op.op) {
    case "addEdge":
      return `link ${op.source} —${op.kind}→ ${op.target}`;
    case "removeEdge":
      return `remove ${op.source} —${op.kind}→ ${op.target}`;
    case "setProp":
      return `set ${op.nodeId}.${op.prop} = "${op.value}"`;
    case "unsetProp":
      return `clear ${op.nodeId}.${op.prop}`;
    case "addProvenance":
      return `attach provenance to ${op.nodeId}`;
    case "removeProvenance":
      return `remove provenance from ${op.nodeId}`;
    case "setFlagResolved":
      return `resolve "${op.flag}" flag on ${op.nodeId}`;
    case "clearFlagResolved":
      return `re-open "${op.flag}" flag on ${op.nodeId}`;
    case "addManualFlag":
      return `raise manual "${op.flag}" flag on ${op.nodeId}`;
    case "removeManualFlag":
      return `clear manual "${op.flag}" flag on ${op.nodeId}`;
    case "addEdgeTag":
      return `tag ${op.source} —${op.kind}→ ${op.target} as "${op.tag}"`;
    case "removeEdgeTag":
      return `remove "${op.tag}" tag from ${op.source} —${op.kind}→ ${op.target}`;
  }
}

/** Distinct node ids a change touches (target + every op's node/endpoints) — drives
 *  the affected-node chips and the nodes added to the Ask context. */
function changeNodeIds(cs: ChangeSet): string[] {
  const ids = new Set<string>();
  if (cs.targetNodeId) ids.add(cs.targetNodeId);
  for (const op of cs.forwardOps) {
    if ("source" in op) {
      ids.add(op.source);
      ids.add(op.target);
    } else {
      ids.add(op.nodeId);
    }
  }
  return [...ids];
}

/** Lazy-loaded suggested-question state per change set. */
interface SuggestState {
  loading: boolean;
  questions: string[];
  grounded: boolean;
}

export function HitlPanel({
  onClose,
  onChanged,
  onAddToContext,
}: {
  onClose: () => void;
  onChanged?: () => void;
  /** Add a governed change (+ its node(s)) to the Ask context, optionally seeding
   *  a question — routes to the grounded conversation surface (Beat 4). */
  onAddToContext?: (cs: ChangeSet, question?: string) => void;
}) {
  const [items, setItems] = useState<HitlPendingItem[]>([]);
  const [changeSets, setChangeSets] = useState<ChangeSet[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [decided, setDecided] = useState<Record<string, HitlDecision>>({});
  // Which audit entry is expanded inline, + its lazily-fetched suggested questions.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Record<string, SuggestState>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  /** Toggle an audit entry's inline detail; on first expand, lazy-load its
   *  LLM-suggested questions (cached per change set; templated fallback on error). */
  function toggleExpand(cs: ChangeSet) {
    setExpandedId((cur) => (cur === cs.id ? null : cs.id));
    if (suggest[cs.id]) return; // already loaded (or loading)
    setSuggest((s) => ({ ...s, [cs.id]: { loading: true, questions: [], grounded: false } }));
    hitlApi
      .suggestQuestions(cs.id)
      .then((r) =>
        setSuggest((s) => ({ ...s, [cs.id]: { loading: false, questions: r.questions, grounded: r.grounded } })),
      )
      .catch(() =>
        setSuggest((s) => ({ ...s, [cs.id]: { loading: false, questions: [], grounded: false } })),
      );
  }

  async function refresh() {
    // On a failed fetch keep the last-good list (return null, don't blank to []) —
    // otherwise a transient error masks a live queue as "(0) No pending items".
    // Mirrors ReviewBell's "never blanks" behaviour. ([] is a real empty queue.)
    const [pend, cs] = await Promise.all([
      hitlApi.pending().then((p) => p, () => null),
      hitlApi.changesets().then((c) => c, () => null),
    ]);
    if (pend) setItems(pend);
    if (cs) setChangeSets(cs);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function decide(item: HitlPendingItem, decision: HitlDecision) {
    setBusy(item.id);
    try {
      const res = await hitlApi.apply(item.id, decision);
      setDecided((d) => ({ ...d, [item.id]: decision }));
      if (res.mutated) {
        toast.success(`Approved — applied "${item.title}"`);
        onChanged?.();
      } else {
        toast.message(`Recorded ${decision} (no mutation)`);
      }
      await refresh();
    } catch (err) {
      toast.error(`Apply failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function revert(cs: ChangeSet) {
    setBusy(cs.id);
    try {
      await hitlApi.revert(cs.id);
      toast.success(`Reverted — restored prior state for "${cs.title}"`);
      onChanged?.();
      await refresh();
    } catch (err) {
      toast.error(`Revert failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-root fixed inset-0 z-[1000] flex justify-end bg-black/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Human-in-the-loop review queue"
        className="flex h-full w-full max-w-2xl flex-col bg-background shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ShieldCheck className="size-5 text-primary" />
              Human-in-the-Loop — mutate &amp; revert
            </div>
            <p className="text-xs text-muted-foreground">
              Governed, reversible graph writes. Approving applies a change through the
              authorized writer (Neo4j + RDF store) — never the read-only agent path. Every
              change is fully revertible.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close HITL panel">
            Close
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Pending queue */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Pending queue ({items.length})
            </h3>
            {items.length === 0 && (
              <p className="text-sm text-muted-foreground">No pending items.</p>
            )}
            <div className="space-y-3">
              {items.map((item) => {
                const d = decided[item.id];
                return (
                  <div key={item.id} className="rounded-lg border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">{item.title}</div>
                        <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                      </div>
                      {item.targetNodeId && (
                        <Badge variant="outline" className="shrink-0 font-mono text-xs">
                          {item.targetNodeId}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 rounded-md bg-muted/50 p-2 text-xs text-foreground">
                      <span className="font-semibold">Effect: </span>
                      {item.effect}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => decide(item, "approve")}
                        disabled={busy === item.id}
                      >
                        {busy === item.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Check className="size-4" />
                        )}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decide(item, "reject")}
                        disabled={busy === item.id}
                      >
                        <X className="size-4" /> Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decide(item, "escalate")}
                        disabled={busy === item.id}
                      >
                        <ArrowUpRight className="size-4" /> Escalate
                      </Button>
                      {d && (
                        <span className="text-xs text-muted-foreground">
                          last decision: <strong>{d}</strong>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Audit log */}
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Audit log ({changeSets.length})
            </h3>
            {changeSets.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No change sets yet — approve a pending item to record one.
              </p>
            )}
            <div className="space-y-2">
              {changeSets.map((cs) => {
                const expanded = expandedId === cs.id;
                const sug = suggest[cs.id];
                const nodeIds = changeNodeIds(cs);
                return (
                  <div key={cs.id} className="rounded-lg border bg-card">
                    {/* Clickable header — toggles the inline detail. The Revert
                        button stops propagation so it never also toggles. */}
                    <div className="flex items-center justify-between gap-3 p-3">
                      <button
                        type="button"
                        onClick={() => toggleExpand(cs)}
                        aria-expanded={expanded}
                        aria-controls={`cs-detail-${cs.id}`}
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                      >
                        <ChevronRight
                          className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${
                            expanded ? "rotate-90" : ""
                          }`}
                        />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <Badge variant={cs.status === "applied" ? "default" : "secondary"}>
                              {cs.status}
                            </Badge>
                            <span className="truncate text-sm font-medium text-foreground">
                              {cs.title}
                            </span>
                          </span>
                          <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
                            {cs.ts} · {cs.actor}
                            {cs.reviewer?.role ? ` (${cs.reviewer.role})` : ""}
                            {cs.purpose ? ` · purpose: ${cs.purpose}` : ""}
                            {cs.targetNodeId ? ` · ${cs.targetNodeId}` : ""}
                          </span>
                        </span>
                      </button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={cs.status === "reverted" || busy === cs.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          revert(cs);
                        }}
                      >
                        {busy === cs.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RotateCcw className="size-4" />
                        )}
                        Revert
                      </Button>
                    </div>

                    {/* Inline detail card */}
                    {expanded && (
                      <div id={`cs-detail-${cs.id}`} className="border-t px-3 pb-3 pt-3 space-y-3">
                        {cs.description && (
                          <p className="text-sm text-muted-foreground">{cs.description}</p>
                        )}

                        {/* Forward → inverse ops */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Applied
                            </div>
                            <ul className="space-y-1">
                              {cs.forwardOps.map((op, i) => (
                                <li
                                  key={i}
                                  className="rounded bg-muted/50 px-2 py-1 font-mono text-[11px] text-foreground"
                                >
                                  {opLabel(op)}
                                </li>
                              ))}
                            </ul>
                          </div>
                          <div>
                            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Reverts with
                            </div>
                            <ul className="space-y-1">
                              {cs.inverseOps.map((op, i) => (
                                <li
                                  key={i}
                                  className="rounded bg-muted/50 px-2 py-1 font-mono text-[11px] text-muted-foreground"
                                >
                                  {opLabel(op)}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        {/* Affected nodes */}
                        {nodeIds.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              Affected:
                            </span>
                            {nodeIds.map((id) => (
                              <Badge key={id} variant="outline" className="font-mono text-[11px]">
                                {id}
                              </Badge>
                            ))}
                          </div>
                        )}

                        {/* Ask about this change — add to context + suggested questions */}
                        {onAddToContext && (
                          <div className="rounded-md border border-dashed p-2.5 space-y-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <Sparkles className="size-3.5 text-primary" />
                                Ask about this change
                              </span>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => onAddToContext(cs)}
                                title="Add this change and its node(s) to the conversation context"
                              >
                                <MessageSquarePlus className="size-4" /> Add to context
                              </Button>
                            </div>
                            {sug?.loading && (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin" /> Generating questions…
                              </div>
                            )}
                            {sug && !sug.loading && sug.questions.length > 0 && (
                              <>
                                <div className="flex flex-wrap gap-1.5">
                                  {sug.questions.map((q, i) => (
                                    <button
                                      key={`${q}-${i}`}
                                      type="button"
                                      onClick={() => onAddToContext(cs, q)}
                                      title={q}
                                      className="rounded-full border bg-primary/5 px-2.5 py-1 text-left text-xs text-foreground hover:bg-primary/10"
                                    >
                                      {q}
                                    </button>
                                  ))}
                                </div>
                                <p className="text-[10px] text-muted-foreground">
                                  {sug.grounded
                                    ? "Suggested by the model · answered from the live graph"
                                    : "Suggested questions · answered from the live graph"}
                                </p>
                              </>
                            )}
                            {sug && !sug.loading && sug.questions.length === 0 && (
                              <p className="text-xs text-muted-foreground">
                                No suggestions — use “Add to context” and ask your own question.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
