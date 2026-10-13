/**
 * Filters rail for the live graph lens. Restricts which nodes the canvas shows —
 * by kind, readiness band, human-verified, or flagged. It only ever HIDES nodes
 * the BFF already sent (see web/src/lib/filterGraph.ts), so grounding is intact;
 * cited/active nodes are kept regardless via applyFilters' `keep` guard.
 *
 * Self-contained, presenter-trusted UI — no query to the BFF, no LLM.
 */
import { useMemo } from "react";
import type { GraphPayload } from "@rnd/shared";
import { nodeColor } from "@rnd/shared";
import type { GraphFilters, ReadinessBand } from "../lib/filterGraph.js";
import { isNoopFilter, EMPTY_FILTERS } from "../lib/filterGraph.js";

const BANDS: { key: ReadinessBand; label: string }[] = [
  { key: "all", label: "All" },
  { key: "high", label: "High" },
  { key: "mid", label: "Mid" },
  { key: "low", label: "Low" },
];

interface Props {
  graph: GraphPayload;
  filters: GraphFilters;
  onChange: (f: GraphFilters) => void;
  /** Optional readout: how many nodes are visible after filtering. */
  visibleCount?: number;
}

export function FiltersRail({ graph, filters, onChange, visibleCount }: Props) {
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
    // (no-op) set so the Clear affordance and isNoopFilter stay correct.
    onChange({ ...filters, kinds: next.size === kinds.length ? new Set() : next });
  };

  const dirty = !isNoopFilter(filters);

  return (
    <div
      data-testid="filters-rail"
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
            onClick={() => onChange({ ...EMPTY_FILTERS, kinds: new Set() })}
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

      {/* Readiness band segmented control. */}
      <div>
        <div style={subLabel}>Readiness</div>
        <div style={{ display: "flex", gap: 4 }}>
          {BANDS.map((b) => {
            const on = filters.readinessBand === b.key;
            return (
              <button
                key={b.key}
                type="button"
                onClick={() => onChange({ ...filters, readinessBand: b.key })}
                aria-pressed={on}
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  padding: "4px 0",
                  borderRadius: 6,
                  cursor: "pointer",
                  border: "1px solid var(--frame-border)",
                  background: on ? "rgba(88,166,255,.16)" : "transparent",
                  color: "var(--frame-text)",
                  fontWeight: on ? 600 : 400,
                }}
              >
                {b.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Trust toggles. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <label style={toggleRow}>
          <input
            type="checkbox"
            checked={filters.verifiedOnly}
            onChange={(e) => onChange({ ...filters, verifiedOnly: e.target.checked })}
          />
          <span aria-hidden style={{ color: "#2bb673", fontWeight: 700 }}>✓</span>
          Human-verified only
        </label>
        <label style={toggleRow}>
          <input
            type="checkbox"
            checked={filters.flaggedOnly}
            onChange={(e) => onChange({ ...filters, flaggedOnly: e.target.checked })}
          />
          <span aria-hidden style={{ color: "#de4a3b", fontWeight: 700 }}>⚑</span>
          Flagged only
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
