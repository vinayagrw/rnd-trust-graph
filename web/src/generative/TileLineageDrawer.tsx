/**
 * @rnd/web — "Explain this tile" drawer for the Generative Studio (Phase 4).
 *
 * Provenance-first: every number a tile draws came from a row the SERVER bound
 * from an already-cited graph node, so the honest way to explain a chart is to
 * show those rows. This drawer surfaces, in order:
 *   1. the model's own `rationale` (prose — why this chart shape), clearly marked
 *      as model-authored so it is never mistaken for evidence;
 *   2. the server-derived lineage: dataset, row count, the fields actually
 *      encoded, and the cited node ids the dataset was bound from;
 *   3. the audit table — the EXACT bound rows the chart drew, so a reviewer can
 *      read the underlying values without leaving the tile.
 *
 * Read-only. No graph write, no new answer path, no model call.
 */
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";

/** Cap the audit table — a cited set is small, but never let a drawer render an
 *  unbounded table. */
const MAX_AUDIT_ROWS = 50;

interface Props {
  tile: GenerativeTile;
  /** The datasets AS RENDERED (already cross-filtered) — the drawer must show the
   *  rows the chart actually drew, not the unfiltered bag. */
  datasets: GenerativeDatasets;
  onClose: () => void;
}

const cellStyle: React.CSSProperties = {
  padding: "3px 8px",
  borderBottom: "1px solid var(--frame-border)",
  whiteSpace: "nowrap",
  textAlign: "left",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--frame-text-muted)",
          marginBottom: 5,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

export function TileLineageDrawer({ tile, datasets, onClose }: Props) {
  const rows = datasets[tile.dataset] ?? [];
  const shown = rows.slice(0, MAX_AUDIT_ROWS);
  const columns = shown.length > 0 ? Object.keys(shown[0]) : [];
  const prov = tile.provenance;

  return (
    <aside
      role="dialog"
      aria-label={`Lineage for ${tile.title}`}
      data-testid="tile-lineage-drawer"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(520px, 92vw)",
        zIndex: 1100,
        overflowY: "auto",
        padding: 16,
        background: "var(--frame-surface)",
        color: "var(--frame-text)",
        borderLeft: "1px solid var(--frame-border)",
        boxShadow: "-12px 0 32px rgba(0,0,0,.35)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 14 }}>
        <strong style={{ fontSize: 13 }}>{tile.title}</strong>
        <button
          type="button"
          onClick={onClose}
          style={{
            marginLeft: "auto",
            fontSize: 11,
            padding: "2px 8px",
            borderRadius: 6,
            border: "1px solid var(--frame-border)",
            background: "transparent",
            color: "var(--frame-text)",
            cursor: "pointer",
          }}
        >
          ✕ Close
        </button>
      </div>

      <Section title="Why this chart (model rationale)">
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          {tile.rationale ?? <span style={{ color: "var(--frame-text-muted)" }}>No rationale given.</span>}
        </div>
        {typeof tile.appropriateness === "number" && (
          <div style={{ fontSize: 11, color: "var(--frame-text-muted)", marginTop: 4 }}>
            Passed the server's deterministic design-rule critic at{" "}
            {(tile.appropriateness * 100).toFixed(0)}% appropriateness. The critic is a gate, not a
            ranking: it rejects a chart whose mark does not fit its data (a line over categories, a
            20-slice pie, a bare count) before the tile is ever emitted. No model was involved in
            the score.
          </div>
        )}
      </Section>

      <Section title="Lineage (server-derived)">
        <div style={{ fontSize: 12, lineHeight: 1.7 }}>
          <div>
            Dataset: <code>{tile.dataset}</code> · {rows.length} row{rows.length === 1 ? "" : "s"} as drawn
          </div>
          <div>Fields charted: {prov?.fields.length ? prov.fields.join(", ") : "—"}</div>
          <div>
            Grounded in {prov?.nodeIds.length ?? 0} cited node{(prov?.nodeIds.length ?? 0) === 1 ? "" : "s"}
          </div>
        </div>
        {prov && prov.nodeIds.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
            {prov.nodeIds.map((id) => (
              <span
                key={id}
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 999,
                  border: "1px solid var(--frame-border)",
                  color: "var(--frame-text-muted)",
                }}
              >
                {id}
              </span>
            ))}
          </div>
        )}
      </Section>

      <Section title={`Underlying rows (${shown.length} of ${rows.length})`}>
        {shown.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--frame-text-muted)" }}>No rows bound.</div>
        ) : (
          <div style={{ overflowX: "auto", border: "1px solid var(--frame-border)", borderRadius: 6 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c} style={{ ...cellStyle, color: "var(--frame-text-muted)", fontWeight: 600 }}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, i) => (
                  <tr key={i}>
                    {columns.map((c) => (
                      <td key={c} style={cellStyle}>
                        {row[c] === null || row[c] === undefined ? "—" : String(row[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div style={{ fontSize: 11, color: "var(--frame-text-muted)", lineHeight: 1.6 }}>
        Every value above was bound by the server from nodes already cited in this conversation. The
        model chose only the chart's shape — it never emitted a data value.
      </div>
    </aside>
  );
}
