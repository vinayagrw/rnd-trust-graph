/**
 * Generative Studio composer — streaming IR -> compiled-tile lane with a
 * single repair round and a deterministic template safety net.
 *
 * MIRRORS `bff/src/dashboards/composer.ts`'s `composeDashboardStreaming`: same
 * token-buffer + brace-balanced-scan loop (now shared via `../llm/partialJson.js`),
 * same never-throws contract. What differs is what the model is trusted with:
 * here it writes `TileIR` objects (T3 `tileIRSchema`) over a field menu the
 * SERVER bound from already-cited nodes (T4 `bindFromGraph`/`bindDatasets`) —
 * the TRUSTED COMPILER (`compileTile`) turns a valid IR into a constrained VL
 * fragment. The model never emits Vega-Lite or a data value directly.
 *
 * Testability: `composeGenerativeStreaming`'s public contract is exactly
 * `(input, onDelta) => Promise<...>` (see T7's wiring). A third, OPTIONAL
 * `deps` argument lets tests swap in a fixture-backed `bind` and a scripted
 * fake `run` (same shape as `runClaudeCode`) so the whole streaming + repair +
 * fallback state machine is exercised with no Neo4j and no real CLI. Deviation
 * from the dashboards composer: there is no `liveModeAvailable()` short-circuit
 * here — the injected `run` (or `runClaudeCode` in production) already resolves
 * `{ ok: false }` when live mode is unavailable, which drives the same
 * template fallback; skipping the extra gate keeps this seam purely
 * dependency-injected instead of coupled to ambient env/config.
 */
import { randomUUID } from "node:crypto";
import type { FieldMenuEntry, GenerativeBoard, GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { config } from "../config.js";
import { runClaudeCode, type ClaudeCodeRunOpts, type ClaudeCodeResult } from "../llm/claudeCode.js";
import { extractCompleteObjects } from "../llm/partialJson.js";
import { log } from "../log.js";
import { bindDatasets } from "./bind.js";
import { tileIRSchema, compileTile } from "./schema.js";
import { scoreTile, autoFixIR, QUALITY_THRESHOLD } from "./critic.js";
import { templateBoard } from "./templates.js";

/** Hard cap on ONE composer LLM call (independent of the idle watchdog) — a
 *  slow model can never stall the response; we drop to the template instead. */
const COMPOSE_TIMEOUT_MS = 30_000;

/** Spec cap — matches Task 5/9's "small set of charts" intent. */
const MAX_TILES = 6;

export interface ComposeGenerativeInput {
  question: string;
  /** The grounded answer text — context for the model's title choices. */
  answerText: string;
  /** The REAL cited nodes (already intersected with the live graph). */
  citedNodeIds: string[];
}

export interface ComposeGenerativeResult {
  board: GenerativeBoard;
  datasets: GenerativeDatasets;
  fieldMenu: FieldMenuEntry[];
}

export interface ComposeGenerativeDeps {
  /** Bind datasets/fieldMenu from the cited set. Defaults to the real T4
   *  `bindDatasets` (Neo4j-backed). Tests inject a fixture-backed fake (or the
   *  real, pure `bindFromGraph` over a fixture graph) so no Neo4j is touched. */
  bind?: (citedNodeIds: string[]) => Promise<{ datasets: GenerativeDatasets; fieldMenu: FieldMenuEntry[] }>;
  /** LLM transport — same call shape as `runClaudeCode`. Defaults to the real
   *  local-CLI provider; tests inject a fake that feeds a scripted token stream. */
  run?: (opts: ClaudeCodeRunOpts) => Promise<ClaudeCodeResult>;
  /** Per-call hard timeout override (ms) — tests shrink this to prove the
   *  abort-on-timeout path without waiting out the real 30s budget. */
  timeoutMs?: number;
}

interface FailedTile {
  raw: unknown;
  issues: string;
}

/** Compose a Generative Studio board with genuine token-streaming and ONE
 *  repair round. Never throws; always returns a valid board (LLM-composed
 *  when possible, else the deterministic template). */
export async function composeGenerativeStreaming(
  input: ComposeGenerativeInput,
  onDelta: (tile: GenerativeTile) => void,
  deps: ComposeGenerativeDeps = {},
): Promise<ComposeGenerativeResult> {
  const bind = deps.bind ?? bindDatasets;
  const run = deps.run ?? runClaudeCode;
  const timeoutMs = deps.timeoutMs ?? COMPOSE_TIMEOUT_MS;

  // Grounding gate — bind ONCE, up front. No cited nodes resolving to fields
  // (empty field menu) means nothing to chart: return the template immediately
  // (empty tiles) and never invoke the model. The caller's grounded gate means
  // this normally never renders.
  const { datasets, fieldMenu } = await bind(input.citedNodeIds);
  const templateOf = (): GenerativeBoard => templateBoard(input.citedNodeIds, fieldMenu);
  if (fieldMenu.length === 0) {
    return { board: templateOf(), datasets, fieldMenu };
  }

  const schema = tileIRSchema(fieldMenu);

  const valid: GenerativeTile[] = [];
  const seenTitles = new Set<string>();
  let failed: FailedTile[] = [];
  let cursor = 0; // index into extractCompleteObjects(buffer,"tiles") already processed, for the CURRENT round's buffer

  const scanAndEmit = (buffer: string): void => {
    if (valid.length >= MAX_TILES) return;
    const all = extractCompleteObjects(buffer, "tiles");
    for (; cursor < all.length; cursor++) {
      if (valid.length >= MAX_TILES) break;
      const raw = all[cursor];
      const title = rawTitle(raw);
      if (title && seenTitles.has(title)) continue;
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        failed.push({ raw, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        continue;
      }
      // Auto-fix the trivially-fixable (missing channel type) then run the
      // deterministic quality critic. A low-scoring chart is NOT emitted — it is
      // routed into the single repair round with the critic's issues (its title is
      // NOT reserved, so a corrected version can still come back).
      const fixed = autoFixIR(parsed.data, fieldMenu);
      const critique = scoreTile(fixed, fieldMenu);
      if (critique.score < QUALITY_THRESHOLD) {
        failed.push({ raw: fixed, issues: critique.issues.join("; ") });
        continue;
      }
      if (title) seenTitles.add(title);
      // Provenance is SERVER-derived: the cited set the datasets were bound from and
      // the row count of the dataset this tile selected. The model contributes only
      // its (prose) rationale.
      const compiled = compileTile(fixed, `gen-${randomUUID().slice(0, 8)}`, {
        nodeIds: input.citedNodeIds,
        rowCount: datasets[fixed.dataset].length,
      });
      compiled.appropriateness = critique.score;
      valid.push(compiled);
      onDelta(compiled);
    }
  };

  /** Run ONE completion against `run`, streaming tokens into a fresh buffer.
   *  Never throws — a synchronous throw or a rejected promise both resolve
   *  the same as a failed run so the caller can fall through to repair/template. */
  const runOnce = async (prompt: string): Promise<void> => {
    const controller = new AbortController();
    const hardStop = setTimeout(() => controller.abort(), timeoutMs);
    (hardStop as unknown as { unref?: () => void }).unref?.();
    let buffer = "";
    try {
      await run({
        prompt,
        sink: (event) => {
          if (event.type === "token" && typeof event.text === "string") {
            buffer += event.text;
            scanAndEmit(buffer);
          }
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
      log.warn(`[generative] compose call failed (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      clearTimeout(hardStop);
    }
  };

  cursor = 0;
  await runOnce(buildComposerPrompt(input, fieldMenu));

  // ONE repair round: only if something failed and there is still room.
  if (failed.length > 0 && valid.length < MAX_TILES) {
    const toRepair = failed;
    failed = [];
    cursor = 0;
    await runOnce(buildRepairPrompt(fieldMenu, toRepair));
  }

  if (valid.length === 0) {
    // Falling back to the template means the model returned nothing this lane could
    // accept. Say WHY (schema issues / critic issues), or the fallback is silent and
    // a prompt regression looks identical to a slow model.
    log.warn(
      `[generative] no valid tile — falling back to template` +
        (failed.length
          ? ` (${failed.length} rejected: ${failed.slice(0, 3).map((f) => f.issues).join(" | ")})`
          : " (model returned no parseable tile)"),
    );
    return { board: templateOf(), datasets, fieldMenu };
  }
  return {
    board: { version: 1, tiles: valid.slice(0, MAX_TILES), citedNodeIds: input.citedNodeIds, source: "llm" },
    datasets,
    fieldMenu,
  };
}

function rawTitle(raw: unknown): string | undefined {
  if (raw && typeof raw === "object" && typeof (raw as { title?: unknown }).title === "string") {
    return (raw as { title: string }).title;
  }
  return undefined;
}

/** Render the field menu grouped by dataset — a tile's field refs must come from
 *  the dataset it selects, so the model needs to see which fields live where.
 *  Exported so the refine lane (`refine.ts`) shows the SAME menu as compose. */
export function fieldMenuLines(fieldMenu: FieldMenuEntry[]): string {
  const order: FieldMenuEntry["dataset"][] = ["cited", "metrics", "edges"];
  const lines: string[] = [];
  for (const ds of order) {
    const fields = fieldMenu.filter((f) => f.dataset === ds);
    if (fields.length === 0) continue;
    lines.push(`  dataset "${ds}":`);
    for (const f of fields) lines.push(`    - ${f.name} (${f.vlType}, ~${f.cardinality} distinct)`);
  }
  return lines.join("\n");
}

/** The composer instruction. Constrained hard: JSON only, the exact IR grammar
 *  (mirrors `tileIRSchema`), only field names drawn from the bound menu — the
 *  model never writes raw Vega-Lite or a data value. */
function buildComposerPrompt(input: ComposeGenerativeInput, fieldMenu: FieldMenuEntry[]): string {
  return [
    "You compose a small set of CHARTS for a grounded answer in a knowledge-graph app.",
    "You never supply data — you choose WHICH chart(s) to draw over the ALREADY-BOUND datasets below.",
    "",
    'Datasets (pick ONE per tile via "dataset"): cited (one row per node), metrics (tidy long: one row per numeric attribute — best for PRR/ROR/case-count style comparisons), edges (the relationships).',
    "Fields available — each tile's fields MUST come from the dataset that tile selects:",
    fieldMenuLines(fieldMenu),
    "",
    "Return ONLY a JSON object, no prose, no markdown fences, matching exactly:",
    '{ "tiles": [',
    '  { "title": string, "rationale"?: string (<=200 chars — ONE sentence on why THIS chart shape fits; never a number or a data value),',
    '    "dataset": "cited"|"metrics"|"edges", "mark": "bar"|"line"|"point"|"area"|"rect"|"tick"|"text"|"arc"|"boxplot",',
    '    "encoding": { "<x|y|color|size|opacity|tooltip|theta|column|row|xOffset>"?: { "field"?: string, "type"?: "quantitative"|"nominal"|"ordinal"|"temporal", "aggregate"?: "count"|"sum"|"mean"|"min"|"max", "bin"?: boolean } },',
    '    "transform"?: [{ "filter": { "field": string, "op": "="|"!="|">"|">="|"<"|"<="|"in", "value": string|number|boolean|(string|number)[] } }] }',
    "] }",
    "",
    "Rules: 1-6 tiles; give every tile a rationale; every field MUST be listed under the tile's chosen dataset; a channel needs a field OR aggregate:count;",
    "prefer the metrics dataset (field 'value' by 'metric') to chart numeric signal values; do NOT invent field names,",
    "do NOT add keys beyond this grammar, do NOT emit raw Vega-Lite (no usermeta/expr/on/href).",
    "Chart hints: heatmap = rect + x + y + color; pie = arc + theta + color; small-multiples = add column/row to facet; grouped bars = bar + x + xOffset + color; boxplot = boxplot mark over a quantitative field.",
    "",
    `Question: ${input.question}`,
    `Answer (for titling only): ${input.answerText.replace(/\s+/g, " ").slice(0, 500)}`,
    "",
    "JSON:",
  ].join("\n");
}

/** The single repair-round instruction — echoes the failing tiles and their
 *  zod issues VERBATIM so the model can see exactly what to fix. */
function buildRepairPrompt(fieldMenu: FieldMenuEntry[], failedTiles: FailedTile[]): string {
  return [
    "repair round 1/1 — the following tiles you returned failed validation.",
    'Return ONLY a corrected JSON object of the SAME shape as before: { "tiles": [...] },',
    "containing just the corrected tiles (you may drop one you cannot fix).",
    "",
    "Fields available (reference by name — ONLY these):",
    fieldMenuLines(fieldMenu),
    "",
    "Failing tiles and their validation errors:",
    ...failedTiles.slice(0, 10).map((f, i) => `${i + 1}. tile: ${JSON.stringify(f.raw)}\n   errors: ${f.issues}`),
    "",
    "JSON:",
  ].join("\n");
}
