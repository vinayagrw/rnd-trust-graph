/**
 * F5 — playbook runner. Executes a playbook's steps in order and streams progress.
 *
 * Each `ask` step drives the UNCHANGED grounded agent (`askGraph`) through a
 * COLLECTING sink, harvesting the answer text, the grounded citations, and the
 * faithfulness verdict (F1) — faithfulness/citations are sink-only, so a non-SSE
 * caller simply provides its own sink. `checkpoint` steps enqueue a HITL review
 * (the authorized writer's queue) and DO NOT block waiting for a human — the SSE
 * stream stays short; the reviewer approves the item asynchronously in the normal
 * HITL panel. `synth` assembles the dossier. No new answer source, no new write
 * path; each ask step refuses off-graph on its own.
 */
import type {
  DossierResult,
  DossierStepResult,
  FaithfulnessResult,
  Playbook,
} from "@rnd/shared";
import { askGraph } from "../ask/agent.js";
import { enqueueFromConclusion } from "../hitl/enqueue.js";
import { getPlaybook } from "./definitions.js";

type Sink = (event: { type: string; [k: string]: unknown }) => void;

/** Run ONE `ask` step: collect the grounded answer + citations + faithfulness. */
async function runAskStep(question: string): Promise<{
  answer: string;
  citedNodeIds: string[];
  faithfulness: FaithfulnessResult | null;
  isFallback: boolean;
}> {
  let answer = "";
  let citedNodeIds: string[] = [];
  let faithfulness: FaithfulnessResult | null = null;
  let isFallback = false;
  const collect: Sink = (e) => {
    if (e.type === "token" && typeof e.text === "string") answer += e.text;
    else if (e.type === "citations") {
      const ids = (e as { nodeIds?: unknown }).nodeIds;
      if (Array.isArray(ids)) citedNodeIds = ids.map(String);
    } else if (e.type === "faithfulness") {
      faithfulness = ((e as { result?: unknown }).result as FaithfulnessResult) ?? null;
    } else if (e.type === "done") {
      isFallback = Boolean((e as { isFallback?: unknown }).isFallback);
    }
  };
  await askGraph(question, collect, "ask");
  return { answer: answer.trim(), citedNodeIds, faithfulness, isFallback };
}

/**
 * Run a playbook, streaming `step-started` / `step-result` events and a final
 * `done` carrying the assembled dossier. Guarded — a failing step degrades to a
 * fallback result rather than aborting the whole run.
 */
export async function runPlaybook(playbookId: string, sink: Sink): Promise<void> {
  const playbook: Playbook | undefined = getPlaybook(playbookId);
  if (!playbook) {
    sink({ type: "error", message: `unknown playbook: ${playbookId}` });
    return;
  }

  const results: DossierStepResult[] = [];
  // The most recent grounded ask result — checkpoints route IT to review.
  let lastAsk: { answer: string; citedNodeIds: string[]; confidence?: number } | null = null;

  for (const step of playbook.steps) {
    sink({ type: "step-started", stepId: step.id, title: step.title, kind: step.kind });
    try {
      if (step.kind === "ask" && step.question) {
        const r = await runAskStep(step.question);
        lastAsk = {
          answer: r.answer,
          citedNodeIds: r.citedNodeIds,
          confidence: r.faithfulness?.score,
        };
        const result: DossierStepResult = {
          stepId: step.id,
          title: step.title,
          kind: "ask",
          answer: r.answer,
          citedNodeIds: r.citedNodeIds,
          faithfulness: r.faithfulness,
          isFallback: r.isFallback,
        };
        results.push(result);
        sink({ type: "step-result", result });
      } else if (step.kind === "checkpoint") {
        // Non-blocking: enqueue the prior grounded conclusion for HITL review.
        const summary = lastAsk?.answer
          ? `${step.prompt ?? step.title} — ${lastAsk.answer.slice(0, 240)}`
          : step.prompt ?? step.title;
        const item = enqueueFromConclusion({
          summary,
          citedNodeIds: lastAsk?.citedNodeIds ?? [],
          confidence: lastAsk?.confidence,
        });
        const result: DossierStepResult = {
          stepId: step.id,
          title: step.title,
          kind: "checkpoint",
          pendingItemId: item.id,
          citedNodeIds: lastAsk?.citedNodeIds ?? [],
        };
        results.push(result);
        sink({ type: "step-result", result });
      } else {
        // synth — assembly marker; the dossier is emitted on `done` below.
        const result: DossierStepResult = { stepId: step.id, title: step.title, kind: "synth" };
        results.push(result);
        sink({ type: "step-result", result });
      }
    } catch (err) {
      const result: DossierStepResult = {
        stepId: step.id,
        title: step.title,
        kind: step.kind,
        isFallback: true,
        answer: `(step failed: ${String(err)})`,
      };
      results.push(result);
      sink({ type: "step-result", result });
    }
  }

  const dossier: DossierResult = {
    playbookId: playbook.id,
    title: playbook.title,
    steps: results,
  };
  sink({ type: "done", dossier });
}
