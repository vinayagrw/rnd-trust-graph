/**
 * @rnd/dashboards — Saved dashboards panel (Phase 3 entry point for F9 + F10).
 *
 * A right-hand sheet (mirrors the playbooks / eval / FinOps shells) that surfaces
 * the otherwise-headless Phase-3 surfaces so a presenter can actually reach them:
 *   - F10 — the SAVED boards a user published from chat: re-open one (rendered by
 *     the SAME trusted `DashboardCanvas` over the live graph), delete, or route it
 *     into the HITL review queue ("Send → Review" — record-decision-only, no write).
 *   - F9 — the snapshot SCHEDULES + their latest delta brief, with a "Run now"
 *     that recomposes headless through the unchanged grounded composer.
 *
 * Nothing here is a new answer source. A saved spec is the same structurally-inert
 * `DashboardSpec`; re-opening it just replays the trusted renderer over live nodes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutDashboard, Loader2, Trash2, Send, Play, Clock } from "lucide-react";
import type { DashboardSchedule, DashboardSnapshot, GraphPayload, SavedDashboard } from "@rnd/shared";
import { Button } from "../components/ui/button.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { dashboardsApi, type SavedDashboardSummary } from "../api.js";
import { DashboardCanvas } from "./DashboardCanvas.js";

function fmtWhen(ms?: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function SavedDashboardsPanel({
  graph,
  onFocusNode,
  onClose,
}: {
  graph: GraphPayload;
  onFocusNode?: (n: import("@rnd/shared").GraphNode) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  const [saved, setSaved] = useState<SavedDashboardSummary[]>([]);
  const [schedules, setSchedules] = useState<DashboardSchedule[]>([]);
  const [snapshots, setSnapshots] = useState<DashboardSnapshot[]>([]);
  const [open, setOpen] = useState<SavedDashboard | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      Promise.all([
        dashboardsApi.list().then(setSaved),
        dashboardsApi.schedules().then(setSchedules),
        dashboardsApi.snapshots().then(setSnapshots),
      ]).catch(() => {}),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (open ? setOpen(null) : onClose());
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  /** Latest snapshot brief for a schedule (the diff base the ticker shows). */
  const latestBrief = (scheduleId: string) =>
    snapshots.find((s) => s.scheduleId === scheduleId);

  const doOpen = async (id: string) => {
    setBusy(id);
    try {
      setOpen(await dashboardsApi.get(id));
    } catch {
      setNote("Could not load that dashboard.");
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async (id: string) => {
    setBusy(id);
    try {
      await dashboardsApi.remove(id);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const doReview = async (row: SavedDashboardSummary) => {
    setBusy(row.id);
    try {
      const full = await dashboardsApi.get(row.id);
      await dashboardsApi.sendToReview({
        id: row.id,
        title: row.title,
        citedNodeIds: full.spec.citedNodeIds,
      });
      setNote(`"${row.title}" sent to the HITL review queue.`);
    } catch {
      setNote("Send to review failed.");
    } finally {
      setBusy(null);
    }
  };

  const doRunNow = async (key: string) => {
    setBusy(key);
    setNote(null);
    try {
      const snap = await dashboardsApi.runNow(key);
      setNote(snap ? `Snapshot: ${snap.brief}` : "Run skipped (already snapshotting).");
      await refresh();
    } catch {
      setNote("Run now failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admin-root fixed inset-0 z-[1000] flex justify-end bg-black/40">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Saved dashboards"
        className="flex h-full w-full max-w-2xl flex-col bg-background shadow-xl"
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <LayoutDashboard className="h-5 w-5 text-primary" />
            {open ? open.title : "Saved dashboards"}
          </div>
          <div className="flex items-center gap-2">
            {open && (
              <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
                ← Back to list
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close saved dashboards">
              ✕
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {note && (
            <div className="mb-4 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm text-foreground">
              {note}
            </div>
          )}

          {/* Re-opened board — rendered by the SAME trusted canvas over the live graph. */}
          {open ? (
            <div data-testid="saved-dashboard-open">
              <DashboardCanvas
                spec={open.spec}
                graph={graph}
                audit={open.audit ?? null}
                onFocusNode={onFocusNode}
              />
            </div>
          ) : (
            <>
              {/* F10 — saved boards. */}
              <div className="mb-6">
                <div className="mb-2 text-sm font-semibold text-foreground">Published boards</div>
                {saved.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No saved dashboards yet. Generate a dashboard from the Conversation
                    beat, then press <span className="font-medium">Save</span> on it.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {saved.map((d) => (
                      <div
                        key={d.id}
                        data-testid="saved-dashboard-row"
                        className="flex items-center justify-between gap-3 rounded-lg border p-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-foreground">{d.title}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {d.widgetCount} widget(s) · saved {fmtWhen(d.savedAt)}
                            {d.savedBy ? ` · by ${d.savedBy}` : ""}
                          </div>
                        </div>
                        <div className="flex flex-shrink-0 items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy === d.id}
                            onClick={() => void doOpen(d.id)}
                          >
                            {busy === d.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Open"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Send to the HITL review queue"
                            disabled={busy === d.id}
                            onClick={() => void doReview(d)}
                          >
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            title="Delete this saved dashboard"
                            disabled={busy === d.id}
                            onClick={() => void doDelete(d.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* F9 — snapshot schedules + latest delta brief. */}
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  Snapshot schedules
                </div>
                {schedules.length === 0 ? (
                  <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                    No snapshot schedules. A schedule recomposes a saved board on a
                    cadence and briefs you on what changed.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {schedules.map((s) => {
                      const brief = latestBrief(s.id);
                      return (
                        <div
                          key={s.id}
                          data-testid="dashboard-schedule-row"
                          className="rounded-lg border p-3"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="truncate text-sm font-semibold text-foreground">{s.title}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {s.cadence}
                                {s.enabled ? "" : " · paused"}
                                {s.nextRunAt ? ` · next ${fmtWhen(s.nextRunAt)}` : ""}
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy === s.key}
                              onClick={() => void doRunNow(s.key)}
                            >
                              {busy === s.key ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <>
                                  <Play className="mr-1 h-3.5 w-3.5" /> Run now
                                </>
                              )}
                            </Button>
                          </div>
                          {brief && (
                            <div className="mt-1.5 text-[11px] text-muted-foreground">
                              latest: {brief.brief} · {fmtWhen(brief.startedAt)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
