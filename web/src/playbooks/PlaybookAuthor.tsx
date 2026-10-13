/**
 * PlaybookAuthor — AI-assisted authoring of a custom safety-dossier playbook.
 *
 * Draft-mode HITL pattern (research-backed): the AI PROPOSES, the human EDITS,
 * then explicitly SAVES. You type a goal → the model drafts a full playbook →
 * you edit every field inline (reorder, add/remove, change kind, regenerate a
 * step, or refine the whole draft by chat) → Save promotes it to a runnable
 * custom playbook.
 *
 * Grounding/trust: this only authors CONFIG (questions/prompts). The draft is
 * schema-seeded so questions are answerable, and amber warnings flag steps that
 * may reference off-graph entities — but nothing here is a new answer source and
 * nothing writes to the graph. At run time each `ask` step is still answered by
 * the unchanged grounded agent, which refuses off-graph on its own.
 */
import { useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Sparkles, Trash2, ArrowUp, ArrowDown, AlertTriangle } from "lucide-react";
import type { Playbook, PlaybookDraft, PlaybookStep, PlaybookStepKind } from "@rnd/shared";
import { Button } from "../components/ui/button.js";
import { Textarea } from "../components/ui/textarea.js";
import { Input } from "../components/ui/input.js";
import { playbookApi } from "../api.js";

/**
 * Sample goals a user can click to seed the draft. These are worded the way the
 * draft engine likes best — a signal + entity + the reviewer/assembly intent —
 * so the model produces a full ask → checkpoint → synth dossier. They reference
 * PV/safety vocabulary the graph actually carries (drugs, adverse events,
 * mechanisms, regulatory labeling), which keeps the drafted questions answerable.
 */
const EXAMPLE_GOALS: { label: string; goal: string }[] = [
  {
    label: "Hepatotoxicity signal",
    goal: "Build a safety dossier for the hepatotoxicity signal of the JAK inhibitor: identify the implicated drug, quantify the signal, gather supporting evidence and mechanism, check the regulatory label, and route it to a reviewer for sign-off.",
  },
  {
    label: "Checkpoint-inhibitor colitis",
    goal: "Assemble a signal dossier for immune-mediated colitis associated with checkpoint inhibitors — which drugs are implicated, how strong is the disproportionality signal, what evidence and mechanism support it, and does the current labeling reflect it — then send it for reviewer sign-off.",
  },
  {
    label: "Drug–drug interaction risk",
    goal: "Create a dossier assessing the drug–drug interaction risk between the two co-prescribed agents: surface the interacting drugs, the adverse events they share, the mechanism of interaction, and the labeling guidance, ending with a reviewer checkpoint.",
  },
  {
    label: "Pediatric adverse-event review",
    goal: "Draft a review of the most reported adverse events for the drug in the pediatric population, quantify each signal, gather the supporting evidence, compare against the label, and add a reviewer sign-off before assembling the dossier.",
  },
  {
    label: "Class-effect comparison",
    goal: "Build a dossier comparing the cardiovascular adverse-event profile of the drug against its therapeutic class: identify the class members, quantify the shared signals, gather mechanism and evidence, check labeling, and route to a reviewer.",
  },
];

/** Kebab-case slug for a suggested id, following the server's id rule. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

export function PlaybookAuthor({
  initial,
  reviewerName,
  onSaved,
  onCancel,
}: {
  /** Present in EDIT mode (an existing custom playbook); absent in CREATE mode. */
  initial?: Playbook | null;
  reviewerName?: string;
  onSaved: (pb: Playbook) => void;
  onCancel: () => void;
}) {
  const editing = Boolean(initial);
  const [phase, setPhase] = useState<"goal" | "form">(editing ? "form" : "goal");
  const [goal, setGoal] = useState("");
  const [id, setId] = useState(initial?.id ?? "");
  const [idTouched, setIdTouched] = useState(editing);
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [steps, setSteps] = useState<PlaybookStep[]>(initial?.steps ?? []);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [grounded, setGrounded] = useState<boolean | null>(null);
  const [refineText, setRefineText] = useState("");
  const [busy, setBusy] = useState<null | "draft" | "refine" | "save">(null);
  const [error, setError] = useState<string | null>(null);

  const effectiveId = idTouched ? id : slug(title);
  const currentDraft: PlaybookDraft = useMemo(
    () => ({ title, description, steps, warnings }),
    [title, description, steps, warnings],
  );

  function applyDraft(d: PlaybookDraft, isGrounded: boolean) {
    setTitle(d.title);
    setDescription(d.description);
    setSteps(d.steps);
    setWarnings(d.warnings ?? []);
    setGrounded(isGrounded);
  }

  async function doDraft() {
    if (!goal.trim()) return;
    setBusy("draft");
    setError(null);
    try {
      const { draft, grounded } = await playbookApi.draft(goal.trim());
      applyDraft(draft, grounded);
      setPhase("form");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Draft failed");
    } finally {
      setBusy(null);
    }
  }

  async function doRefine(instruction: string) {
    if (!instruction.trim()) return;
    setBusy("refine");
    setError(null);
    try {
      const { draft, grounded } = await playbookApi.refine(currentDraft, instruction.trim());
      applyDraft(draft, grounded);
      setRefineText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refine failed");
    } finally {
      setBusy(null);
    }
  }

  function patchStep(i: number, patch: Partial<PlaybookStep>) {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, j) => j !== i));
  }
  function addStep() {
    setSteps((prev) => [
      ...prev,
      { id: `step-${prev.length + 1}`, kind: "ask", title: "New step", question: "" },
    ]);
  }

  async function doSave() {
    setBusy("save");
    setError(null);
    // Trim empties so the server's per-kind requirement passes cleanly.
    const cleanSteps = steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title.trim(),
      ...(s.kind === "ask" ? { question: (s.question ?? "").trim() } : {}),
      ...(s.kind === "checkpoint" ? { prompt: (s.prompt ?? "").trim() } : {}),
    }));
    try {
      const pb = editing
        ? await playbookApi.update(initial!.id, { title, description, steps: cleanSteps }, reviewerName)
        : await playbookApi.create(
            { id: effectiveId, title, description, steps: cleanSteps },
            reviewerName,
          );
      onSaved(pb);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  // --- GOAL phase (create mode) --------------------------------------------
  if (phase === "goal") {
    return (
      <div className="rounded-lg border p-4">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles className="size-4 text-primary" /> Create a playbook with AI
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Describe the safety question you want a dossier for. The AI drafts the steps from your
          live graph schema — you then edit and save. Nothing runs or is saved until you say so.
        </p>
        <Textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Build a dossier for the hepatotoxicity signal of the JAK inhibitor and route it to a reviewer."
          rows={3}
          className="mb-2"
        />
        <div className="mb-3">
          <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Or start from an example
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLE_GOALS.map((ex) => (
              <button
                key={ex.label}
                type="button"
                disabled={busy === "draft"}
                onClick={() => setGoal(ex.goal)}
                className="rounded-full border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-foreground disabled:opacity-50"
                title={ex.goal}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
        <div className="flex items-center gap-2">
          <Button variant="control" size="brand" disabled={busy === "draft" || !goal.trim()} onClick={doDraft}>
            {busy === "draft" ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Drafting…
              </>
            ) : (
              <>
                <Sparkles className="size-4" /> Draft with AI
              </>
            )}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  // --- FORM phase (edit the draft) -----------------------------------------
  return (
    <div className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Sparkles className="size-4 text-primary" /> {editing ? "Edit playbook" : "Review & edit draft"}
        </div>
        {grounded === false && (
          <span className="rounded-full border px-2 py-[1px] text-[10.5px] text-muted-foreground">
            offline skeleton — edit to fit your graph
          </span>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5 text-[12px] text-foreground">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5 text-amber-600" /> Check these before saving
          </div>
          <ul className="list-disc space-y-0.5 pl-5">
            {warnings.map((w, i) => (
              <li key={i} className="text-muted-foreground">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Identity */}
      <div className="mb-3 grid gap-2">
        <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Title</label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Playbook title" />
        {!editing && (
          <>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Id (kebab-case)</label>
            <Input
              value={effectiveId}
              onChange={(e) => {
                setIdTouched(true);
                setId(e.target.value);
              }}
              placeholder="auto-derived-from-title"
            />
          </>
        )}
        <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Description</label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </div>

      {/* Steps */}
      <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Steps</div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="rounded-md border p-2.5">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="inline-flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                {i + 1}
              </span>
              <select
                value={s.kind}
                onChange={(e) => patchStep(i, { kind: e.target.value as PlaybookStepKind })}
                className="h-7 rounded-md border bg-background px-2 text-xs"
                aria-label={`Step ${i + 1} kind`}
              >
                <option value="ask">ask</option>
                <option value="checkpoint">checkpoint</option>
                <option value="synth">synth</option>
              </select>
              <Input
                value={s.title}
                onChange={(e) => patchStep(i, { title: e.target.value })}
                placeholder="Step title"
                className="h-7 flex-1 text-xs"
              />
              <div className="flex items-center gap-0.5">
                <Button variant="ghost" size="icon-xs" onClick={() => moveStep(i, -1)} disabled={i === 0} aria-label="Move up">
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => moveStep(i, 1)}
                  disabled={i === steps.length - 1}
                  aria-label="Move down"
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => doRefine(`Rewrite the step titled "${s.title}" to be more specific and answerable from the graph.`)}
                  disabled={busy !== null || s.kind === "synth"}
                  aria-label="Regenerate step"
                  title="Regenerate this step"
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon-xs" onClick={() => removeStep(i)} aria-label="Remove step">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
            {s.kind === "ask" && (
              <Textarea
                value={s.question ?? ""}
                onChange={(e) => patchStep(i, { question: e.target.value })}
                placeholder="Question handed to the grounded agent…"
                rows={2}
                className="text-xs"
              />
            )}
            {s.kind === "checkpoint" && (
              <Textarea
                value={s.prompt ?? ""}
                onChange={(e) => patchStep(i, { prompt: e.target.value })}
                placeholder="What the reviewer is asked to confirm…"
                rows={2}
                className="text-xs"
              />
            )}
            {s.kind === "synth" && (
              <p className="text-[11px] text-muted-foreground">Assembly marker — no question needed.</p>
            )}
          </li>
        ))}
      </ol>
      <Button variant="ghost" size="sm" className="mt-2" onClick={addStep}>
        <Plus className="size-3.5" /> Add step
      </Button>

      {/* Refine by chat */}
      <div className="mt-4 rounded-md border bg-muted/30 p-2.5">
        <div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Refine by chat</div>
        <div className="flex items-center gap-2">
          <Input
            value={refineText}
            onChange={(e) => setRefineText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doRefine(refineText);
            }}
            placeholder="e.g. add a step comparing against the class effect"
            className="h-8 flex-1 text-xs"
          />
          <Button variant="ghost" size="sm" disabled={busy !== null || !refineText.trim()} onClick={() => doRefine(refineText)}>
            {busy === "refine" ? <Loader2 className="size-4 animate-spin" /> : "Refine"}
          </Button>
        </div>
      </div>

      {error && <div className="mt-3 text-xs text-destructive">{error}</div>}

      {/* Actions */}
      <div className="mt-4 flex items-center justify-end gap-2 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="control"
          size="brand"
          disabled={busy !== null || !title.trim() || (!editing && !effectiveId) || steps.length === 0}
          onClick={doSave}
        >
          {busy === "save" ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Saving…
            </>
          ) : editing ? (
            "Save changes"
          ) : (
            "Save playbook"
          )}
        </Button>
      </div>
    </div>
  );
}
