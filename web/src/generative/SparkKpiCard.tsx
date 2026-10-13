/**
 * @rnd/web — SparkKpiCard: a KpiCard-family tile that shows ONE host-computed metric
 * as a headline number PLUS an inline SVG sparkline of that metric's series across the
 * bound rows.
 *
 * TRUST INVARIANT (identical to KpiCard): the model NEVER supplies a number, a point,
 * a colour, or path data. It only names a `kpi` descriptor ({aggregate, field?, label});
 * this component COMPUTES the headline value host-side via the shared `computeKpi`, and
 * builds the sparkline from the ACTUAL `datasets[tile.dataset]` rows via the pure
 * `sparkPoints`. The tidy-long `metrics` dataset has one row per node×metric, so the
 * series is that field's value across those bound rows — recomputed the instant a
 * cross-filter narrows them. No external libs — inline SVG.
 */
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { computeKpi } from "./KpiCard.js";

/** Canonical sparkline viewBox. Host-fixed — the model contributes nothing here. */
export const SPARK_WIDTH = 100;
export const SPARK_HEIGHT = 28;
export const SPARK_PAD = 2;

export interface SparkPoint {
  x: number;
  y: number;
}

export interface SparkOpts {
  width?: number;
  height?: number;
  pad?: number;
}

/**
 * PURE: extract the numeric series of `field` across `rows` (in row order) and map it
 * to normalised sparkline points. x is evenly spaced across the width; y maps the value
 * linearly so the MAX sits at the top and the MIN at the bottom. A flat series (all
 * equal) is drawn on the mid-line; a single point is centred; a series with no numbers
 * yields []. Tested WITHOUT rendering React.
 */
export function sparkPoints(
  rows: ReadonlyArray<Record<string, unknown>>,
  field: string | undefined,
  opts: SparkOpts = {},
): SparkPoint[] {
  const width = opts.width ?? SPARK_WIDTH;
  const height = opts.height ?? SPARK_HEIGHT;
  const pad = opts.pad ?? SPARK_PAD;
  if (!field) return [];

  const nums: number[] = [];
  for (const row of rows) {
    const v = row[field];
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
  }
  if (nums.length === 0) return [];

  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  const n = nums.length;

  return nums.map((v, i) => {
    const x = n === 1 ? width / 2 : pad + (innerW * i) / (n - 1);
    const t = span === 0 ? 0.5 : (v - min) / span; // 0 = min, 1 = max
    const y = pad + innerH * (1 - t); // max → top
    return { x, y };
  });
}

function formatValue(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}

export function SparkKpiCard({ tile, datasets }: { tile: GenerativeTile; datasets: GenerativeDatasets }): JSX.Element {
  const rows = datasets[tile.dataset] ?? [];
  const kpi = tile.kpi;
  const value = kpi ? computeKpi(rows, kpi.aggregate, kpi.field) : null;
  const points = sparkPoints(rows, kpi?.field);
  const display = value === null || !kpi ? "—" : formatValue(value);
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <div
      data-testid="generative-spark-card"
      style={{
        borderRadius: 8,
        border: "1px solid var(--frame-border)",
        background: "var(--frame-surface)",
        padding: "10px 12px",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      {/* Title row — mirrors KpiCard/VegaTile's muted uppercase caption. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 16 }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--frame-text-muted)" }}>
          {tile.title}
        </span>
      </div>

      {/* The big host-computed number. */}
      <div
        style={{
          fontSize: 30,
          fontWeight: 700,
          lineHeight: 1.1,
          color: "var(--frame-text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {display}
      </div>

      {/* The host-drawn sparkline of the metric's series across the bound rows. */}
      {points.length >= 2 && (
        <svg
          data-testid="generative-spark-line"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          width="100%"
          height={SPARK_HEIGHT}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${tile.title} trend`}
        >
          <polyline
            points={polyline}
            fill="none"
            stroke="var(--frame-accent, #6aa9ff)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}

      {/* The KPI's own label (from the descriptor, never a data value). */}
      {kpi && <div style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>{kpi.label}</div>}

      {/* Provenance strip — VegaTile-style: how many bound rows the series folds over. */}
      <div
        data-testid="generative-spark-provenance"
        style={{
          marginTop: 4,
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--frame-text-muted)",
          borderTop: "1px dashed var(--frame-border)",
          paddingTop: 4,
        }}
      >
        {rows.length} {tile.dataset} row{rows.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}
