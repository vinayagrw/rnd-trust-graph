/**
 * Board orchestrator — the planner → workers → board-critic → (one) reflexion loop.
 *
 * This is the "full orchestrator" board mode (`?compose=board`). It reuses the
 * entire per-tile trust chain (`gateRawTile` → strict schema → critic → trusted
 * `compileTile`) and adds:
 *   1. plan — ONE LLM round chooses an archetype + filter fields + slots (INTENT).
 *   2. workers — ONE LLM round PER chart slot, each emitting ≤2 alternatives; the
 *      best (by the deterministic critic) is kept and streamed. KPI slots need NO
 *      LLM — their value is host-computed (`deriveKpi`).
 *   3. board critic — deterministic `scoreBoard`.
 *   4. reflexion — at most ONE batched round re-prompting the slots that failed.
 *   5. host layout + filters — `assignLayout` + `deriveFilters` (host-owned).
 *
 * Bounded on purpose (the local CLI is ~30s/call): `MAX_SLOTS` slots, `concurrency`
 * workers at a time, ONE reflexion, and a hard overall `budgetMs` after which it
 * stops launching work and returns whatever resolved. Never throws; on total failure
 * it returns the deterministic template board (still laid out).
 */
import { randomUUID } from "node:crypto";
import type { BoardPlan, BoardSlot, FieldMenuEntry, GenerativeBoard, GenerativeDatasets, GenerativeTile, LayoutArchetype } from "@rnd/shared";
import { config } from "../config.js";
import { runClaudeCode, type ClaudeCodeRunOpts, type ClaudeCodeResult } from "../llm/claudeCode.js";
import { extractCompleteObjects } from "../llm/partialJson.js";
import { log } from "../log.js";
import { bindDatasets } from "./bind.js";
import { fieldMenuLines, type ComposeGenerativeInput, type ComposeGenerativeResult, type ComposeGenerativeDeps } from "./composer.js";
import { tileIRSchema, type CompileContext } from "./schema.js";
import { gateRawTile } from "./gate.js";
import { planBoard, defaultPlan } from "./plan.js";
import { scoreBoard, BOARD_THRESHOLD } from "./boardCritic.js";
import { assignLayout, deriveFilters, deriveKpi, isKpiFamilyRole } from "./layout.js";
import { templateBoard } from "./templates.js";

const WORKER_TIMEOUT_MS = 30_000;
const BUDGET_MS = 120_000;
const CONCURRENCY = 2;
/** Alternatives a worker is asked for (candidate-and-rank without N full boards). */
const MAX_ALTERNATIVES = 2;
/** Diversity is a TIEBREAKER, not an override. Among a slot's candidates, only those
 *  within this margin of the top critic score compete on freshness; a chart that fits
 *  meaningfully better ALWAYS wins, even if its mark repeats. This keeps "find the best
 *  visuals" literally true while still varying charts when fitness is a wash. */
const DIVERSITY_EPSILON = 0.05;

export interface ComposeBoardDeps extends ComposeGenerativeDeps {
  /** Overall wall-clock ceiling; past it, stop launching work and return partial. */
  budgetMs?: number;
  /** Max workers in flight at once. */
  concurrency?: number;
  /** "More dashboards" — the previous board's archetype; the plan is nudged AND
   *  deterministically remapped away from it so a re-compose yields a DIFFERENT board. */
  avoidArchetype?: LayoutArchetype;
}

/** The six archetypes in a stable order — used to rotate away from `avoidArchetype`. */
const ARCHETYPE_ROTATION: LayoutArchetype[] = ["kpi-grid", "hero-rail", "bento", "small-multiples", "master-detail", "analytic-grid"];

/** The next archetype after `current` (wraps) — a deterministic "give me a different one". */
function rotateArchetype(current: LayoutArchetype): LayoutArchetype {
  const i = ARCHETYPE_ROTATION.indexOf(current);
  return ARCHETYPE_ROTATION[(i + 1) % ARCHETYPE_ROTATION.length]!;
}

/** Compose a query-adaptive dashboard. Streams each tile as it resolves; the returned
 *  board carries the host-owned layout + filters + board score. Never throws. */
export async function composeBoardOrchestrated(
  input: ComposeGenerativeInput,
  onDelta: (tile: GenerativeTile) => void,
  deps: ComposeBoardDeps = {},
): Promise<ComposeGenerativeResult> {
  const bind = deps.bind ?? bindDatasets;
  const run = deps.run ?? runClaudeCode;
  const timeoutMs = deps.timeoutMs ?? WORKER_TIMEOUT_MS;
  const budgetMs = deps.budgetMs ?? BUDGET_MS;
  const concurrency = deps.concurrency ?? CONCURRENCY;
  const deadline = Date.now() + budgetMs;

  const { datasets, fieldMenu } = await bind(input.citedNodeIds);

  // Nothing to chart — return the (laid-out) template immediately, never call the model.
  if (fieldMenu.length === 0) {
    return finalize(templateBoard(input.citedNodeIds, fieldMenu), "analytic-grid", [], defaultPlan(fieldMenu), fieldMenu, datasets, input);
  }

  const schema = tileIRSchema(fieldMenu);
  const plan = await planBoard({ question: input.question, answerText: input.answerText, avoidArchetype: deps.avoidArchetype }, fieldMenu, { run, timeoutMs });
  // "More dashboards": if the planner still returned the archetype we're avoiding,
  // deterministically rotate to the next one so the re-compose is visibly different.
  if (deps.avoidArchetype && plan.archetype === deps.avoidArchetype) {
    plan.archetype = rotateArchetype(deps.avoidArchetype);
  }

  const ctxFor = (dataset: BoardSlot["dataset"]): CompileContext => ({ nodeIds: input.citedNodeIds, rowCount: datasets[dataset]?.length ?? 0 });
  const results: (GenerativeTile | null)[] = plan.slots.map(() => null);
  // Marks already committed to the board — pickBest discounts a repeat so each slot
  // reaches for a DISTINCT chart shape (fills as chart slots resolve; KPI cards have none).
  const usedMarks = new Set<string>();

  // KPI-family slots (kpi/gauge/spark) resolve host-side (no LLM) — stream them first,
  // they are instant. Each is a single-metric card computed from bound rows.
  plan.slots.forEach((slot, idx) => {
    if (!isKpiFamilyRole(slot.role)) return;
    const tile = makeKpiTile(slot, fieldMenu, datasets, input.citedNodeIds);
    results[idx] = tile;
    onDelta(tile);
  });

  // Chart slots — one LLM worker each, bounded concurrency, streamed as they resolve.
  const chartSlots = plan.slots.map((slot, idx) => ({ slot, idx })).filter(({ slot }) => !isKpiFamilyRole(slot.role));
  const runChartSlot = async ({ slot, idx }: { slot: BoardSlot; idx: number }): Promise<void> => {
    if (Date.now() > deadline) return; // budget spent — leave this slot to (maybe) reflexion
    const buffer = await runToBuffer(run, buildWorkerPrompt(slot, fieldMenu, input), timeoutMs);
    const best = pickBest(buffer, schema, fieldMenu, ctxFor(slot.dataset), datasets, usedMarks);
    if (best) {
      results[idx] = best;
      onDelta(best);
    }
  };
  await runPool(chartSlots, concurrency, runChartSlot);

  // ONE reflexion round for the chart slots that produced nothing (budget permitting).
  const failed = chartSlots.filter(({ idx }) => results[idx] === null);
  if (failed.length > 0 && Date.now() < deadline) {
    const critique = scoreBoard(results.filter(Boolean) as GenerativeTile[], plan, fieldMenu);
    const buffer = await runToBuffer(run, buildReflexionPrompt(failed, critique.feedback, fieldMenu, input), timeoutMs);
    const fixes = extractCompleteObjects(buffer, "tiles");
    let fi = 0;
    for (const { slot, idx } of failed) {
      // Assign the next accepted fix to the next failed slot, in order.
      while (fi < fixes.length) {
        const g = gateRawTile(fixes[fi++], schema, fieldMenu, ctxFor(slot.dataset));
        if (g.ok) {
          stampRowCount(g.tile, datasets);
          results[idx] = g.tile;
          onDelta(g.tile);
          break;
        }
      }
    }
  }

  const composed = results.filter(Boolean) as GenerativeTile[];
  if (composed.length === 0) {
    return finalize(templateBoard(input.citedNodeIds, fieldMenu), plan.archetype, deriveFilters(fieldMenu, plan.filterFields, datasets), plan, fieldMenu, datasets, input);
  }
  const board: GenerativeBoard = { version: 1, tiles: composed, citedNodeIds: input.citedNodeIds, source: "llm" };
  const filters = deriveFilters(fieldMenu, plan.filterFields, datasets);
  return finalize(board, plan.archetype, filters, plan, fieldMenu, datasets, input);
}

/** Lay the board out (host-owned role/span), attach filters + the board score, and
 *  build the "why this board" rationale. Shared by the success and fallback paths. */
function finalize(
  board: GenerativeBoard,
  archetype: BoardPlan["archetype"],
  filters: GenerativeBoard["filters"],
  plan: BoardPlan,
  fieldMenu: FieldMenuEntry[],
  datasets: GenerativeDatasets,
  input: ComposeGenerativeInput,
): ComposeGenerativeResult {
  const tiles = assignLayout(archetype, board.tiles);
  const critique = scoreBoard(tiles, plan, fieldMenu);
  return {
    board: {
      ...board,
      tiles,
      layout: archetype,
      filters: filters ?? [],
      boardScore: critique.score,
      boardRationale: buildRationale(archetype, plan, critique),
      plan,
    },
    datasets,
    fieldMenu,
  };
}

function makeKpiTile(slot: BoardSlot, fieldMenu: FieldMenuEntry[], datasets: GenerativeDatasets, citedNodeIds: string[]): GenerativeTile {
  const kpi = deriveKpi(slot, fieldMenu, datasets);
  return {
    id: `gen-${randomUUID().slice(0, 8)}`,
    title: kpi.label,
    dataset: slot.dataset,
    vlSkeleton: {},
    // Preserve the family role (kpi | gauge | spark) so the host renders the right card.
    role: slot.role,
    span: 1,
    kpi,
    status: "exploratory",
    appropriateness: 1,
    provenance: { nodeIds: citedNodeIds, fields: kpi.field ? [kpi.field] : [], rowCount: datasets[slot.dataset]?.length ?? 0 },
  };
}

/** The mark of a compiled tile (string form or `{type}` object form), for diversity. */
function markOf(tile: GenerativeTile): string | undefined {
  const m = (tile.vlSkeleton as { mark?: unknown }).mark;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") return (m as { type: string }).type;
  return undefined;
}

/** Choose a slot's winning candidate: rank by RAW critic score, and let mark-freshness
 *  decide ONLY among near-ties (within DIVERSITY_EPSILON of the top). A chart that fits
 *  meaningfully better always wins even if its mark repeats — diversity is a tiebreaker,
 *  never an override of fitness. Pure; exported for direct policy testing. */
export function chooseByFitnessThenFreshness<T extends { tile: GenerativeTile; score: number }>(
  candidates: T[],
  usedMarks: Set<string>,
): T {
  const topScore = Math.max(...candidates.map((c) => c.score));
  const nearTop = candidates.filter((c) => topScore - c.score <= DIVERSITY_EPSILON);
  const freshNearTop = nearTop.filter((c) => !usedMarks.has(markOf(c.tile) ?? ""));
  const pool = freshNearTop.length > 0 ? freshNearTop : nearTop;
  return pool.reduce((a, b) => (b.score > a.score ? b : a));
}

/** Parse a worker's buffer, gate each alternative, and return the best accepted tile —
 *  ranked by the critic score, with mark-freshness breaking near-ties only (see
 *  chooseByFitnessThenFreshness). Records the candidate audit on the winner.
 *  Mutates `usedMarks` with the chosen tile's mark. Null if none survive. */
function pickBest(
  buffer: string,
  schema: ReturnType<typeof tileIRSchema>,
  fieldMenu: FieldMenuEntry[],
  ctx: CompileContext,
  datasets: GenerativeDatasets,
  usedMarks: Set<string>,
): GenerativeTile | null {
  const candidates: { tile: GenerativeTile; score: number }[] = [];
  for (const raw of extractCompleteObjects(buffer, "tiles")) {
    if (candidates.length >= MAX_ALTERNATIVES) break;
    const g = gateRawTile(raw, schema, fieldMenu, ctx);
    if (g.ok) candidates.push({ tile: g.tile, score: g.score });
  }
  if (candidates.length === 0) return null;
  const best = chooseByFitnessThenFreshness(candidates, usedMarks);
  const mark = markOf(best.tile);
  if (mark) usedMarks.add(mark);
  // Candidate-and-rank audit surfaced in the UI ("chosen from N · fit X%").
  best.tile.candidateCount = candidates.length;
  best.tile.candidateScore = best.score;
  stampRowCount(best.tile, datasets);
  return best.tile;
}

/** Correct provenance.rowCount to the tile's ACTUAL chosen dataset (the worker's ctx
 *  used the slot's preferred dataset, which the model may have overridden). */
function stampRowCount(tile: GenerativeTile, datasets: GenerativeDatasets): void {
  if (tile.provenance) tile.provenance.rowCount = datasets[tile.dataset]?.length ?? tile.provenance.rowCount;
}

/** Accumulate a single LLM completion into a string; abort at the timeout; never throw. */
async function runToBuffer(
  run: (opts: ClaudeCodeRunOpts) => Promise<ClaudeCodeResult>,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), timeoutMs);
  (hardStop as unknown as { unref?: () => void }).unref?.();
  let buffer = "";
  try {
    await run({
      prompt,
      sink: (event) => {
        if (event.type === "token" && typeof event.text === "string") buffer += event.text;
      },
      signal: controller.signal,
      allowedTools: undefined,
      maxTurns: 1,
      idleTimeoutMs: timeoutMs,
      emitToolTrace: false,
      streamPartial: true,
      model: config.narrator.model,
      finopsSurface: "dashboard",
    });
  } catch (err) {
    log.warn(`[generative] board call failed (${err instanceof Error ? err.message : String(err)})`);
  } finally {
    clearTimeout(hardStop);
  }
  return buffer;
}

/** Bounded-concurrency map — runs `worker` over `items`, at most `concurrency` at
 *  once. A worker that throws is swallowed (its slot simply stays unfilled). */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runNext = async (): Promise<void> => {
    const idx = next++;
    if (idx >= items.length) return;
    try {
      await worker(items[idx]!);
    } catch (err) {
      log.warn(`[generative] worker failed (${err instanceof Error ? err.message : String(err)})`);
    }
    return runNext();
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => runNext()));
}

function buildRationale(archetype: BoardPlan["archetype"], plan: BoardPlan, critique: { score: number; feedback: string[] }): string {
  const pct = Math.round(critique.score * 100);
  const base = `${archetype} layout · ${plan.slots.length} tile${plan.slots.length === 1 ? "" : "s"} · ${plan.filterFields.length} filter${plan.filterFields.length === 1 ? "" : "s"} · board score ${pct}%`;
  return critique.feedback.length ? `${base}. Notes: ${critique.feedback.slice(0, 2).join("; ")}.` : `${base}.`;
}

function buildWorkerPrompt(slot: BoardSlot, fieldMenu: FieldMenuEntry[], input: ComposeGenerativeInput): string {
  return [
    "You compose ONE chart tile — with up to TWO alternative encodings — for a slot in a dashboard.",
    "You never supply data; you choose the chart shape over the ALREADY-BOUND datasets below.",
    "",
    `Slot intent: ${slot.intent}`,
    `Preferred dataset: ${slot.dataset}${slot.chartHint ? ` — chart hint: ${slot.chartHint}` : ""}`,
    "",
    "Datasets: cited (one row per node), metrics (tidy-long numeric attributes — best for PRR/ROR/case counts), edges (relationships).",
    "Fields available — a tile's fields MUST come from the dataset it selects:",
    fieldMenuLines(fieldMenu),
    "",
    "Return ONLY a JSON object, no prose, no markdown fences, with ONE or TWO alternative tiles for THIS slot:",
    '{ "tiles": [',
    '  { "title": string, "rationale"?: string (<=200 chars, never a data value), "dataset": "cited"|"metrics"|"edges", "mark": "bar"|"line"|"point"|"area"|"rect"|"tick"|"text"|"arc"|"boxplot",',
    '    "encoding": { "<x|y|color|size|opacity|tooltip|theta|column|row|xOffset>"?: { "field"?: string, "type"?: "quantitative"|"nominal"|"ordinal"|"temporal", "aggregate"?: "count"|"sum"|"mean"|"min"|"max", "bin"?: boolean } },',
    '    "transform"?: [{ "filter": { "field": string, "op": "="|"!="|">"|">="|"<"|"<="|"in", "value": string|number|boolean|(string|number)[] } }] } ] }',
    "",
    "Chart cookbook — prefer a RICHER, better-fitting encoding over a plain single-series bar when the data suits it:",
    "  • Donut (parts-of-whole, <=6 categories): mark 'arc', encoding { theta: {aggregate:'count'} OR {field, aggregate:'sum'}, color: {field, type:'nominal'} }.",
    "  • Heatmap / matrix (co-occurrence of two categories): mark 'rect', encoding { x: {field, type:'nominal'}, y: {field, type:'nominal'}, color: {aggregate:'count'} }.",
    "  • Grouped bars (compare a sub-category within groups): mark 'bar', encoding { x:{field,nominal}, y:{field,quantitative} OR {aggregate:'count'}, xOffset:{field, type:'nominal'} }.",
    "  • Stacked bars (composition within a category): mark 'bar', encoding { x:{field,nominal}, y:{aggregate:'count'}, color:{field, type:'nominal'} }.",
    "  • Small multiples (one panel per category): add column:{field, type:'nominal'} or row:{...} to any of the above.",
    "  • Trend: mark 'line'/'area' over an ORDERED x (temporal/quantitative), never nominal.",
    "Rules: return 1-2 tiles for the slot intent; if two, they MUST use DIFFERENT marks so a visually distinct option exists — favour pairing a plain bar with a richer cookbook encoding (donut / heatmap / grouped or stacked bar / faceted); honor the chart hint when the data supports it; prefer the slot's dataset; every field MUST be listed under the tile's chosen dataset; a channel needs a field OR aggregate:count; do NOT invent field names; do NOT emit raw Vega-Lite.",
    "",
    `Question (context): ${input.question}`,
    "JSON:",
  ].join("\n");
}

function buildReflexionPrompt(failed: { slot: BoardSlot; idx: number }[], feedback: string[], fieldMenu: FieldMenuEntry[], input: ComposeGenerativeInput): string {
  return [
    "reflexion round 1/1 — some dashboard slots produced no acceptable chart.",
    feedback.length ? `Board feedback: ${feedback.slice(0, 3).join("; ")}.` : "",
    "",
    "Produce ONE corrected chart tile for EACH slot below (same IR grammar), addressing its intent:",
    ...failed.map(({ slot, idx }) => `- slot ${idx}: intent="${slot.intent}", dataset=${slot.dataset}`),
    "",
    "Fields available — a tile's fields MUST come from the dataset it selects:",
    fieldMenuLines(fieldMenu),
    "",
    'Return ONLY a JSON object { "tiles": [ ... ] } — one tile per slot above, in order, same grammar as compose.',
    "",
    `Question (context): ${input.question}`,
    "JSON:",
  ].join("\n");
}
