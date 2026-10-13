/**
 * Board planner — the orchestrator's first (and only planning) LLM round.
 *
 * The planner emits INTENT ONLY: a layout archetype, which fields to expose as
 * filters (by NAME), and a set of slots (role + dataset + prose intent). It never
 * emits a span, a chart config, a control config, or a data value — the `.strict()`
 * `boardPlanSchema` fails-parse on any such key, and the server owns layout/filters
 * downstream (`layout.ts`). This mirrors the trust posture of `compileTile`: the
 * model proposes, the trusted host disposes.
 *
 * `planBoard` NEVER throws. On a blank menu, a timeout, a throw, or an unparseable
 * reply it returns the deterministic `defaultPlan`, so the orchestrator always has a
 * plan to work from. Exactly one LLM round (the local CLI is ~30s).
 */
import { z } from "zod";
import type { FieldMenuEntry, BoardPlan, BoardSlot, LayoutArchetype } from "@rnd/shared";
import { config } from "../config.js";
import { runClaudeCode, type ClaudeCodeRunOpts, type ClaudeCodeResult } from "../llm/claudeCode.js";
import { extractCompleteObjects } from "../llm/partialJson.js";
import { log } from "../log.js";
import { fieldMenuLines } from "./composer.js";

/** Hard cap on slots (tiles) in a plan — bounds the worker fan-out latency. */
export const MAX_SLOTS = 4;
/** Hard cap on the single planning LLM call — matches the composer's budget. */
const PLAN_TIMEOUT_MS = 30_000;

const ARCHETYPES = ["kpi-grid", "hero-rail", "bento", "small-multiples", "master-detail", "analytic-grid"] as const;
const ROLES = ["kpi", "hero", "detail", "gauge", "spark"] as const;
const DATASETS = ["cited", "metrics", "edges"] as const;

/** The model-facing plan schema. `.strict()` everywhere: any unknown key (span,
 *  config, data, …) fails parse. `filterFields` are validated against the field
 *  menu so the model cannot name a filter field that was never bound. */
export function boardPlanSchema(fieldMenu: FieldMenuEntry[]) {
  const names = new Set(fieldMenu.map((f) => f.name));
  return z
    .object({
      archetype: z.enum(ARCHETYPES),
      filterFields: z.array(z.string()).max(6).default([]),
      slots: z
        .array(
          z
            .object({
              role: z.enum(ROLES),
              dataset: z.enum(DATASETS),
              intent: z.string().max(200),
              chartHint: z.string().max(80).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_SLOTS),
    })
    .strict()
    .superRefine((p, ctx) => {
      p.filterFields.forEach((f, i) => {
        if (!names.has(f)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["filterFields", i], message: `filter field "${f}" is not in the field menu` });
        }
      });
    });
}
export type PlanIR = z.infer<ReturnType<typeof boardPlanSchema>>;

export interface PlanBoardInput {
  question: string;
  /** The grounded answer text — context for the model's layout/slot choices. */
  answerText: string;
  /** "More dashboards": the archetype the PREVIOUS board used, so the planner is nudged
   *  to pick a different one (a deterministic remap in the orchestrator enforces it). */
  avoidArchetype?: LayoutArchetype;
}

export interface PlanBoardDeps {
  /** LLM transport — same call shape as `runClaudeCode`. Tests inject a fake. */
  run?: (opts: ClaudeCodeRunOpts) => Promise<ClaudeCodeResult>;
  /** Per-call hard timeout override (ms). */
  timeoutMs?: number;
}

/**
 * A deterministic plan used whenever the model can't be reached or its reply is
 * unusable. Picks the safe analytic-grid archetype, derives filter fields from the
 * low-cardinality nominal columns, and lays out one KPI slot plus a detail slot per
 * bound dataset (capped at MAX_SLOTS). Pure.
 */
export function defaultPlan(fieldMenu: FieldMenuEntry[]): BoardPlan {
  const seen = new Set<string>();
  const filterFields: string[] = [];
  for (const f of fieldMenu) {
    const categorical = f.vlType === "nominal" || f.vlType === "ordinal";
    if (categorical && f.cardinality >= 2 && f.cardinality <= 25 && !seen.has(f.name)) {
      seen.add(f.name);
      filterFields.push(f.name);
      if (filterFields.length >= 3) break;
    }
  }
  const datasets = new Set(fieldMenu.map((f) => f.dataset));
  // Varied chart hints per slot so even the fallback board is NOT all-bars (the
  // "different chart per query" ask) — each hint suits its dataset's shape.
  const slots: BoardSlot[] = [{ role: "kpi", dataset: "cited", intent: "count of cited nodes" }];
  if (datasets.has("cited")) slots.push({ role: "detail", dataset: "cited", intent: "distribution of cited nodes by kind", chartHint: "donut" });
  if (datasets.has("metrics")) slots.push({ role: "detail", dataset: "metrics", intent: "numeric signal values across nodes and metrics", chartHint: "heatmap" });
  if (datasets.has("edges")) slots.push({ role: "detail", dataset: "edges", intent: "relationships among cited nodes by type", chartHint: "grouped-bar" });
  return { archetype: "analytic-grid", filterFields, slots: slots.slice(0, MAX_SLOTS) };
}

/** Plan a board with one LLM round. Never throws — falls back to `defaultPlan`. */
export async function planBoard(input: PlanBoardInput, fieldMenu: FieldMenuEntry[], deps: PlanBoardDeps = {}): Promise<BoardPlan> {
  if (fieldMenu.length === 0) return defaultPlan(fieldMenu);

  const run = deps.run ?? runClaudeCode;
  const timeoutMs = deps.timeoutMs ?? PLAN_TIMEOUT_MS;
  const schema = boardPlanSchema(fieldMenu);

  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), timeoutMs);
  (hardStop as unknown as { unref?: () => void }).unref?.();

  let buffer = "";
  try {
    await run({
      prompt: buildPlanPrompt(input, fieldMenu),
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
    log.warn(`[generative] plan call failed (${err instanceof Error ? err.message : String(err)}) — using default plan`);
    return defaultPlan(fieldMenu);
  } finally {
    clearTimeout(hardStop);
  }

  for (const raw of extractCompleteObjects(buffer, "plan")) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data as BoardPlan;
  }
  log.warn("[generative] plan produced nothing parseable — using default plan");
  return defaultPlan(fieldMenu);
}

/** The planning instruction: describe the six archetypes, show the field menu, and
 *  demand a single INTENT-only plan object under `{ "plan": [ ... ] }`. */
function buildPlanPrompt(input: PlanBoardInput, fieldMenu: FieldMenuEntry[]): string {
  return [
    "You PLAN a dashboard for a grounded answer in a knowledge-graph app.",
    "You choose the LAYOUT and WHICH tiles to show — you never supply data, styling, or sizes.",
    "",
    input.avoidArchetype
      ? `This is ANOTHER dashboard of the same evidence — the previous board used the "${input.avoidArchetype}" layout, so pick a DIFFERENT archetype and different tiles for a fresh perspective.`
      : "",
    "Pick ONE layout archetype that best fits the question:",
    "  - kpi-grid: a row of KPI stat cards then a few charts (default 'are we on track?').",
    "  - hero-rail: one dominant chart plus a supporting rail (one trend or measure dominates).",
    "  - bento: asymmetric tiles of varied size (heterogeneous, executive overview).",
    "  - small-multiples: the same chart repeated across a category (compare across one dimension).",
    "  - master-detail: an overview list plus a detail panel (entity exploration).",
    "  - analytic-grid: a uniform grid with a global filter bar (multi-measure exploration).",
    "",
    'Datasets a slot may use: cited (one row per node), metrics (tidy-long numeric attributes — best for PRR/ROR/case counts), edges (relationships).',
    "Fields available (choose which to FILTER by exact name — reference only these):",
    fieldMenuLines(fieldMenu),
    "",
    "Return ONLY a JSON object, no prose, no markdown fences, with EXACTLY ONE plan:",
    '{ "plan": [ {',
    '  "archetype": one of the six names above,',
    '  "filterFields": string[] (0-6 field NAMES from the menu to expose as filters),',
    '  "slots": [ { "role": "kpi"|"hero"|"detail"|"gauge"|"spark", "dataset": "cited"|"metrics"|"edges", "intent": string (<=200 chars, one line on what this tile shows), "chartHint"?: string } ]',
    "} ] }",
    "",
    "Slot roles — the server draws every one; you only name INTENT:",
    "  - kpi: a single headline number (a count or an aggregate) over the slot's rows.",
    "  - gauge: ONE headline metric shown on a radial dial against its range (e.g. a PRR/ROR level) — use the metrics dataset with a numeric value.",
    "  - spark: ONE metric with a small trend sparkline of its values across the bound rows — use the metrics dataset.",
    "  - hero: the dominant chart; detail: a supporting chart.",
    "",
    `Rules: 1-${MAX_SLOTS} slots; filterFields MUST be names from the menu above; intent is prose (never a number or a data value);`,
    "kpi/gauge/spark are single-metric cards the server COMPUTES from bound rows — prefer the metrics dataset for gauge/spark; you never supply the number, the range, or the series;",
    "give slots VARIED, RICHER chartHint values suited to each — donut for parts-of-whole (<=6 categories), heatmap for a two-category matrix, grouped-bar or stacked-bar for sub-categories, line/area for trends, point for correlations, small-multiples to facet; plain bar only when nothing richer fits; do NOT make every tile a bar;",
    "do NOT emit spans, sizes, colours, chart config, params, or data — the server owns all layout and styling.",
    "",
    `Question: ${input.question}`,
    `Answer (context only): ${input.answerText.replace(/\s+/g, " ").slice(0, 500)}`,
    "",
    "JSON:",
  ].join("\n");
}
