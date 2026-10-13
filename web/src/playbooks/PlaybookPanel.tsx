/**
 * F5 — Safety-dossier playbooks (web). A right-hand sheet (mirrors the eval
 * scorecard / FinOps shells) that lists the curated playbooks and runs one,
 * streaming step progress. Each `ask` step shows its grounded answer + faithfulness
 * band (F1); each `checkpoint` step shows the HITL item it enqueued for
 * asynchronous reviewer sign-off. The dossier is pure orchestration over the real
 * grounded agent — nothing here is a new answer source.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardList, Loader2, Sparkles, Pencil, Trash2, Lock, Clock } from "lucide-react";
import type {
  DossierResult,
  DossierStepResult,
  GraphPayload,
  Playbook,
  PlaybookEvent,
  PlaybookRoutine,
} from "@rnd/shared";
import { Button } from "../components/ui/button.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { playbookApi, routineApi } from "../api.js";
import { DossierStory } from "./DossierStory.js";
import { PlaybookAuthor } from "./PlaybookAuthor.js";
import { RoutineEditor } from "./RoutineEditor.js";

/** Compact human-readable cadence for the row badge. */
const CADENCE_SHORT: Record<PlaybookRoutine["cadence"], string> = {
  hourly: "hourly",
  daily: "daily",
  weekly: "weekly",
  cron: "custom",
};

function fmtNextShort(ms?: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

const BAND_COLOR: Record<string, string> = {
  high: "#0a7d4b",
  medium: "#9a6a00",
  low: "#b4231f",
};

export function PlaybookPanel({
  graph,
  onOpenHitl,
  onOpenStory,
  onClose,
}: {
  graph: GraphPayload;
  onOpenHitl?: () => void;
  onOpenStory?: (d: DossierResult) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [steps, setSteps] = useState<DossierStepResult[]>([]);
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // The assembled dossier from the `done` event — drives the inline story + the
  // "Open full story" hand-off. Falls back to the streamed steps if the `done`
  // event carries no dossier payload.
  const [dossier, setDossier] = useState<DossierResult | null>(null);
  // AI-assisted authoring: null = closed; "create" = new; a Playbook = edit that one.
  const [authoring, setAuthoring] = useState<null | "create" | Playbook>(null);
  // Scheduling: the playbook whose routine is being edited (null = closed).
  const [scheduling, setScheduling] = useState<Playbook | null>(null);
  const [routines, setRoutines] = useState<PlaybookRoutine[]>([]);
  const cancelRef = useRef<null | (() => void)>(null);

  const refreshList = useCallback(
    () =>
      Promise.all([
        playbookApi.list().then(setPlaybooks),
        routineApi.list().then(setRoutines),
      ]).catch(() => {}),
    [],
  );

  const routineFor = useCallback(
    (playbookId: string) => routines.find((r) => r.playbookId === playbookId) ?? null,
    [routines],
  );

  useEffect(() => {
    void refreshList();
    return () => {
      cancelRef.current?.();
    };
  }, [refreshList]);

  function run(id: string) {
    cancelRef.current?.();
    setRunning(id);
    setSteps([]);
    setActiveStep(null);
    setDone(false);
    setDossier(null);
    cancelRef.current = playbookApi.run(id, (e: PlaybookEvent) => {
      if (e.type === "step-started") setActiveStep(e.stepId);
      else if (e.type === "step-result") setSteps((s) => [...s, e.result]);
      else if (e.type === "done") {
        setActiveStep(null);
        setDone(true);
        setRunning(null);
        // Prefer the assembled dossier; fall back to the streamed steps.
        setSteps((s) => {
          setDossier(e.dossier ?? { playbookId: id, title: id, steps: s });
          return s;
        });
      } else if (e.type === "error") {
        setActiveStep(null);
        setRunning(null);
        setDone(true);
      }
    });
  }

  async function handleDelete(p: Playbook) {
    if (!window.confirm(`Delete playbook "${p.title}"? This cannot be undone.`)) return;
    try {
      await playbookApi.remove(p.id);
      await refreshList();
    } catch {
      /* server rejects curated ids; custom-only controls mean this is rare */
    }
  }

  return (
    <div className="admin-root fixed inset-0 z-[1000] flex justify-end bg-black/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Scientific playbooks — safety dossier"
        className="flex h-full w-full max-w-4xl flex-col bg-background shadow-2xl"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <ClipboardList className="size-5 text-primary" />
              Scientific playbooks — safety dossier
            </div>
            <p className="text-xs text-muted-foreground">
              Each step runs the real grounded agent; checkpoints enqueue a human review.
              Orchestration only — no new answer source.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="control"
              size="brand"
              disabled={!!running || authoring !== null || scheduling !== null}
              onClick={() => setAuthoring("create")}
            >
              <Sparkles className="size-4" /> New with AI
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close playbooks">
              Close
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* AI-assisted authoring — inline draft-then-edit surface. */}
          {authoring !== null && (
            <div className="mb-5">
              <PlaybookAuthor
                initial={authoring === "create" ? null : authoring}
                onSaved={async () => {
                  setAuthoring(null);
                  await refreshList();
                }}
                onCancel={() => setAuthoring(null)}
              />
            </div>
          )}

          {/* Routine / schedule editor — inline surface for the selected playbook. */}
          {scheduling !== null && (
            <div className="mb-5">
              <RoutineEditor
                key={`${scheduling.id}:${routineFor(scheduling.id)?.updatedAt ?? "new"}:${routineFor(scheduling.id)?.lastRunAt ?? 0}`}
                playbook={scheduling}
                routine={routineFor(scheduling.id)}
                onSaved={async () => {
                  await refreshList();
                  // Keep the editor open so the user sees the updated next/last-run,
                  // but re-sync its `routine` prop is handled by refreshList + remount.
                }}
                onClose={() => setScheduling(null)}
              />
            </div>
          )}

          {/* Playbook list + run buttons */}
          <div className="mb-5 space-y-3">
            {playbooks.map((p) => {
              const isCustom = p.origin === "custom";
              const routine = routineFor(p.id);
              const busyRow = !!running || authoring !== null || scheduling !== null;
              return (
              <div key={p.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {p.title}
                    {isCustom ? (
                      <span className="rounded-full border border-primary/40 px-2 py-[1px] text-[10px] font-normal text-primary">
                        custom
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[10px] font-normal text-muted-foreground">
                        <Lock className="size-2.5" /> curated
                      </span>
                    )}
                    {routine?.enabled && (
                      <span
                        className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/5 px-2 py-[1px] text-[10px] font-normal text-emerald-700"
                        title={`Cron: ${routine.cron}${routine.nextRunAt ? ` · next ${new Date(routine.nextRunAt).toLocaleString()}` : ""}`}
                      >
                        <Clock className="size-2.5" /> {CADENCE_SHORT[routine.cadence]}
                        {routine.nextRunAt ? ` · next ${fmtNextShort(routine.nextRunAt)}` : ""}
                      </span>
                    )}
                    {routine && !routine.enabled && (
                      <span className="inline-flex items-center gap-1 rounded-full border px-2 py-[1px] text-[10px] font-normal text-muted-foreground">
                        <Clock className="size-2.5" /> paused
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busyRow}
                      onClick={() => setScheduling(p)}
                      aria-label={`Schedule ${p.title}`}
                      title="Schedule / routine"
                    >
                      <Clock className="size-3.5" />
                    </Button>
                    {isCustom && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyRow}
                          onClick={() => setAuthoring(p)}
                          aria-label={`Edit ${p.title}`}
                          title="Edit"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={busyRow}
                          onClick={() => handleDelete(p)}
                          aria-label={`Delete ${p.title}`}
                          title="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </>
                    )}
                    <Button
                      variant="control"
                      size="brand"
                      disabled={!!running || scheduling !== null}
                      onClick={() => run(p.id)}
                    >
                      {running === p.id ? "Running…" : "Run"}
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                <div className="mt-1 text-[11px] text-muted-foreground">{p.steps.length} steps</div>
              </div>
              );
            })}
            {playbooks.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading playbooks…
              </div>
            )}
          </div>

          {/* Streamed step results — progress feedback DURING the run only. Once
              the run is done the narrated DossierStory below supersedes this list,
              so we hide it to avoid showing every answer twice. */}
          {!done && (steps.length > 0 || activeStep) && (
            <ol className="space-y-2">
              {steps.map((s) => (
                <li key={s.stepId} className="rounded-md border p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.kind}
                    </span>
                    <span className="text-sm font-medium text-foreground">{s.title}</span>
                    {s.faithfulness?.band && (
                      <span
                        className="rounded-full border px-2 py-[1px] text-[10.5px]"
                        style={{
                          color: BAND_COLOR[s.faithfulness.band],
                          borderColor: BAND_COLOR[s.faithfulness.band],
                        }}
                      >
                        faithfulness: {s.faithfulness.band} ({Math.round((s.faithfulness.score ?? 0) * 100)}%)
                      </span>
                    )}
                    {s.isFallback && (
                      <span className="rounded-full border px-2 py-[1px] text-[10.5px] text-muted-foreground">
                        offline / fallback
                      </span>
                    )}
                  </div>
                  {s.answer && (
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-foreground">{s.answer}</p>
                  )}
                  {s.kind === "checkpoint" && (
                    <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>⚖ enqueued for reviewer sign-off (pending)</span>
                      {onOpenHitl && (
                        <button type="button" className="underline" onClick={onOpenHitl}>
                          open review queue
                        </button>
                      )}
                    </div>
                  )}
                  {s.citedNodeIds && s.citedNodeIds.length > 0 && (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {s.citedNodeIds.length} cited node{s.citedNodeIds.length === 1 ? "" : "s"}
                    </div>
                  )}
                </li>
              ))}
              {activeStep && (
                <li className="flex items-center gap-2 rounded-md border p-3 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> running step…
                </li>
              )}
            </ol>
          )}

          {done && steps.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 p-3 text-sm text-foreground">
              <span>
                ✓ Dossier assembled — {steps.length} steps. Checkpoint items await reviewer sign-off
                in the HITL queue.
              </span>
              {onOpenStory && dossier && (
                <Button variant="control" size="brand" onClick={() => onOpenStory(dossier)}>
                  Open full story
                </Button>
              )}
            </div>
          )}

          {/* Post-run narrated visual story — grounded per-step visuals derived
              from the run's real citations + the loaded graph. Inline mirror of
              the dedicated full-width surface. */}
          {done && dossier && dossier.steps.length > 0 && (
            <div className="mt-5 border-t pt-5">
              <div className="mb-3 text-sm font-semibold text-foreground">Narrated dossier story</div>
              <DossierStory steps={dossier.steps} graph={graph} layout="panel" onOpenHitl={onOpenHitl} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
