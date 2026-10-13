/**
 * F6 — header reviewer/purpose selector. A compact control showing the active
 * reviewer + purpose; clicking opens a small popover to change name, role, and the
 * stated purpose. Whatever is selected here is stamped on every governed HITL write
 * (audit who/why). Purpose is a labelled disclosure, NOT an access gate.
 */
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { useReviewer } from "./ReviewerContext.js";

export function ReviewerSelector() {
  const r = useReviewer();
  const [open, setOpen] = useState(false);

  return (
    <span style={{ position: "relative" }}>
      <Button
        variant="control"
        size="brand"
        onClick={() => setOpen((v) => !v)}
        title="Reviewer identity + purpose — stamped on every governed change (audit only, not an access gate)"
      >
        ⊙ {r.name || "Reviewer"}
        {r.purposeLabel ? ` · ${r.purposeLabel}` : ""}
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Reviewer identity and purpose"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 6px)",
            zIndex: 1200,
            width: 280,
            background: "var(--frame-surface)",
            border: "1px solid var(--frame-border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(10,37,64,.18)",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            textAlign: "left",
          }}
        >
          <label style={lbl}>
            Reviewer name
            <input
              type="text"
              value={r.name}
              onChange={(e) => r.setName(e.target.value)}
              style={input}
              aria-label="Reviewer name"
            />
          </label>

          <label style={lbl}>
            Role
            <select value={r.role} onChange={(e) => r.setRole(e.target.value)} style={input}>
              {r.roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <label style={lbl}>
            Purpose of review
            <select
              value={r.purposeId}
              onChange={(e) => r.setPurposeId(e.target.value)}
              style={input}
            >
              {r.purposes.length === 0 && <option value="">(none configured)</option>}
              {r.purposes.map((p) => (
                <option key={p.id} value={p.id} title={p.description}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <p style={{ margin: 0, fontSize: 10.5, color: "var(--frame-muted)", lineHeight: 1.4 }}>
            Stamped on every governed change for the audit trail. Disclosure only — it
            does not restrict what the read-only agent may answer.
          </p>

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="control" size="brand" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </span>
  );
}

const lbl: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  color: "var(--frame-text-muted)",
};

const input: React.CSSProperties = {
  fontSize: 12.5,
  padding: "5px 7px",
  borderRadius: 6,
  border: "1px solid var(--frame-border)",
  background: "var(--frame-surface)",
  color: "var(--frame-text)",
};
