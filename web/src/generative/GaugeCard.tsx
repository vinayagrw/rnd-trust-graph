/**
 * @rnd/web — GaugeCard: a KpiCard-family tile that draws ONE host-computed metric on
 * a radial arc (a dial) against a host-derived domain.
 *
 * TRUST INVARIANT (identical to KpiCard): the model NEVER supplies the number, the
 * range, a colour, or any path data. It only ever names a `kpi` descriptor
 * ({aggregate, field?, label, domain?}); this component COMPUTES the value host-side
 * from `datasets[tile.dataset]` (the same server-bound, possibly cross-filtered rows
 * every tile reads) via the shared `computeKpi`, and reads the arc's domain from the
 * HOST-DERIVED `kpi.domain` (`deriveKpi` set it from the bound metric's real min/max).
 * The arc geometry is a PURE function of (value, domain) — `gaugeGeometry` — so the
 * dial re-renders to a new needle position the instant a cross-filter narrows the rows.
 *
 * The chrome mirrors KpiCard/VegaTile (muted uppercase title, dashed provenance strip)
 * so a gauge, a KPI card and a chart read as one board. No external libs — inline SVG.
 */
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import { computeKpi } from "./KpiCard.js";

/** Canonical gauge geometry: a top semicircle. cx/cy/r place the arc; the value maps
 *  to a fraction of the sweep from the left end (fraction 0) over the top to the right
 *  end (fraction 1). All host-fixed — the model contributes nothing here. */
export const GAUGE_CX = 60;
export const GAUGE_CY = 60;
export const GAUGE_R = 50;

export interface GaugeGeometry {
  /** value clamped into the domain and normalised to 0..1. */
  fraction: number;
  /** the needle/value-arc end angle in degrees (180 at fraction 0 → 0 at fraction 1). */
  angleDeg: number;
  /** cartesian end point of the value arc at the canonical cx/cy/r (SVG coords). */
  point: { x: number; y: number };
}

/** Polar → cartesian for the canonical gauge, using SVG's y-down convention. `angleDeg`
 *  is standard-math (0 = +x/right, 90 = up, 180 = -x/left); the top semicircle uses
 *  0..180, so y is always ≤ cy. */
export function gaugePoint(angleDeg: number, cx = GAUGE_CX, cy = GAUGE_CY, r = GAUGE_R): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

/**
 * PURE gauge geometry from a value + [min,max] domain. Clamps out-of-range values,
 * guards a degenerate/absent domain (fraction 0), and returns the sweep fraction, the
 * value-arc end angle, and its cartesian point. Tested WITHOUT rendering React.
 */
export function gaugeGeometry(value: number | null, domain?: [number, number]): GaugeGeometry {
  let fraction = 0;
  // A gauge is only meaningful against a host-derived domain — with none, draw an empty
  // dial (fraction 0) rather than inventing a range. `deriveKpi` always sets a domain
  // for a value-bearing gauge, so this is the honest no-data / no-range fallback.
  if (domain && value !== null && Number.isFinite(value) && domain[1] > domain[0]) {
    fraction = (value - domain[0]) / (domain[1] - domain[0]);
    if (fraction < 0) fraction = 0;
    else if (fraction > 1) fraction = 1;
  }
  const angleDeg = 180 - 180 * fraction; // fraction 0 → 180° (left), 1 → 0° (right)
  return { fraction, angleDeg, point: gaugePoint(angleDeg) };
}

/** Arc `d` from the LEFT end of the gauge to `point` (≤180° → largeArc 0; clockwise
 *  over the top → sweep 1). */
function arcPath(point: { x: number; y: number }): string {
  const start = gaugePoint(180); // (cx - r, cy)
  return `M ${start.x} ${start.y} A ${GAUGE_R} ${GAUGE_R} 0 0 1 ${point.x} ${point.y}`;
}

function formatValue(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}

export function GaugeCard({ tile, datasets }: { tile: GenerativeTile; datasets: GenerativeDatasets }): JSX.Element {
  const rows = datasets[tile.dataset] ?? [];
  const kpi = tile.kpi;
  const value = kpi ? computeKpi(rows, kpi.aggregate, kpi.field) : null;
  const geo = gaugeGeometry(value, kpi?.domain);
  const trackEnd = gaugePoint(0); // right end (fraction 1) — the full-sweep track
  const display = value === null || !kpi ? "—" : formatValue(value);
  const domainLabel = kpi?.domain ? `${formatValue(kpi.domain[0])}–${formatValue(kpi.domain[1])}` : null;

  return (
    <div
      data-testid="generative-gauge-card"
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

      {/* The host-drawn dial. viewBox is the top semicircle plus a little headroom for the label. */}
      <div style={{ display: "flex", justifyContent: "center" }}>
        <svg data-testid="generative-gauge-arc" viewBox="0 4 120 74" width="100%" style={{ maxWidth: 160 }} role="img" aria-label={`${tile.title}: ${display}`}>
          {/* Background track — the full sweep. */}
          <path
            d={arcPath(trackEnd)}
            fill="none"
            stroke="var(--frame-border)"
            strokeWidth={8}
            strokeLinecap="round"
          />
          {/* Value arc — from the left end to the host-computed fraction. */}
          {value !== null && (
            <path
              data-testid="generative-gauge-value-arc"
              d={arcPath(geo.point)}
              fill="none"
              stroke="var(--frame-accent, #6aa9ff)"
              strokeWidth={8}
              strokeLinecap="round"
            />
          )}
          {/* Needle tip marker. */}
          {value !== null && <circle cx={geo.point.x} cy={geo.point.y} r={4} fill="var(--frame-text)" />}
          {/* The big host-computed number, centred under the dial. */}
          <text x={GAUGE_CX} y={GAUGE_CY - 6} textAnchor="middle" style={{ fontSize: 20, fontWeight: 700, fill: "var(--frame-text)" }}>
            {display}
          </text>
        </svg>
      </div>

      {/* The KPI's own label + the host-derived domain (never a data value from the model). */}
      {kpi && (
        <div style={{ fontSize: 11, color: "var(--frame-text-muted)", textAlign: "center" }}>
          {kpi.label}
          {domainLabel && <span> · range {domainLabel}</span>}
        </div>
      )}

      {/* Provenance strip — VegaTile-style: how many bound rows the number folds over. */}
      <div
        data-testid="generative-gauge-provenance"
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
