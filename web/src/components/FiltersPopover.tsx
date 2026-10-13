/**
 * FiltersPopover: collapses an always-open `<FiltersRail>` column behind a small
 * "⚙ Filters" button. Purely a navigation / information-architecture change —
 * the wrapped `FiltersRail` runs the exact same handlers/state it did as a
 * top-level column; nothing about filtering behaviour changes.
 *
 * Popover mechanics (click-outside + Esc, themed surface) mirror `ToolsMenu.tsx`.
 * Defaults CLOSED.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function FiltersPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
      <button
        type="button"
        data-testid="filters-popover-button"
        onClick={() => setOpen((v) => !v)}
        title="Filters"
        aria-label="Filters"
        aria-expanded={open}
        aria-haspopup="dialog"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 30,
          padding: "0 12px",
          borderRadius: 8,
          border: "1px solid var(--frame-border)",
          background: open ? "rgba(88,166,255,.16)" : "var(--frame-surface)",
          color: "var(--frame-text)",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <span aria-hidden>&#x2699;</span>
        <span>Filters</span>
        <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          role="dialog"
          data-testid="filters-popover-panel"
          aria-label="Filters"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            width: 220,
            zIndex: 1200,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
