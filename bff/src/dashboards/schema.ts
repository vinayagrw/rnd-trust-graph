/**
 * DashboardSpec — the authoritative runtime validator (Zod v4, BFF-owned).
 *
 * This is the trust boundary for a generative dashboard. The composer's LLM output
 * (or the template builder's output) is parsed HERE before it is ever emitted over
 * the AG-UI seam. Two guarantees are enforced structurally, not by prompt:
 *
 *   1. STRUCTURAL INERTNESS — every object is `.strict()`, so a widget cannot carry
 *      any field beyond the fixed shape (no `url`, `html`, `value`, `mermaid`, …).
 *      Combined with the plain-type contract in `@rnd/shared`, there is no channel
 *      through which the model could inject a number, link, or markup.
 *
 *   2. GROUNDING — `citedNodeIds` must be non-empty and every `widget.nodeIds` must
 *      be a subset of it. The caller additionally intersects `citedNodeIds` with the
 *      answer's REAL citations before calling `validateSpec`, so a widget can only
 *      ever reference a node the read-only agent actually cited.
 *
 * The web renderer re-declares a light Zod v3 arg schema at the tool-call boundary
 * (it trusts this BFF-validated payload) — mirroring how `evidenceRenderer` treats
 * `render_evidence` args today.
 */
import { z } from "zod";
import type { DashboardSpec } from "@rnd/shared";

const widgetKind = z.enum([
  "citation-chips",
  "coverage-header",
  "evidence-ledger",
  "evidence-subgraph",
  "stat-chart",
  "hero-flow",
  "metric",
]);

const metricKind = z.enum(["faithfulness", "cited-count", "coverage"]);

const widgetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: widgetKind,
    title: z.string().max(120).optional(),
    nodeIds: z.array(z.string().min(1).max(80)).max(64).optional(),
    metric: metricKind.optional(),
    span: z.union([z.literal(1), z.literal(2)]).optional(),
  })
  .strict()
  .superRefine((w, ctx) => {
    // A metric tile MUST name its fixed metric; a non-metric tile must NOT carry one
    // (keeps the inert contract crisp — no smuggling a value via an unused field).
    if (w.kind === "metric" && !w.metric) {
      ctx.addIssue({ code: "custom", message: "metric widget requires a `metric`", path: ["metric"] });
    }
    if (w.kind !== "metric" && w.metric) {
      ctx.addIssue({ code: "custom", message: "`metric` is only valid on a metric widget", path: ["metric"] });
    }
  });

export const dashboardSpecSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(120),
    intent: z.string().max(400).optional(),
    widgets: z.array(widgetSchema).min(1).max(8),
    citedNodeIds: z.array(z.string().min(1).max(80)).min(1).max(64),
    source: z.enum(["llm", "template"]),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const cited = new Set(spec.citedNodeIds);
    spec.widgets.forEach((w, i) => {
      for (const id of w.nodeIds ?? []) {
        if (!cited.has(id)) {
          // GROUNDING VIOLATION — a widget referenced a node the answer did not cite.
          ctx.addIssue({
            code: "custom",
            message: `widget[${i}] references un-cited node "${id}"`,
            path: ["widgets", i, "nodeIds"],
          });
        }
      }
    });
  });

export type ValidatedDashboardSpec = z.infer<typeof dashboardSpecSchema>;

/** Parse + ground-check an untrusted spec. Returns the typed spec on success, or
 *  `{ ok: false, error }` with a compact reason — never throws. The caller falls
 *  back to the deterministic template on any failure. */
export function validateSpec(
  input: unknown,
): { ok: true; spec: DashboardSpec } | { ok: false; error: string } {
  const parsed = dashboardSpecSchema.safeParse(input);
  if (parsed.success) return { ok: true, spec: parsed.data as DashboardSpec };
  const first = parsed.error.issues[0];
  const where = first?.path?.length ? ` at ${first.path.join(".")}` : "";
  return { ok: false, error: `${first?.message ?? "invalid spec"}${where}` };
}
