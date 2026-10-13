/**
 * Header context bar — a slim breadcrumb that answers "where am I and what's in
 * focus?". Shows the app › current beat, the node whose dossier is open (if any),
 * and how many nodes are in the chat context. Purely presentational; every value
 * is passed in from App state. The "open command palette" hint doubles as a
 * discoverability nudge for ⌘K.
 */
import type { GraphNode } from "@rnd/shared";

export function ContextBar({
  beatLabel,
  selectedNode,
  contextCount,
  onClearContext,
  onOpenPalette,
}: {
  beatLabel: string;
  selectedNode?: GraphNode | null;
  contextCount: number;
  onClearContext?: () => void;
  onOpenPalette?: () => void;
}) {
  const sep = (
    <span aria-hidden style={{ color: "var(--frame-text-muted)", opacity: 0.6 }}>
      ›
    </span>
  );
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 16px",
        borderBottom: "1px solid var(--frame-border)",
        fontSize: 12,
        color: "var(--frame-text-muted)",
        minHeight: 30,
        boxSizing: "border-box",
      }}
    >
      <span style={{ fontWeight: 600, color: "var(--frame-text)" }}>R&amp;D Trust Graph</span>
      {sep}
      <span style={{ color: "var(--frame-text)" }}>{beatLabel}</span>
      {selectedNode && (
        <>
          {sep}
          <span
            title={`${selectedNode.kind} · ${selectedNode.id}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: "var(--frame-text)",
              maxWidth: 280,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: "#58a6ff", flex: "0 0 auto" }} />
            {selectedNode.label}
          </span>
        </>
      )}

      <span style={{ flex: 1 }} />

      {contextCount > 0 && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 999,
            border: "1px solid var(--frame-border)",
            background: "rgba(45,212,191,.12)",
            color: "var(--frame-text)",
          }}
        >
          {contextCount} node{contextCount === 1 ? "" : "s"} in chat context
          {onClearContext && (
            <button
              type="button"
              onClick={onClearContext}
              aria-label="Clear chat context"
              title="Clear chat context"
              style={{
                border: "none",
                background: "transparent",
                color: "var(--frame-text-muted)",
                cursor: "pointer",
                fontSize: 13,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          )}
        </span>
      )}

      {onOpenPalette && (
        <button
          type="button"
          onClick={onOpenPalette}
          title="Open the command palette"
          aria-label="Open the command palette"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "2px 8px",
            borderRadius: 6,
            border: "1px solid var(--frame-border)",
            background: "transparent",
            color: "var(--frame-text-muted)",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          <span>Search</span>
          <kbd style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>⌘K</kbd>
        </button>
      )}
    </div>
  );
}
