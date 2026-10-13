/**
 * @rnd/dashboards — the `render_dashboard` tool-call renderer.
 *
 * Registered in CopilotChatBeat's `renderToolCalls` array, modelled on
 * `evidenceRenderer`. It closes over the live `graph` payload and renders the
 * composed DashboardSpec via `DashboardCanvas`. The args schema is deliberately
 * light (Zod v3): the spec was already validated by the BFF (`dashboardSpecSchema`,
 * grounding-checked and structurally inert), so the renderer trusts and passes it
 * through — the same trust posture `evidenceRenderer` takes with `render_evidence`.
 *
 * Phase 2:
 *  - F7 — a follow-up board is MERGED into the active lineage (`applyIncoming`) so
 *    the dashboard evolves in place; changed widget ids drive the patch pulse.
 *  - F8 — `certified` (widget ids) + `audit` ride alongside the spec from trusted
 *    BFF channels (never inside the inert spec) and drive the trust badges.
 *  - F6 — `onAsk` submits a grounded drill-down turn (bridged from CopilotSurface).
 */
import { z } from "zod";
import type { ReactToolCallRenderer } from "@copilotkit/react-core/v2";
import type { DashboardAudit, DashboardSpec, FaithfulnessResult, GraphNode, GraphPayload } from "@rnd/shared";
import { DashboardCanvas } from "./DashboardCanvas.js";
import { applyIncoming, setSurfaceTrust } from "./lineageStore.js";

export function dashboardRenderer(
  graph: GraphPayload,
  opts?: {
    onFocusNode?: (n: GraphNode) => void;
    onAsk?: (question: string) => void;
    /** F10 — publish the on-screen (inert) spec + trusted audit. */
    onSave?: (spec: DashboardSpec, audit: DashboardAudit | null) => Promise<void> | void;
    /** Which lineage this board merges into ("studio" for the Studio pane,
     *  default "conversation" for the inline Conversation surface). */
    surface?: import("./lineageStore.js").DashboardSurface;
    /** Studio pane mode: push the board to the (studio) lineage for the persistent
     *  canvas and return a compact "opened in canvas" chip inline instead of a full board. */
    renderChipOnly?: boolean;
  },
): ReactToolCallRenderer<{
  spec?: DashboardSpec;
  faithfulness?: FaithfulnessResult | null;
  certified?: string[];
  audit?: DashboardAudit | null;
  runId?: string;
  final?: boolean;
}> {
  return {
    name: "render_dashboard",
    // Loose by design — the BFF is the validator. We only need the payload through.
    // `runId`/`final` MUST be declared: Zod v3 `z.object` strips undeclared keys.
    args: z.object({
      spec: z.any().optional(),
      faithfulness: z.any().optional(),
      certified: z.any().optional(),
      audit: z.any().optional(),
      runId: z.string().optional(),
      final: z.boolean().optional(),
    }),
    render: ({ args }) => {
      const spec = args?.spec as DashboardSpec | undefined;
      if (!spec || !Array.isArray(spec.widgets) || spec.widgets.length === 0) return <></>;
      if (opts?.renderChipOnly) {
        const surface = opts.surface ?? "studio";
        applyIncoming(spec, surface, {
          runId: args?.runId as string | undefined,
          final: args?.final as boolean | undefined,
        });
        // Only the final reconcile carries trust; a historical DELTA chip re-render
        // must not clobber the surface trust with `[], null` (and notify) every time.
        if (args?.certified !== undefined || args?.audit !== undefined) {
          setSurfaceTrust(
            surface,
            (args?.certified as string[] | undefined) ?? [],
            (args?.audit as DashboardAudit | null | undefined) ?? null,
          );
        }
        return (
          <div style={{ fontSize: 12, color: "var(--frame-text-muted)", border: "1px solid var(--frame-border)", borderRadius: 6, padding: "4px 10px", margin: "4px 0" }}>
            → opened in canvas · {spec.widgets.length} tile{spec.widgets.length === 1 ? "" : "s"}
          </div>
        );
      }
      // F7 — merge this board into the active lineage; the merged board is what we
      // render, and `changedIds` are the tiles the follow-up added/updated.
      const { spec: merged, changedIds } = applyIncoming(spec, opts?.surface, {
        runId: args?.runId as string | undefined,
        final: args?.final as boolean | undefined,
      });
      return (
        <DashboardCanvas
          spec={merged}
          graph={graph}
          faithfulness={(args?.faithfulness as FaithfulnessResult | null | undefined) ?? null}
          certified={(args?.certified as string[] | undefined) ?? []}
          audit={(args?.audit as DashboardAudit | null | undefined) ?? null}
          changedIds={changedIds}
          onFocusNode={opts?.onFocusNode}
          onAsk={opts?.onAsk}
          onSave={opts?.onSave}
        />
      );
    },
  };
}
