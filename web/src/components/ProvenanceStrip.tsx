/**
 * Always-on provenance strip — closes the regulatory persona's #1 ask: "show me
 * where this came from WITHOUT making me click." Unlike ProvenanceDrawer (click
 * for full detail), this is a persistent one-line strip driven by the ACTIVE hop
 * in the hero beat, so source/ontology/license are visible as the presenter steps.
 *
 * Provenance comes from node.provenance when present (the graph already attaches
 * it), else it's fetched lazily via api.provenance(id). Fetches are guarded — a
 * failure or missing field shows "—", never throws (the strip must never break
 * the hero).
 */
import { useEffect, useState } from "react";
import type { GraphNode, Provenance } from "@rnd/shared";
import { api } from "../api.js";

interface Props {
  node?: GraphNode; // the active-hop node; undefined before the first hop
}

const DASH = "—";

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "baseline", whiteSpace: "nowrap" }}>
      <span
        style={{
          fontSize: 9.5,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--canvas-text-muted, #9aa4b2)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>{value || DASH}</span>
    </span>
  );
}

export function ProvenanceStrip({ node }: Props) {
  const [prov, setProv] = useState<Provenance | null>(null);

  useEffect(() => {
    if (!node) {
      setProv(null);
      return;
    }
    // Prefer provenance already on the node (no round-trip); else fetch lazily.
    if (node.provenance) {
      setProv(node.provenance);
      return;
    }
    let cancelled = false;
    setProv(null);
    // Guard the fetch — the strip degrades to "—" rather than throwing.
    api
      .provenance(node.id)
      .then((p) => !cancelled && setProv(p))
      .catch(() => !cancelled && setProv(null));
    return () => {
      cancelled = true;
    };
  }, [node]);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap", // one line, wraps gracefully on narrow widths
        alignItems: "center",
        gap: "4px 14px",
        padding: "6px 10px",
        marginBottom: 8,
        borderRadius: 8,
        background: "var(--canvas-surface, rgba(255,255,255,.03))",
        border: "1px solid var(--canvas-border, rgba(255,255,255,.08))",
        color: "var(--canvas-text, #e6edf3)",
      }}
    >
      <span
        title="Live provenance for the active hop — no click needed (ALCOA+ / 21 CFR Part 11)."
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.4,
          color: "var(--canvas-text-muted, #9aa4b2)",
        }}
      >
        Provenance
      </span>
      <Field label="Source" value={prov?.sourceSystem} />
      <Field label="Ontology" value={prov?.ontologyVersion} />
      <Field label="Code" value={prov?.code} />
      <Field label="Timestamp" value={prov?.timestamp} />
      <Field label="License" value={prov?.license} />
    </div>
  );
}
