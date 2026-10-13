/**
 * Tools / View overflow menu — collapses the header's long wall of control buttons
 * (Quality, Competitive, Playbooks, Story, Mode, Motion, Canvas, Skin, Density,
 * Export, HITL, Admin, Help) into ONE "⚙ Tools" popover, grouped into "View"
 * (state toggles) and "Panels & tools" (actions). This is purely a navigation /
 * information-architecture change — every item runs the exact same handler it did
 * as a top-level button; nothing about behaviour, grounding, or state changes.
 *
 * Popover mechanics (click-outside + Esc, themed surface) mirror AccountMenu so the
 * two header menus read as one consistent control.
 */
import { useEffect, useRef, useState } from "react";

export interface ToolItem {
  /** Menu label. For a toggle, include the live value (e.g. "Motion: on"). */
  label: string;
  /** Native title / tooltip — the same copy the old button carried. */
  title?: string;
  /** A toggle shows an on/off state chip; an action just runs. */
  kind: "toggle" | "action";
  /** For toggles: current on/off (drives the state chip + aria-pressed). */
  on?: boolean;
  onClick: () => void;
  /** Optional leading glyph. */
  icon?: string;
}

export interface ToolSection {
  heading: string;
  items: ToolItem[];
}

export function ToolsMenu({ sections }: { sections: ToolSection[] }) {
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
    <div ref={wrapRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        data-testid="tools-menu-button"
        onClick={() => setOpen((v) => !v)}
        title="Tools, panels & view options"
        aria-label="Tools menu"
        aria-expanded={open}
        aria-haspopup="menu"
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
        <span>Tools</span>
        <span aria-hidden style={{ fontSize: 10, opacity: 0.7 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          role="menu"
          data-testid="tools-menu-panel"
          aria-label="Tools, panels and view options"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 296,
            zIndex: 1200,
            background: "var(--frame-surface)",
            color: "var(--frame-text)",
            border: "1px solid var(--frame-border)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,.35)",
            overflow: "hidden",
            padding: "6px 0",
          }}
        >
          {sections.map((section, si) => (
            <div
              key={section.heading}
              style={si > 0 ? { borderTop: "1px solid var(--frame-border)", marginTop: 4, paddingTop: 4 } : undefined}
            >
              <div
                style={{
                  padding: "6px 14px 4px",
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  color: "var(--frame-text-muted)",
                }}
              >
                {section.heading}
              </div>
              {section.items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  title={item.title}
                  aria-pressed={item.kind === "toggle" ? !!item.on : undefined}
                  onClick={() => {
                    item.onClick();
                    // Actions open a panel/download → close the menu. Toggles stay
                    // open so the presenter can flip several view options in a row.
                    if (item.kind === "action") setOpen(false);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    width: "100%",
                    padding: "7px 14px",
                    border: "none",
                    background: "transparent",
                    color: "var(--frame-text)",
                    fontSize: 12.5,
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(88,166,255,.12)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                    {item.icon && <span aria-hidden style={{ flex: "0 0 auto", opacity: 0.85 }}>{item.icon}</span>}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
                  </span>
                  {item.kind === "toggle" && (
                    <span
                      aria-hidden
                      style={{
                        flex: "0 0 auto",
                        fontSize: 10.5,
                        fontWeight: 700,
                        padding: "1px 7px",
                        borderRadius: 999,
                        border: "1px solid var(--frame-border)",
                        color: item.on ? "#04111f" : "var(--frame-text-muted)",
                        background: item.on ? "#2dd4bf" : "transparent",
                      }}
                    >
                      {item.on ? "on" : "off"}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
