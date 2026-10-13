/**
 * FinOps ledger — token/cost observability for every LLM call site.
 *
 * OBSERVABILITY ONLY (non-negotiable): recording a ledger entry NEVER changes
 * what the LLM is allowed to answer. It does not touch grounding, the refusal
 * paths, or the read-only enforcement — it only *measures* usage after the fact.
 *
 * Storage model mirrors threadStore.ts / adminConfig.ts (byte-simple JSON, no DB):
 *   bff/finops-ledger.json  ->  { entries: FinOpsEntry[] }
 * Created on first write; deleting it just empties history (never crashes). The
 * working set is an in-memory RING (newest-last, capped) so the summary is O(ring)
 * and the file never grows unbounded.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  FinOpsEntry,
  FinOpsSummary,
  FinOpsBreakdownRow,
  FinOpsModelPrice,
} from "@rnd/shared";
import { getConfig } from "../config/adminConfig.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted ledger path (gitignore-safe, created on first write). Overridable
 *  via FINOPS_LEDGER_PATH so tests / concurrent workers use a scratch file. */
export const FINOPS_LEDGER_PATH =
  process.env.FINOPS_LEDGER_PATH ?? join(here, "../../finops-ledger.json");

/** Ring capacity — newest entries kept in memory and persisted. Plenty for a
 *  demo session; bounds memory + the on-disk file. */
const RING_CAP = Number(process.env.FINOPS_RING_CAP ?? 2000);

/** ~4 chars per token — the standard rough estimate used when a call path can't
 *  report real usage (the cloud streaming path). Records are marked estimated. */
const CHARS_PER_TOKEN = 4;

/** In-memory ring (newest-last). Loaded lazily from disk on first access. */
let ring: FinOpsEntry[] | null = null;

function load(): FinOpsEntry[] {
  if (ring) return ring;
  let entries: FinOpsEntry[] = [];
  if (existsSync(FINOPS_LEDGER_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(FINOPS_LEDGER_PATH, "utf-8")) as {
        entries?: FinOpsEntry[];
      };
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
    writeFileSync(
      FINOPS_LEDGER_PATH,
      JSON.stringify({ entries: ring ?? [] }, null, 2),
      "utf-8"
    );
  } catch {
    /* best-effort: a write failure must never break the demo path */
  }
}

/** Look up the price row for a model from the (hot-editable) admin config,
 *  falling back to the configured defaultPrice for unlisted models. */
export function priceFor(model: string): FinOpsModelPrice {
  const fin = getConfig().finops;
  return fin.prices[model] ?? fin.defaultPrice;
}

/** Pure cost calc (unit-tested): USD = tokens/1e6 * perMTok, summed I/O. */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  price: FinOpsModelPrice
): number {
  const usd =
    (inputTokens / 1_000_000) * price.inputPerMTok +
    (outputTokens / 1_000_000) * price.outputPerMTok;
  // Round to 6dp so tiny demo costs don't accumulate float noise.
  return Math.round(usd * 1e6) / 1e6;
}

/** Estimate tokens from text length (~4 chars/token). Used only when the call
 *  path cannot report real usage; the entry is then marked `estimated: true`. */
export function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil((text?.length ?? 0) / CHARS_PER_TOKEN));
}

export interface RecordInput {
  surface: FinOpsEntry["surface"];
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimated?: boolean;
  /** Pre-computed cost; if omitted it is derived from the price table. */
  costUsd?: number;
}

/**
 * Append one LLM-usage record to the ring + persist. Cost is computed from the
 * hot-editable price table unless an explicit costUsd is supplied. Never throws —
 * an instrumentation failure must not affect the LLM response path.
 */
export function record(input: RecordInput): FinOpsEntry {
  const entries = load();
  const price = priceFor(input.model);
  const entry: FinOpsEntry = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    surface: input.surface,
    model: input.model,
    inputTokens: Math.max(0, Math.round(input.inputTokens || 0)),
    outputTokens: Math.max(0, Math.round(input.outputTokens || 0)),
    costUsd:
      input.costUsd ??
      computeCost(input.inputTokens || 0, input.outputTokens || 0, price),
    estimated: Boolean(input.estimated),
  };
  entries.push(entry);
  if (entries.length > RING_CAP) entries.splice(0, entries.length - RING_CAP);
  persist();
  return entry;
}

/** Recent entries (newest-first), capped by `limit`, for the historical chart. */
export function recentEntries(limit = 100): FinOpsEntry[] {
  const entries = load();
  const n = Math.max(1, Math.min(limit, RING_CAP));
  return entries.slice(-n).reverse();
}

/** Group entries into {tokens,cost} rows by a key extractor, sorted by cost. */
function breakdown(
  entries: FinOpsEntry[],
  keyOf: (e: FinOpsEntry) => string
): FinOpsBreakdownRow[] {
  const map = new Map<string, FinOpsBreakdownRow>();
  for (const e of entries) {
    const key = keyOf(e);
    const row =
      map.get(key) ??
      ({ key, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, count: 0 } as FinOpsBreakdownRow);
    row.inputTokens += e.inputTokens;
    row.outputTokens += e.outputTokens;
    row.totalTokens += e.inputTokens + e.outputTokens;
    row.costUsd += e.costUsd;
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, costUsd: Math.round(r.costUsd * 1e6) / 1e6 }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** Build the live session summary the meter + dashboard consume. Budget +
 *  threshold come from the hot-editable admin config. */
export function summarize(): FinOpsSummary {
  const entries = load();
  const fin = getConfig().finops;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  for (const e of entries) {
    totalInputTokens += e.inputTokens;
    totalOutputTokens += e.outputTokens;
    totalCostUsd += e.costUsd;
  }
  totalCostUsd = Math.round(totalCostUsd * 1e6) / 1e6;
  const budgetUsd = fin.budgetUsd;
  const pctUsed = budgetUsd > 0 ? (totalCostUsd / budgetUsd) * 100 : 0;
  return {
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalCostUsd,
    entryCount: entries.length,
    bySurface: breakdown(entries, (e) => e.surface),
    byModel: breakdown(entries, (e) => e.model),
    budget: {
      budgetUsd,
      warnThresholdPct: fin.warnThresholdPct,
      pctUsed: Math.round(pctUsed * 100) / 100,
      overThreshold: pctUsed >= fin.warnThresholdPct,
      overBudget: budgetUsd > 0 && totalCostUsd >= budgetUsd,
    },
  };
}

/** Test hook: drop the in-memory ring so the next access re-reads disk. */
export function invalidateLedgerCache(): void {
  ring = null;
}
