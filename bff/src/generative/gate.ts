/**
 * The per-tile acceptance gate — the exact trust chain the composer runs inline,
 * extracted so the orchestrator's workers reuse it verbatim instead of duplicating
 * it. One raw model object in → either a compiled, provenance-stamped tile (schema
 * ✓ + auto-fix + critic ✓ + trusted compile) or a rejection with the reason.
 *
 * DRY note: `composer.ts` still runs this logic inline and is left BYTE-IDENTICAL on
 * purpose (the single-pass fast path must not shift under us). A later refactor
 * could point the composer at `gateRawTile`; this file exists so the NEW orchestrator
 * never re-implements the trust seam.
 */
import { randomUUID } from "node:crypto";
import type { FieldMenuEntry, GenerativeTile } from "@rnd/shared";
import { tileIRSchema, compileTile, type CompileContext } from "./schema.js";
import { scoreTile, autoFixIR, QUALITY_THRESHOLD } from "./critic.js";

export type GateResult =
  | { ok: true; tile: GenerativeTile; score: number }
  | { ok: false; issues: string };

/**
 * Run one raw model object through the trust chain: strict schema parse → auto-fix
 * missing channel types → deterministic quality critic (gate on `QUALITY_THRESHOLD`)
 * → trusted `compileTile` (host owns params/config/data). The compiled tile carries
 * SERVER-derived provenance from `ctx` and its critic score as `appropriateness`.
 */
export function gateRawTile(
  raw: unknown,
  schema: ReturnType<typeof tileIRSchema>,
  fieldMenu: FieldMenuEntry[],
  ctx: CompileContext,
): GateResult {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const fixed = autoFixIR(parsed.data, fieldMenu);
  const critique = scoreTile(fixed, fieldMenu);
  if (critique.score < QUALITY_THRESHOLD) {
    return { ok: false, issues: critique.issues.join("; ") };
  }
  const compiled = compileTile(fixed, `gen-${randomUUID().slice(0, 8)}`, ctx);
  compiled.appropriateness = critique.score;
  return { ok: true, tile: compiled, score: critique.score };
}
