/**
 * @rnd/web — BoardLayout: the composed-board grid for the Generative Studio
 * (Task 10). Replaces the Studio's old flat `auto-fill` grid of VegaTiles.
 *
 * It walks the run-gated board's tiles and renders each BY ITS HOST-OWNED ROLE
 * (`assignLayout` on the BFF sets role/span, never the model):
 *   - `role:"kpi"` → a `KpiCard` (single host-computed number),
 *   - everything else → the locked-down `VegaTile` chart.
 *
 * Layout is a host-owned 12-COLUMN grid, and each archetype maps to its OWN width
 * pattern (`tileWidth`) so the six archetypes render as genuinely DIFFERENT
 * structures — a small-multiples wall of thirds, a bento magazine of big+small,
 * a master-detail hero-plus-narrows, a KPI strip over half-width charts — rather
 * than collapsing into one 2-column look. Widths are a host decision (12 divides by
 * 2/3/4/6); the model never contributes a span or a column. Handlers
 * (select/explain/refine/restore) thread straight through to the chart tiles.
 */
import type { GenerativeDatasets, GenerativeTile, LayoutArchetype } from "@rnd/shared";
import { VegaTile } from "./VegaTile.js";
import { KpiCard } from "./KpiCard.js";
import { GaugeCard } from "./GaugeCard.js";
import { SparkKpiCard } from "./SparkKpiCard.js";

/** The grid is 12 columns; every tile occupies a whole-number slice of it. */
const GRID_COLS = 12;

/**
 * How many of the 12 columns a tile spans, by archetype + its position among the
 * CHART tiles (KPI cards are excluded from `chartPos` and handled first). Pure and
 * host-owned — this is the whole source of per-archetype structural variety.
 */
export function tileWidth(archetype: LayoutArchetype | null, isKpi: boolean, chartPos: number): number {
  if (isKpi) return archetype === "kpi-grid" ? 3 : 4; // a dense KPI strip (4 or 3 across)
  switch (archetype) {
    case "hero-rail":
      return chartPos === 0 ? 12 : 6; // full-width hero, then a rail of halves
    case "master-detail":
      return chartPos === 0 ? 8 : 4; // a dominant chart beside stacked narrows
    case "bento":
      return chartPos % 3 === 0 ? 8 : 4; // magazine rhythm: wide, narrow, narrow
    case "small-multiples":
      return 4; // a wall of equal thirds
    case "kpi-grid":
    case "analytic-grid":
    default:
      return 6; // uniform halves
  }
}

export function BoardLayout(props: {
  tiles: GenerativeTile[];
  datasets: GenerativeDatasets;
  /** Host-owned archetype hint (currently informational — the grid honours each
   *  tile's span regardless, exactly as DashboardCanvas does). */
  archetype: LayoutArchetype | null;
  onSelect: (ids: string[] | null) => void;
  onExplain?: (tile: GenerativeTile) => void;
  onRefine?: (tile: GenerativeTile, instruction: string) => void;
  onRestore?: (tile: GenerativeTile) => void;
  /** How many prior versions tile `id` has to restore (drives VegaTile's ↩ button). */
  restorableFor?: (id: string) => number;
  /** The tile id with a refine round in flight (one at a time). */
  refiningId?: string | null;
}): JSX.Element {
  const { tiles, datasets, onSelect, onExplain, onRefine, onRestore, restorableFor, refiningId } = props;

  return (
    <div
      data-testid="generative-board-layout"
      data-archetype={props.archetype ?? undefined}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
        gap: 14,
        alignItems: "start",
      }}
    >
      {(() => {
        let chartPos = 0;
        return tiles.map((tile) => {
        // KPI-family cards (kpi/gauge/spark) are single-metric, host-computed, and sit
        // in the dense strip — they don't advance the chart position, so the width
        // pattern below reads purely as the sequence of CHART tiles.
        const isKpi = tile.role === "kpi" || tile.role === "gauge" || tile.role === "spark";
        const width = tileWidth(props.archetype, isKpi, isKpi ? 0 : chartPos++);
        return (
          <div key={tile.id} data-tile-width={width} style={{ gridColumn: `span ${width}`, minWidth: 0 }}>
            {tile.role === "gauge" ? (
              <GaugeCard tile={tile} datasets={datasets} />
            ) : tile.role === "spark" ? (
              <SparkKpiCard tile={tile} datasets={datasets} />
            ) : tile.role === "kpi" ? (
              <KpiCard tile={tile} datasets={datasets} />
            ) : (
              <VegaTile
                tile={tile}
                datasets={datasets}
                onSelect={onSelect}
                onExplain={onExplain}
                onRefine={onRefine}
                onRestore={onRestore}
                restorable={restorableFor?.(tile.id) ?? 0}
                refining={refiningId === tile.id}
              />
            )}
          </div>
        );
        });
      })()}
    </div>
  );
}
