/**
 * Eval scorecard (F2) — RAGAS-style answer-quality observability.
 *
 * OBSERVABILITY ONLY (same non-negotiable rule as the FinOps ledger): recording
 * an eval entry NEVER changes what the LLM is allowed to answer. It does not touch
 * grounding, refusal, or read-only enforcement — it only MEASURES the quality of a
 * grounded answer AFTER the fact (faithfulness + context-recall + optional
 * answer-relevancy).
 *
 * Storage mirrors finops/ledger.ts byte-for-byte in shape: an in-memory RING
 * (newest-last, capped) persisted to a simple JSON file. Created on first write;
 * a corrupt/missing file empties history rather than crashing the demo.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvalEntry, EvalSummary, FinOpsSurface } from "@rnd/shared";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted eval ledger path (gitignore-safe, created on first write).
 *  Overridable via EVAL_LEDGER_PATH so tests / concurrent workers use a scratch
 *  file (mirrors FINOPS_LEDGER_PATH / ADMIN_CONFIG_PATH). */
export const EVAL_LEDGER_PATH =
  process.env.EVAL_LEDGER_PATH ?? join(here, "../../eval-ledger.json");

/** Ring capacity — newest entries kept in memory + persisted. */
const RING_CAP = Number(process.env.EVAL_RING_CAP ?? 2000);

/** In-memory ring (newest-last). Loaded lazily from disk on first access. */
let ring: EvalEntry[] | null = null;

function load(): EvalEntry[] {
  if (ring) return ring;
  let entries: EvalEntry[] = [];
  if (existsSync(EVAL_LEDGER_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(EVAL_LEDGER_PATH, "utf-8")) as { entries?: EvalEntry[] };
      if (Array.isArray(raw.entries)) entries = raw.entries.slice(-RING_CAP);
    } catch {
      entries = []; // a corrupt file must never crash the demo
    }
  }
  ring = entries;
  return ring;
}

function persist(): void {
  try {
    writeFileSync(EVAL_LEDGER_PATH, JSON.stringify({ entries: ring ?? [] }, null, 2), "utf-8");
  } catch {
    /* best-effort: a write failure must never break the answer path */
  }
}

/** Clamp a 0..1 score (or null pass-through for answerRelevancy). */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

export interface RecordEvalInput {
  surface: FinOpsSurface;
  question: string;
  faithfulness: number;
  contextRecall: number;
  answerRelevancy?: number | null;
  citedCount: number;
}

/**
 * Append one answer-quality record to the ring + persist. Never throws — an
 * instrumentation failure must not affect the answer path. The question is
 * truncated so the ledger never stores a full transcript.
 */
export function recordEval(input: RecordEvalInput): EvalEntry {
  const entries = load();
  const entry: EvalEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    surface: input.surface,
    question: (input.question ?? "").slice(0, 160),
    faithfulness: clamp01(input.faithfulness),
    contextRecall: clamp01(input.contextRecall),
    answerRelevancy:
      typeof input.answerRelevancy === "number" ? clamp01(input.answerRelevancy) : null,
    citedCount: Math.max(0, Math.round(input.citedCount || 0)),
  };
  entries.push(entry);
  if (entries.length > RING_CAP) entries.splice(0, entries.length - RING_CAP);
  persist();
  return entry;
}

/** Mean of a numeric list, rounded to 2dp; 0 for an empty list. */
function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

/** Build the rolling summary the scorecard renders. avgAnswerRelevancy is null
 *  when no entry carried a judged relevancy (the judge is off by default). */
export function summarizeEval(limit = 50): EvalSummary {
  const entries = load();
  const judged = entries.map((e) => e.answerRelevancy).filter((x): x is number => x !== null);
  return {
    entryCount: entries.length,
    avgFaithfulness: mean(entries.map((e) => e.faithfulness)),
    avgContextRecall: mean(entries.map((e) => e.contextRecall)),
    avgAnswerRelevancy: judged.length ? mean(judged) : null,
    recent: entries.slice(-Math.max(1, Math.min(limit, RING_CAP))).reverse(),
  };
}

/** Test hook: drop the in-memory ring so the next access re-reads disk. */
export function invalidateEvalCache(): void {
  ring = null;
}
