/**
 * Filters rail for the UC4 patient-safety subgraph. The safety-native sibling of
 * FiltersRail: it restricts which safety nodes the canvas shows — by kind, SHACL
 * severity (P0/P1/P2), risk type, or unsafe/flagged. It only ever HIDES nodes the
 * BFF already sent (see web/src/lib/filterSafetyGraph.ts), so grounding is intact;
 * the open finding's evidence path is kept regardless via applySafetyFilters' `keep`.
 *
 * Self-contained, presenter-trusted UI — no query to the BFF, no LLM.
 */
import { useMemo } from "react";
import type { GraphPayload, RiskSeverity, SafetyRiskType } from "@rnd/shared";
import { nodeColor, SAFETY_POLICY } from "@rnd/shared";
import type { SafetyGraphFilters } from "../lib/filterSafetyGraph.js";
import { isNoopSafetyFilter, EMPTY_SAFETY_FILTERS } from "../lib/filterSafetyGraph.js";

const SEVERITIES: { key: "all" | RiskSeverity; label: string }[] = [
  { key: "all", label: "All" },
  { key: "P0", label: "P0" },
  { key: "P1", label: "P1" },
  { key: "P2", label: "P2" },
];

const SEVERITY_TONE: Record<RiskSeverity, string> = {
  P0: "#f85149",
  P1: "#e0a93b",
  P2: "#58a6ff",
};

interface Props {
  graph: GraphPayload;
  filters: SafetyGraphFilters;
  onChange: (f: SafetyGraphFilters) => void;
  /** Risk types actually present in the current findings (drives the dropdown). */
  presentRiskTypes: SafetyRiskType[];
  /** Optional readout: how many nodes are visible after filtering. */
  visibleCount?: number;
}

export function SafetyFiltersRail({
  graph,
  filters,
  onChange,
  presentRiskTypes,
  visibleCount,
}: Props) {
  // Available kinds, derived from the live payload (stable, sorted).
  const kinds = useMemo(
    () => Array.from(new Set(graph.nodes.map((n) => String(n.kind)))).sort(),
    [graph.nodes],
  );

  const toggleKind = (k: string) => {
    // Idle state (empty set) renders every kind as checked = "all shown". Unchecking
    // one from that state means "all except k", so materialise the full set first.
    if (filters.kinds.size === 0) {
      onChange({ ...filters, kinds: new Set(kinds.filter((x) => x !== k)) });
      return;
    }
    const next = new Set(filters.kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    // Re-checking every kind == no kind restriction — collapse back to the empty
    // (no-op) set so the Clear affordance and isNoopSafetyFilter stay correct.
    onChange({ ...filters, kinds: next.size === kinds.length ? new Set() : next });
  };

  const dirty = !isNoopSafetyFilter(filters);

  return (
    <div
      data-testid="safety-filters-rail"
      style={{
        background: "var(--frame-surface)",
        color: "var(--frame-text)",
        border: "1px solid var(--frame-border)",
        borderRadius: "var(--radius)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={labelStyle}>Filters</span>
        {dirty && (
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_SAFETY_FILTERS, kinds: new Set() })}
            title="Clear all filters"
            style={clearBtn}
          >
            Clear
          </button>
        )}
      </div>

      {/* Kind checkboxes with colour swatches (matches the app Legend idiom). */}
      <div>
        <div style={subLabel}>Node kind</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 200, overflowY: "auto" }}>
          {kinds.map((k) => {
            const on = filters.kinds.size === 0 || filters.kinds.has(k);
            return (
              <label
                key={k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  cursor: "pointer",
                  opacity: on ? 1 : 0.5,
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleKind(k)}
                  aria-label={`Filter to ${k}`}
                />
                <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: nodeColor(k), flex: "0 0 auto" }} />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{k}</span>
              </label>
            );
          })}
        </div>
      </div>

      {/* SHACL severity band — the safety analog of the FAIR readiness band. */}
      <div>
        <div style={subLabel}>Severity</div>
        <div style={{ display: "flex", gap: 4 }}>
          {SEVERITIES.map((s) => {
            const on = filters.severity === s.key;
            const tone = s.key === "all" ? undefined : SEVERITY_TONE[s.key];
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onChange({ ...filters, severity: s.key })}
                aria-pressed={on}
                title={s.key === "all" ? "All severities" : `Show only ${s.key} findings`}
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  padding: "4px 0",
                  borderRadius: 6,
                  cursor: "pointer",
                  border: "1px solid var(--frame-border)",
                  background: on ? "rgba(88,166,255,.16)" : "transparent",
                  color: tone && on ? tone : "var(--frame-text)",
                  fontWeight: on ? 700 : 400,
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Risk type — grounded in the findings actually present. */}
      {presentRiskTypes.length > 0 && (
        <div>
          <div style={subLabel}>Risk type</div>
          <select
            value={filters.riskType}
            onChange={(e) =>
              onChange({ ...filters, riskType: e.target.value as SafetyGraphFilters["riskType"] })
            }
            aria-label="Filter by risk type"
            style={{
              width: "100%",
              fontSize: 12,
              padding: "5px 6px",
              borderRadius: 6,
              border: "1px solid var(--frame-border)",
              background: "var(--frame-surface)",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            <option value="all">All risk types</option>
            {presentRiskTypes.map((rt) => (
              <option key={rt} value={rt}>
                {SAFETY_POLICY[rt].label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Unsafe-only toggle. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <label style={toggleRow}>
          <input
            type="checkbox"
            checked={filters.flaggedOnly}
            onChange={(e) => onChange({ ...filters, flaggedOnly: e.target.checked })}
          />
          <span aria-hidden style={{ color: "#de4a3b", fontWeight: 700 }}>⚑</span>
          Unsafe subjects only
        </label>
      </div>

      {typeof visibleCount === "number" && (
        <div style={{ fontSize: 11, color: "var(--frame-text-muted)", borderTop: "1px dashed var(--frame-border)", paddingTop: 6 }}>
          {visibleCount} node{visibleCount === 1 ? "" : "s"} shown
          {dirty ? " (filtered)" : ""}
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "var(--frame-text-muted)",
};
const subLabel: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--frame-text-muted)",
  marginBottom: 5,
};
const toggleRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  cursor: "pointer",
};
const clearBtn: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid var(--frame-border)",
  background: "transparent",
  color: "var(--frame-text-muted)",
  cursor: "pointer",
};
