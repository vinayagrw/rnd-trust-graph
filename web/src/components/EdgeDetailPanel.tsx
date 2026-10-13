/**
 * Per-edge detail panel — the relationship counterpart to ProvenanceDrawer.
 * Slides in from the right when an edge is clicked, showing what the relationship
 * IS (human-friendly type), its provenance, and letting a reviewer attach or
 * remove free-text TAGS.
 *
 * Tags are a governed, fully-reversible HITL overlay (POST /api/hitl/edge-tag):
 * overlay-only, no Neo4j mutation, stamped with reviewer + purpose, and listed in
 * the audit log — the exact mirror of the node manual-flag flow.
 */
import { useEffect, useState } from "react";
import type { GraphEdge, Provenance } from "@rnd/shared";
import { hitlApi } from "../api.js";
import { Button } from "./ui/button.js";

interface Props {
  edge: GraphEdge;
  /** Resolve a node id to its display label (endpoints read nicely). Optional. */
  nodeLabel?: (id: string) => string;
  /** Notify the app after a governed change (tag added/removed) so the canvas
   *  refetches and the edge re-renders with the new tag. */
  onChanged?: () => void;
  onClose: () => void;
}

export function EdgeDetailPanel({ edge, nodeLabel, onChanged, onClose }: Props) {
  // Local, optimistic tag list seeded from the edge; reset when the edge changes.
  const [tags, setTags] = useState<string[]>(edge.tags ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTags(edge.tags ?? []);
    setInput("");
  }, [edge.id, edge.tags]);

  const srcLabel = nodeLabel?.(edge.source) ?? edge.source;
  const tgtLabel = nodeLabel?.(edge.target) ?? edge.target;
  const type = edge.label ?? edge.kind;
  const prov: Partial<Provenance> = edge.provenance ?? {};
  const provRows: Array<[string, string]> = [
    ["Source system", prov.sourceSystem ?? ""],
    ["License", prov.license ?? ""],
    ["Timestamp", prov.timestamp ?? ""],
    ["Rule version", prov.ruleVersion ?? ""],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  /** Attach a reviewer tag to this edge (governed + reversible). */
  async function addTag() {
    const tag = input.trim();
    if (!tag || busy || tags.includes(tag)) return;
    setBusy(true);
    try {
      await hitlApi.edgeTag({ source: edge.source, target: edge.target, kind: edge.kind, tag });
      setTags((t) => [...t, tag]);
      setInput("");
      onChanged?.();
    } catch {
      /* never break the panel on a tag failure */
    } finally {
      setBusy(false);
    }
  }

  /** Remove a reviewer tag previously attached to this edge (revert). */
  async function removeTag(tag: string) {
    if (busy) return;
    setBusy(true);
    try {
      await hitlApi.edgeTag({
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        tag,
        remove: true,
      });
      setTags((t) => t.filter((g) => g !== tag));
      onChanged?.();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="region"
      aria-label={`Relationship ${type} from ${srcLabel} to ${tgtLabel}`}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: 340,
        // Above the GraphCanvas fullscreen overlay (zIndex 1000), matching the
        // node ProvenanceDrawer so an edge click surfaces on every page.
        zIndex: 1100,
        background: "var(--frame-surface)",
        borderLeft: "1px solid var(--frame-border)",
        boxShadow: "-8px 0 24px rgba(10,37,64,.12)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
          <div>
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                color: "var(--frame-text-muted)",
                letterSpacing: 0.4,
              }}
            >
              Relationship
            </div>
            <h3 style={{ margin: "4px 0 4px" }}>{type}</h3>
          </div>
          <Button variant="control" size="brand" onClick={onClose} aria-label="close">
            ✕
          </Button>
        </div>

        {/* Endpoints: source → target */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13,
            margin: "8px 0 16px",
            color: "var(--frame-text)",
          }}
        >
          <span style={{ fontWeight: 600 }}>{srcLabel}</span>
          <span style={{ color: "var(--frame-text-muted)" }}>—{edge.kind}→</span>
          <span style={{ fontWeight: 600 }}>{tgtLabel}</span>
        </div>

        {/* Provenance */}
        {provRows.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: "uppercase",
                color: "var(--frame-text-muted)",
                marginBottom: 6,
              }}
            >
              Provenance
            </div>
            <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px" }}>
              {provRows.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt style={{ fontSize: 12, color: "var(--frame-text-muted)" }}>{k}</dt>
                  <dd style={{ fontSize: 12, margin: 0, color: "var(--frame-text)" }}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Reviewer tags */}
        <div>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              color: "var(--frame-text-muted)",
              marginBottom: 6,
            }}
          >
            Reviewer tags
          </div>
          {tags.length > 0 ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {tags.map((g) => (
                <span
                  key={g}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    padding: "3px 8px",
                    borderRadius: 999,
                    background: "var(--frame-accent-soft, rgba(37,99,235,.12))",
                    color: "var(--frame-accent, #2563eb)",
                  }}
                >
                  #{g}
                  <button
                    onClick={() => removeTag(g)}
                    disabled={busy}
                    aria-label={`remove tag ${g}`}
                    style={{
                      border: "none",
                      background: "transparent",
                      cursor: busy ? "default" : "pointer",
                      color: "inherit",
                      fontSize: 13,
                      lineHeight: 1,
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--frame-text-muted)", marginBottom: 10 }}>
              No tags yet — add one to annotate this relationship.
            </div>
          )}
        </div>
      </div>

      {/* Pinned add-tag bar (mirror of the node quick-flag footer). */}
      <div
        style={{
          borderTop: "1px solid var(--frame-border)",
          padding: 16,
          display: "flex",
          gap: 8,
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTag();
          }}
          placeholder="Add a tag…"
          maxLength={60}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            fontSize: 13,
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--frame-border)",
            background: "var(--frame-bg, #fff)",
            color: "var(--frame-text)",
          }}
        />
        <Button variant="control" size="brand" onClick={addTag} disabled={busy || !input.trim()}>
          Tag
        </Button>
      </div>
    </div>
  );
}
