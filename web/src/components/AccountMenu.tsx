/**
 * Account / reviewer menu — the avatar in the header. The demo has no auth, so
 * this is an HONEST placeholder: it names the reviewer identity that governed HITL
 * actions are attributed to ("demo session"), and surfaces the REAL runtime facts
 * the app already knows — the live model id and live/scripted mode from
 * /api/health. It deliberately does not imply a logged-in user the build can't
 * back up. Click-outside / Esc closes.
 */
import { useEffect, useRef, useState } from "react";

const REVIEWER = { name: "Reviewer", role: "Pharmacovigilance reviewer", initials: "RV" };

export function AccountMenu({
  health,
}: {
  health?: { ok: boolean; liveMode: boolean; model: string };
}) {
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
        onClick={() => setOpen((v) => !v)}
        title={`${REVIEWER.name} · ${REVIEWER.role}`}
        aria-label="Account menu"
        aria-expanded={open}
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          border: "1px solid var(--frame-border)",
          background: "linear-gradient(135deg,#2dd4bf,#3b82f6)",
          color: "#fff",
          fontSize: 11,
          fontWeight: 800,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          letterSpacing: 0.3,
        }}
      >
        {REVIEWER.initials}
      </button>

      {open && (
        <div
          role="group"
          aria-label="Account details"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 268,
            zIndex: 1200,
            background: "var(--frame-surface)",
            color: "var(--frame-text)",
            border: "1px solid var(--frame-border)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,.35)",
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "12px 14px" }}>
            <span
              aria-hidden
              style={{
                width: 34,
                height: 34,
                borderRadius: "50%",
                background: "linear-gradient(135deg,#2dd4bf,#3b82f6)",
                color: "#fff",
                fontSize: 12,
                fontWeight: 800,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 auto",
              }}
            >
              {REVIEWER.initials}
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{REVIEWER.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--frame-text-muted)" }}>{REVIEWER.role}</div>
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--frame-border)", padding: "10px 14px" }}>
            <Row label="Session">demo (no sign-in)</Row>
            <Row label="Mode">
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: health?.liveMode ? "#3fb950" : "#8b949e",
                    display: "inline-block",
                  }}
                />
                {health?.liveMode ? "live" : "scripted"}
              </span>
            </Row>
            <Row label="Model">{health?.model || "—"}</Row>
          </div>

          <div
            style={{
              borderTop: "1px solid var(--frame-border)",
              padding: "8px 14px",
              fontSize: 11,
              color: "var(--frame-text-muted)",
              lineHeight: 1.4,
            }}
          >
            Governed HITL actions are attributed to this reviewer in the audit log.
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "3px 0",
        fontSize: 12.5,
      }}
    >
      <span style={{ color: "var(--frame-text-muted)" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis" }}>
        {children}
      </span>
    </div>
  );
}
