/**
 * Help / keyboard-shortcuts overlay. A reference card the presenter can pop with
 * the header "?" button or the "?" key: the shortcuts, and the on-canvas trust
 * legend (so the green/amber/halo stamps are never a mystery). Read-only — it
 * documents the UI, it doesn't change any state. Esc or backdrop-click closes.
 */
import { useEffect, useRef } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.js";

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "⌘K / Ctrl+K", what: "Open the command palette (jump to a beat, action, or node)" },
  { keys: "?", what: "Open this help" },
  { keys: "Esc", what: "Close a dialog / exit canvas full screen" },
  { keys: "Click a node", what: "Open its provenance dossier and add it to the chat context" },
  { keys: "⤢ (canvas)", what: "Expand the graph canvas to full screen" },
  { keys: "Search box", what: "Find and highlight a node on the canvas by name" },
];

const LEGEND: { dot: React.ReactNode; what: string }[] = [
  { dot: <Stamp color="#2bb673" glyph="✓" />, what: "Human-verified (a governed HUMAN_APPROVED edge)" },
  { dot: <Stamp color="#e0a93b" glyph="!" dark />, what: "Flagged by a data-quality (SHACL) rule or a reviewer" },
  { dot: <Halo />, what: "Low confidence — readiness below the band (dashed red halo)" },
  { dot: <Ring />, what: "Readiness — ring colour + thickness (thicker = lower)" },
];

function Stamp({ color, glyph, dark }: { color: string; glyph: string; dark?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        borderRadius: "50%",
        background: color,
        color: dark ? "#1b1300" : "#fff",
        fontSize: 10,
        fontWeight: 800,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
      }}
    >
      {glyph}
    </span>
  );
}
function Halo() {
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        borderRadius: "50%",
        border: "2px dashed #de4a3b",
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}
function Ring() {
  return (
    <span
      aria-hidden
      style={{
        width: 16,
        height: 16,
        borderRadius: "50%",
        border: "3px solid #e0a93b",
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  // Esc closes — the legend below (and the file docstring) promise it, and every
  // other dialog in the app honours it. Bound globally so it works regardless of
  // where focus sits when the overlay is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1300,
        background: "rgba(0,0,0,.45)",
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-start",
        paddingTop: "10vh",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Help and keyboard shortcuts"
        style={{
          width: "min(560px, 92vw)",
          maxHeight: "78vh",
          overflowY: "auto",
          background: "var(--frame-surface)",
          color: "var(--frame-text)",
          border: "1px solid var(--frame-border)",
          borderRadius: 12,
          boxShadow: "0 24px 64px rgba(0,0,0,.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: "1px solid var(--frame-border)",
          }}
        >
          <strong style={{ fontSize: 15 }}>Help &amp; shortcuts</strong>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            style={{
              border: "none",
              background: "transparent",
              color: "var(--frame-text-muted)",
              fontSize: 18,
              lineHeight: 1,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: "14px 16px" }}>
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--frame-text-muted)",
              marginBottom: 8,
            }}
          >
            Keyboard &amp; interactions
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 14px" }}>
            {SHORTCUTS.map((s) => (
              <div key={s.keys} style={{ display: "contents" }}>
                <kbd
                  style={{
                    fontSize: 11,
                    fontFamily: "ui-monospace, monospace",
                    padding: "2px 7px",
                    borderRadius: 6,
                    border: "1px solid var(--frame-border)",
                    background: "rgba(127,127,127,.10)",
                    whiteSpace: "nowrap",
                    alignSelf: "start",
                  }}
                >
                  {s.keys}
                </kbd>
                <span style={{ fontSize: 13 }}>{s.what}</span>
              </div>
            ))}
          </div>

          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--frame-text-muted)",
              margin: "18px 0 8px",
            }}
          >
            On-canvas trust legend
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {LEGEND.map((l, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {l.dot}
                <span style={{ fontSize: 13 }}>{l.what}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
