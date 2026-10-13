/**
 * Generative Studio — refine-a-tile lane.
 *
 * Turns a near-miss tile into the right one in ONE turn ("make it a log scale",
 * "top 5 only", "swap to a line", "facet by kind") instead of re-asking the whole
 * question. The seam is deliberately narrow and reuses the composer's trust chain
 * verbatim: the model is shown the PRIOR tile's encoding (never data) plus the same
 * dataset-scoped field menu, and asked for ONE corrected `TileIR`; the SAME trusted
 * `tileIRSchema` + `autoFixIR` + `scoreTile` + `compileTile` that gate compose gate
 * this too. The model still never emits a data value, and the refined tile keeps the
 * SAME id and provenance node set — refine re-binds from the tile's own cited nodes,
 * it never selects new grounding.
 *
 * Contract: exactly ONE LLM round (the local CLI is ~30s — a refine that fanned out
 * would be unusable), and it NEVER throws. On any failure (blank instruction, a
 * timeout, an unparseable/low-quality reply) it resolves `null` and the caller leaves
 * the prior tile standing.
 */
import { randomUUID } from "node:crypto";
import type { FieldMenuEntry, GenerativeTile } from "@rnd/shared";
import { config } from "../config.js";
import { runClaudeCode, type ClaudeCodeRunOpts, type ClaudeCodeResult } from "../llm/claudeCode.js";
import { extractCompleteObjects } from "../llm/partialJson.js";
import { log } from "../log.js";
import { fieldMenuLines } from "./composer.js";
import { tileIRSchema, compileTile, type CompileContext } from "./schema.js";
import { scoreTile, autoFixIR, QUALITY_THRESHOLD } from "./critic.js";

/** Hard cap on the single refine LLM call — matches the composer's budget. */
const REFINE_TIMEOUT_MS = 30_000;

export interface RefineTileDeps {
  /** LLM transport — same call shape as `runClaudeCode`. Defaults to the real
   *  local-CLI provider; tests inject a fake that feeds a scripted token stream. */
  run?: (opts: ClaudeCodeRunOpts) => Promise<ClaudeCodeResult>;
  /** Per-call hard timeout override (ms) — tests shrink this to prove the
   *  abort-on-timeout path without waiting out the real 30s budget. */
  timeoutMs?: number;
}

/**
 * Refine one tile against a natural-language instruction. Returns a NEW compiled tile
 * that keeps `priorTile.id` (so the store updates it in place) and `ctx` provenance,
 * or `null` if the model produced nothing this lane can accept.
 */
export async function refineTile(
  priorTile: GenerativeTile,
  instruction: string,
  fieldMenu: FieldMenuEntry[],
  ctx: CompileContext,
  deps: RefineTileDeps = {},
): Promise<GenerativeTile | null> {
  const trimmed = instruction.trim();
  // Nothing to do (blank chip / empty box) — never spend an LLM round, never touch the tile.
  if (!trimmed || fieldMenu.length === 0) return null;

  const run = deps.run ?? runClaudeCode;
  const timeoutMs = deps.timeoutMs ?? REFINE_TIMEOUT_MS;
  const schema = tileIRSchema(fieldMenu);

  const controller = new AbortController();
  const hardStop = setTimeout(() => controller.abort(), timeoutMs);
  (hardStop as unknown as { unref?: () => void }).unref?.();

  let buffer = "";
  try {
    await run({
      prompt: buildRefinePrompt(priorTile, trimmed, fieldMenu),
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
    log.warn(`[generative] refine call failed (${err instanceof Error ? err.message : String(err)})`);
    return null;
  } finally {
    clearTimeout(hardStop);
  }

  // Take the FIRST tile the model returned that survives the SAME gate as compose:
  // schema parse -> auto-fix missing channel types -> deterministic quality critic.
  for (const raw of extractCompleteObjects(buffer, "tiles")) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) continue;
    const fixed = autoFixIR(parsed.data, fieldMenu);
    if (scoreTile(fixed, fieldMenu).score < QUALITY_THRESHOLD) continue;
    // Keep the prior id so the client replaces the tile in place; provenance is
    // re-derived from the SAME cited node set (ctx), never a new grounding.
    const compiled = compileTile(fixed, priorTile.id, ctx);
    compiled.appropriateness = scoreTile(fixed, fieldMenu).score;
    return compiled;
  }

  log.warn(`[generative] refine produced no acceptable tile for "${trimmed.slice(0, 60)}"`);
  return null;
}

/** Describe the PRIOR chart to the model as its own IR grammar (mark + encoding +
 *  dataset + transform), echo the same dataset-scoped field menu compose uses, and
 *  ask for exactly ONE corrected tile. Encoding-only — the prior carries no data. */
function buildRefinePrompt(priorTile: GenerativeTile, instruction: string, fieldMenu: FieldMenuEntry[]): string {
  const sk = priorTile.vlSkeleton as Record<string, unknown>;
  const prior = {
    title: priorTile.title,
    dataset: priorTile.dataset,
    mark: sk.mark,
    encoding: sk.encoding,
    ...(sk.transform ? { transform: sk.transform } : {}),
  };
  return [
    "You REFINE one chart in a grounded knowledge-graph app. You never supply data —",
    "you adjust WHICH chart is drawn over the ALREADY-BOUND datasets below.",
    "",
    "The chart to refine (its current encoding — no data values):",
    JSON.stringify(prior),
    "",
    `User's instruction: ${instruction}`,
    "",
    'Datasets (pick ONE via "dataset"): cited (one row per node), metrics (tidy long: one row per numeric attribute — best for PRR/ROR/case-count comparisons), edges (relationships).',
    "Fields available — the tile's fields MUST come from the dataset it selects:",
    fieldMenuLines(fieldMenu),
    "",
    "Return ONLY a JSON object, no prose, no markdown fences, with EXACTLY ONE tile:",
    '{ "tiles": [',
    '  { "title": string, "rationale"?: string (<=200 chars — one sentence on the shape, never a data value),',
    '    "dataset": "cited"|"metrics"|"edges", "mark": "bar"|"line"|"point"|"area"|"rect"|"tick"|"text"|"arc"|"boxplot",',
    '    "encoding": { "<x|y|color|size|opacity|tooltip|theta|column|row|xOffset>"?: { "field"?: string, "type"?: "quantitative"|"nominal"|"ordinal"|"temporal", "aggregate"?: "count"|"sum"|"mean"|"min"|"max", "bin"?: boolean } },',
    '    "transform"?: [{ "filter": { "field": string, "op": "="|"!="|">"|">="|"<"|"<="|"in", "value": string|number|boolean|(string|number)[] } }] } ] }',
    "",
    "Rules: keep the SAME dataset unless the instruction clearly needs another; apply the instruction faithfully;",
    "every field MUST be listed under the tile's chosen dataset; a channel needs a field OR aggregate:count;",
    "do NOT invent field names; do NOT add keys beyond this grammar; do NOT emit raw Vega-Lite (no usermeta/expr/on/href).",
    "Hints: 'log scale' -> keep the field, the host applies scale; 'top N' -> a transform filter or fewer categories; 'swap mark' -> change mark; 'facet by X' -> add column or row with field X.",
    "",
    "JSON:",
  ].join("\n");
}
