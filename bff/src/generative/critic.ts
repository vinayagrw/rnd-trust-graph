/**
 * Deterministic chart-quality critic (Draco-lite) — NO LLM.
 *
 * VisEval's error profile: frontier models emit *runnable* Vega-Lite ~85–96% of
 * the time, but a meaningful slice is the "illegal" bucket — valid spec, wrong
 * mapping (a line over a nominal x, a 20-slice pie, a bare count). A cheap
 * deterministic design-rule pass catches exactly that bucket before render, and a
 * spec-level score correlates ~0.65 with human judgement (VegaChat, 2026) — so we
 * gate emission on it and feed its issues into the single repair round.
 *
 * `scoreTile` is pure and side-effect free; `autoFixIR` fixes the trivially-fixable
 * (missing channel `type`, inferable from the bound field menu) so those never even
 * count against the score.
 */
import type { FieldMenuEntry } from "@rnd/shared";
import type { TileIR } from "./schema.js";

export interface TileCritique {
  /** 0..1 — higher is a better-fitting chart. */
  score: number;
  issues: string[];
}

/** Below this, a tile is NOT emitted — it is routed into the repair round with the
 *  critic's issues so the model can correct it (or it is dropped). Chosen so a
 *  single MAJOR defect fails, a single MODERATE/MINOR passes. */
export const QUALITY_THRESHOLD = 0.6;

const MAJOR = 0.5;
const MODERATE = 0.25;
const MINOR = 0.1;

type Channel = { field?: string; type?: string; aggregate?: string; bin?: boolean };

function menuFor(fieldMenu: FieldMenuEntry[], dataset: string): Map<string, FieldMenuEntry> {
  const m = new Map<string, FieldMenuEntry>();
  for (const f of fieldMenu) if (f.dataset === dataset) m.set(f.name, f);
  return m;
}

/** Fill a channel's missing `type` from the bound field menu (deterministic, safe).
 *  A field ref always has a menu entry (schema validated it), so this can't invent. */
export function autoFixIR(ir: TileIR, fieldMenu: FieldMenuEntry[]): TileIR {
  const menu = menuFor(fieldMenu, ir.dataset);
  const encoding = { ...ir.encoding } as Record<string, Channel | undefined>;
  for (const [ch, def] of Object.entries(encoding)) {
    if (def?.field && !def.type) {
      const vt = menu.get(def.field)?.vlType;
      if (vt) encoding[ch] = { ...def, type: vt };
    }
  }
  return { ...ir, encoding: encoding as TileIR["encoding"] };
}

/** Score a chart's shape against design rules. Pure. */
export function scoreTile(ir: TileIR, fieldMenu: FieldMenuEntry[]): TileCritique {
  const menu = menuFor(fieldMenu, ir.dataset);
  const enc = ir.encoding as Record<string, Channel | undefined>;
  const issues: string[] = [];
  let score = 1;
  const penalize = (w: number, msg: string) => { score -= w; issues.push(msg); };

  const typeOf = (c: string): string | undefined => {
    const d = enc[c];
    return d?.field ? menu.get(d.field)?.vlType ?? d.type : d?.type;
  };
  const cardOf = (c: string): number | undefined => {
    const d = enc[c];
    return d?.field ? menu.get(d.field)?.cardinality : undefined;
  };
  const hasPos = Boolean(enc.x || enc.y);
  const channels = Object.values(enc).filter(Boolean) as Channel[];

  // 1 — positional marks need at least one of x/y.
  if (["bar", "line", "area", "tick", "point", "rect"].includes(ir.mark) && !hasPos) {
    penalize(MAJOR, `${ir.mark} needs an x or y channel`);
  }
  // 2 — line/area imply an ORDERED x (temporal/quantitative/ordinal), not nominal.
  if (["line", "area"].includes(ir.mark) && typeOf("x") === "nominal") {
    penalize(MODERATE, "line/area over a nominal x — use bar, or put an ordered (temporal/quantitative) field on x");
  }
  // 3 — arc/pie needs theta; too many slices is unreadable.
  if (ir.mark === "arc") {
    if (!enc.theta) penalize(MAJOR, "arc/pie needs a theta channel");
    const cc = cardOf("color");
    if (cc && cc > 6) penalize(MODERATE, `pie has ${cc} slices — hard to read; prefer a bar`);
  }
  // 4 — categorical overplotting on a positional channel.
  for (const c of ["x", "y"]) {
    const k = cardOf(c);
    if (typeOf(c) === "nominal" && k && k > 30 && ["bar", "point", "rect", "tick"].includes(ir.mark)) {
      penalize(MODERATE, `${c} has ${k} categories — too many to read; filter or aggregate`);
    }
  }
  // 5 — unreadable color legend.
  {
    const k = cardOf("color");
    if (typeOf("color") === "nominal" && k && k > 12) penalize(MINOR, `color legend has ${k} entries — hard to read`);
  }
  // 6 — boxplot needs a quantitative field to summarise.
  if (ir.mark === "boxplot" && !["x", "y"].some((c) => typeOf(c) === "quantitative")) {
    penalize(MAJOR, "boxplot needs a quantitative field on x or y");
  }
  // 7 — a lone count with no dimension is low-information.
  if (channels.length === 1 && channels[0]?.aggregate === "count" && !channels[0]?.field) {
    penalize(MAJOR, "a single count with no dimension is low-information — add a category to x or color");
  }

  return { score: Math.max(0, Math.min(1, score)), issues };
}
