/**
 * @rnd/web — KpiCard: the single-number tile for the Generative Studio board
 * (Task 9). A `role:"kpi"` tile renders here instead of through the vega-embed
 * `VegaTile`.
 *
 * TRUST INVARIANT: the number is NEVER carried in the tile — the model only ever
 * names a `kpi` descriptor ({aggregate, field?, label}); this component COMPUTES
 * the value host-side from `datasets[tile.dataset]` (the same server-bound, and
 * possibly cross-filtered, rows every other tile reads). So a KPI can only ever
 * report a fact already grounded in this conversation, and it re-renders to a
 * lower/higher number the instant a cross-filter narrows the rows — it is a pure
 * function of props, so no effect is needed (and it renders correctly under SSR).
 *
 * The card chrome deliberately mirrors `VegaTile`'s: the same muted uppercase
 * title row and the same dashed-top provenance strip naming the bound rows, so a
 * KPI card and a chart tile read as one board.
 */
import type { GenerativeDatasets, GenerativeTile, KpiAggregate } from "@rnd/shared";

/** Compute the KPI value host-side from the bound rows. `count` ignores the field;
 *  every other aggregate folds over the NUMERIC values of `row[field]`, skipping
 *  null / non-number cells. Returns `null` when there is nothing to show (no kpi,
 *  a non-count aggregate with no field, or an aggregate over zero numbers) so the
 *  card can fall back to an honest em-dash rather than "NaN"/"0". */
export function computeKpi(
  rows: ReadonlyArray<Record<string, unknown>>,
  aggregate: KpiAggregate,
  field?: string,
): number | null {
  if (aggregate === "count") return rows.length;
  if (!field) return null;

  const nums: number[] = [];
  for (const row of rows) {
    const v = row[field];
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
  }
  if (nums.length === 0) return null;

  switch (aggregate) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "mean":
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return Math.min(...nums);
    case "max":
      return Math.max(...nums);
  }
}

/** Locale thousands separators; a mean keeps ≤1 decimal, others show a decimal
 *  only when the value isn't whole (so an integer count/sum stays clean). */
function formatKpi(value: number, aggregate: KpiAggregate): string {
  const maximumFractionDigits = aggregate === "mean" ? 1 : Number.isInteger(value) ? 0 : 1;
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

export function KpiCard({ tile, datasets }: { tile: GenerativeTile; datasets: GenerativeDatasets }): JSX.Element {
  const rows = datasets[tile.dataset] ?? [];
  const kpi = tile.kpi;
  const value = kpi ? computeKpi(rows, kpi.aggregate, kpi.field) : null;
  const display = value === null || !kpi ? "—" : formatKpi(value, kpi.aggregate);

  return (
    <div
      data-testid="generative-kpi-card"
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
      {/* Title row — mirrors VegaTile's muted uppercase caption. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 16 }}>
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--frame-text-muted)",
          }}
        >
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

      {/* The KPI's own label (from the descriptor, never a data value). */}
      {kpi && (
        <div style={{ fontSize: 11, color: "var(--frame-text-muted)" }}>{kpi.label}</div>
      )}

      {/* Provenance strip — VegaTile-style: how many bound rows the number folds over. */}
      <div
        data-testid="generative-kpi-provenance"
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
