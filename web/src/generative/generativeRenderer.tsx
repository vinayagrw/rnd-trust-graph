/**
 * @rnd/generative — the `render_generative` tool-call renderer.
 *
 * Registered in CopilotChatBeat's `renderToolCalls` array (Task 10). Unlike
 * `dashboardRenderer` (which can render either a full inline board OR a
 * chip-only pointer into the "studio" lineage), `render_generative` is
 * ALWAYS chip-only: the actual board lives in the run-gated `generativeStore`
 * (Task 8), and the Generative Studio canvas (Task 11) subscribes to that
 * store directly. This renderer's only job is to feed the store and leave a
 * small "opened in canvas" marker in the transcript.
 *
 * Payload shapes emitted by the bridge (`bff/src/ask/aguiBridge.ts`, T7/T9):
 *  - delta:  { tile, datasets, fieldMenu, runId }              (one tile)
 *  - final:  { board, datasets, fieldMenu, runId, final: true } (whole board)
 *
 * `generativeArgsSchema` is exported standalone (mirroring `VegaTile.tsx`'s
 * `LOCKED_EMBED_OPTIONS`/`denyAllLoader`/`prepareSpec` pattern) so the
 * regression test can import and exercise it without touching the JSX render
 * path or a DOM.
 */
import { z } from "zod";
import type { ReactToolCallRenderer } from "@copilotkit/react-core/v2";
import type { FieldMenuEntry, GenerativeBoard, GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { applyTile, applyBoardMeta } from "./generativeStore.js";

const EMPTY_DATASETS: GenerativeDatasets = { cited: [], metrics: [], edges: [] };

/** Loose by design — the BFF is the validator (tileIRSchema/board schema, T2/T3).
 *  `runId`/`final` MUST be declared: Zod v3 `z.object` strips undeclared keys
 *  (this bit the dashboard lane once — see `dashboardRenderer.tsx`). */
export const generativeArgsSchema = z.object({
  tile: z.any().optional(),
  board: z.any().optional(),
  datasets: z.any().optional(),
  fieldMenu: z.any().optional(),
  runId: z.string().optional(),
  final: z.boolean().optional(),
});

export function generativeRenderer(): ReactToolCallRenderer<{
  tile?: GenerativeTile;
  board?: GenerativeBoard;
  datasets?: GenerativeDatasets;
  fieldMenu?: FieldMenuEntry[];
  runId?: string;
  final?: boolean;
}> {
  return {
    name: "render_generative",
    args: generativeArgsSchema,
    render: ({ args }) => {
      const tile = args?.tile as GenerativeTile | undefined;
      const board = args?.board as GenerativeBoard | undefined;
      const datasets = (args?.datasets as GenerativeDatasets | undefined) ?? EMPTY_DATASETS;
      const fieldMenu = (args?.fieldMenu as FieldMenuEntry[] | undefined) ?? [];
      const meta = {
        runId: args?.runId as string | undefined,
        final: args?.final as boolean | undefined,
      };

      let count = 0;
      if (board && Array.isArray(board.tiles) && board.tiles.length > 0) {
        // Final reconcile — replay every tile in the board through the same
        // gated `applyTile` the streaming deltas used, carrying the same meta
        // (the store's own run gate/sig-cache handles idempotence).
        for (const t of board.tiles) applyTile(t, datasets, fieldMenu, meta);
        // Board mode (`?compose=board`) carries HOST-owned layout + derived filters
        // + the board score on the final reconcile. Land them once (undefined for the
        // single-pass lane, which leaves the store's meta null — a flat grid).
        applyBoardMeta({
          layout: board.layout,
          filters: board.filters,
          boardScore: board.boardScore,
          boardRationale: board.boardRationale,
        });
        count = board.tiles.length;
      } else if (tile) {
        applyTile(tile, datasets, fieldMenu, meta);
        count = 1;
      } else {
        return <></>;
      }

      return (
        <div
          style={{
            fontSize: 12,
            color: "var(--frame-text-muted)",
            border: "1px solid var(--frame-border)",
            borderRadius: 6,
            padding: "4px 10px",
            margin: "4px 0",
          }}
        >
          → opened in canvas · {count} tile{count === 1 ? "" : "s"}
        </div>
      );
    },
  };
}
