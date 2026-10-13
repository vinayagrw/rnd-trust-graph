/**
 * Deterministic BOARD-level critic — NO LLM. The per-tile critic (`scoreTile`) only
 * judges one chart's shape; this judges the whole board against the plan, so "pick
 * the best board" has an explainable, testable rubric rather than a vibe.
 *
 * It combines the tiles' own `appropriateness` with board signals: slot COVERAGE,
 * mark DIVERSITY (the direct antidote to "every query gives the same chart"),
 * REDUNDANCY (two identical chart shapes), layout BALANCE, and FILTER completeness.
 * `feedback` is the structured, human-readable rationale; `failedSlots` is a
 * coverage signal (trailing uncovered slot indices).
 */
import type { BoardPlan, FieldMenuEntry, GenerativeTile } from "@rnd/shared";

/** Below this a board is re-worked (one reflexion round). Same bar as the per-tile
 *  gate so a board of good tiles clears it and a degenerate board does not. */
export const BOARD_THRESHOLD = 0.6;

const COVERAGE_PER_MISSING = 0.2;
const DIVERSITY = 0.25;
const REDUNDANCY_PER_DUPE = 0.15;
const NO_CHART = 0.15;
const FILTER_UNRESOLVED = 0.1;

export interface BoardCritique {
  score: number;
  feedback: string[];
  /** Slot indices with no covering tile (trailing, coverage signal). */
  failedSlots: number[];
}

export function scoreBoard(tiles: GenerativeTile[], plan: BoardPlan, fieldMenu: FieldMenuEntry[]): BoardCritique {
  const feedback: string[] = [];
  let score = 1;
  const penalize = (w: number, msg: string) => {
    score -= w;
    feedback.push(msg);
  };

  // Coverage — did every planned slot produce a tile?
  const missing = Math.max(0, plan.slots.length - tiles.length);
  const failedSlots = Array.from({ length: missing }, (_, i) => plan.slots.length - missing + i);
  if (missing > 0) penalize(COVERAGE_PER_MISSING * missing, `coverage: ${tiles.length}/${plan.slots.length} planned slots produced a tile`);

  // Average per-tile quality drags the board when the charts themselves are weak.
  const apps = tiles.map((t) => t.appropriateness ?? 0.8);
  const avgApp = apps.length ? apps.reduce((a, b) => a + b, 0) / apps.length : 0;
  if (tiles.length && avgApp < 0.8) penalize(0.8 - avgApp, `average chart quality is ${avgApp.toFixed(2)}`);

  const chartTiles = tiles.filter((t) => !t.kpi && (t.vlSkeleton as { mark?: unknown }).mark);

  // Mark diversity — an all-identical board is the "same chart every query" smell.
  const marks = new Set(chartTiles.map(markOf));
  if (chartTiles.length >= 2 && marks.size === 1) penalize(DIVERSITY, `low mark diversity — every chart is a ${[...marks][0]}`);

  // Redundancy — two tiles with an identical mark+encoding signature add nothing.
  const sigs = chartTiles.map(sigOf);
  const dupes = sigs.length - new Set(sigs).size;
  if (dupes > 0) penalize(REDUNDANCY_PER_DUPE * dupes, `${dupes} redundant tile${dupes === 1 ? "" : "s"} with an identical chart shape`);

  // Balance — a board with no chart at all (only KPIs) is not a dashboard.
  if (tiles.length > 0 && chartTiles.length === 0) penalize(NO_CHART, "no chart tiles — only KPI cards");

  // Filter completeness — every requested filter field must resolve to a bound field.
  const menuNames = new Set(fieldMenu.map((f) => f.name));
  const unresolved = plan.filterFields.filter((f) => !menuNames.has(f));
  if (unresolved.length) penalize(FILTER_UNRESOLVED, `filter field(s) not bound: ${unresolved.join(", ")}`);

  return { score: Math.max(0, Math.min(1, score)), feedback, failedSlots };
}

function markOf(t: GenerativeTile): string {
  return String((t.vlSkeleton as { mark?: unknown }).mark ?? "?");
}

function sigOf(t: GenerativeTile): string {
  const sk = t.vlSkeleton as { mark?: unknown; encoding?: unknown };
  return `${String(sk.mark ?? "?")}|${JSON.stringify(sk.encoding ?? {})}`;
}
