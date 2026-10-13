/**
 * RoutineEditor — schedule a playbook to run on a cadence ("routine").
 *
 * Presets (Hourly / Daily / Weekly) map to a cron string; "Custom cron" exposes
 * the raw 5-field expression for power users. Saving upserts the single routine
 * for this playbook; the in-process scheduler then runs it headless on cadence.
 *
 * Trust: a routine is orchestration config only — it decides WHEN the playbook
 * runs, never WHAT is true. Scheduled runs use the unchanged grounded path and
 * checkpoints still enqueue non-blocking HITL. Nothing here writes to the graph.
 */
import { useMemo, useState } from "react";
import { Loader2, Clock, Trash2, Play } from "lucide-react";
import type { Playbook, PlaybookRoutine, RoutineCadence } from "@rnd/shared";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { routineApi } from "../api.js";

/** Preset cadence → cron (mirrors the BFF cadenceToCron). */
const PRESET_CRON: Record<Exclude<RoutineCadence, "cron">, string> = {
  hourly: "0 * * * *",
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
};

const CADENCE_LABEL: Record<RoutineCadence, string> = {
  hourly: "Hourly (top of every hour)",
  daily: "Daily (09:00)",
  weekly: "Weekly (Mon 09:00)",
  cron: "Custom cron…",
};

/** Human-readable "next run" from an epoch-ms value. */
function fmtNext(ms?: number | null): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

export function RoutineEditor({
  playbook,
  routine,
  reviewerName,
  onSaved,
  onClose,
}: {
  playbook: Playbook;
  routine: PlaybookRoutine | null;
  reviewerName?: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [cadence, setCadence] = useState<RoutineCadence>(routine?.cadence ?? "daily");
  const [cron, setCron] = useState(routine?.cron ?? PRESET_CRON.daily);
  const [busy, setBusy] = useState<null | "save" | "remove" | "run">(null);
  const [error, setError] = useState<string | null>(null);

  // The cron we'll actually send: fixed for presets, the typed value for custom.
  const effectiveCron = useMemo(
    () => (cadence === "cron" ? cron.trim() : PRESET_CRON[cadence]),
    [cadence, cron],
  );

  function changeCadence(next: RoutineCadence) {
    setCadence(next);
    if (next !== "cron") setCron(PRESET_CRON[next]);
  }

  async function doSave() {
    setBusy("save");
    setError(null);
    try {
      await routineApi.save(playbook.id, { cadence, cron: effectiveCron, enabled }, reviewerName);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function doRemove() {
    setBusy("remove");
    setError(null);
    try {
      await routineApi.remove(playbook.id);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setBusy(null);
    }
  }

  async function doRunNow() {
    setBusy("run");
    setError(null);
    try {
      await routineApi.runNow(playbook.id);
      onSaved(); // refresh so the last-run status updates
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Clock className="size-4 text-primary" /> Schedule “{playbook.title}”
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Runs this playbook automatically on a cadence while the server is up. Each run uses the same
        grounded agent; checkpoint steps enqueue a review (non-blocking). Nothing writes to the graph.
      </p>

      {/* Enable toggle */}
      <label className="mb-3 flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4 accent-[var(--primary)]"
        />
        Enabled
        <span className="text-xs text-muted-foreground">
          (off = keep the schedule but don’t auto-run)
        </span>
      </label>

      {/* Cadence */}
      <div className="mb-3 grid gap-2">
        <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Cadence</label>
        <select
          value={cadence}
          onChange={(e) => changeCadence(e.target.value as RoutineCadence)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          {(Object.keys(CADENCE_LABEL) as RoutineCadence[]).map((c) => (
            <option key={c} value={c}>
              {CADENCE_LABEL[c]}
            </option>
          ))}
        </select>

        {cadence === "cron" ? (
          <>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Cron (min hour dom month dow)
            </label>
            <Input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1-5"
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              5 fields, local time. e.g. <code>0 9 * * 1-5</code> = weekdays 09:00,{" "}
              <code>*/30 * * * *</code> = every 30 min.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Cron: <code className="font-mono">{effectiveCron}</code>
          </p>
        )}
      </div>

      {/* Current status */}
      {routine && (
        <div className="mb-3 rounded-md border bg-muted/30 p-2.5 text-[12px] text-muted-foreground">
          <div>
            Next run:{" "}
            <span className="text-foreground">{enabled ? fmtNext(routine.nextRunAt) : "paused"}</span>
          </div>
          {routine.lastRunAt && (
            <div>
              Last run: <span className="text-foreground">{fmtNext(routine.lastRunAt)}</span> ·{" "}
              <span className={routine.lastStatus === "error" ? "text-destructive" : "text-foreground"}>
                {routine.lastStatus ?? "—"}
              </span>
            </div>
          )}
        </div>
      )}

      {error && <div className="mb-2 text-xs text-destructive">{error}</div>}

      {/* Actions */}
      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <div className="flex items-center gap-2">
          {routine && (
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={doRemove}>
              {busy === "remove" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-3.5" />}
              Remove
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={doRunNow} title="Run once now">
            {busy === "run" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-3.5" />}
            Run now
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="control"
            size="brand"
            disabled={busy !== null || (cadence === "cron" && !effectiveCron)}
            onClick={doSave}
          >
            {busy === "save" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Saving…
              </>
            ) : (
              "Save schedule"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
