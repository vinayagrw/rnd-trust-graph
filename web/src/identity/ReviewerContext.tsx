/**
 * F6 — Reviewer identity + purpose. A small React context that holds WHO is
 * reviewing (name + role) and the stated PURPOSE of their review, persisted to
 * localStorage and pushed into the api layer (`setReviewerContext`) so every
 * governed HITL write (apply / flag) is stamped with who/why in the audit trail.
 *
 * This is DISCLOSURE/affordance only — it labels and records intent. It does NOT
 * gate the read-only agent path or weaken grounding; the structural trust
 * guarantees live in the BFF, untouched by anything here.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { RISK_POLICY } from "@rnd/shared";
import { api, setReviewerContext } from "../api.js";

export interface Purpose {
  id: string;
  label: string;
  description: string;
}

interface ReviewerState {
  name: string;
  role: string;
  purposeId: string;
  roles: string[];
  purposes: Purpose[];
  setName: (v: string) => void;
  setRole: (v: string) => void;
  setPurposeId: (v: string) => void;
  /** The current purpose's label (for the disclosure banner), or "" if none. */
  purposeLabel: string;
}

/** Distinct reviewer roles, derived from the risk-owner vocabulary + a generic
 *  fallback so the selector always offers a sensible default. */
const ROLES: string[] = (() => {
  const owners = Object.values(RISK_POLICY).map((p) => p.owner);
  return [...new Set([...owners, "Reviewer"])];
})();

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode / quota) */
  }
}

const Ctx = createContext<ReviewerState | null>(null);

export function ReviewerProvider({ children }: { children: React.ReactNode }) {
  const [name, setName] = useState(() => readStored("rtg.reviewer.name", "A. Reviewer"));
  const [role, setRole] = useState(() => readStored("rtg.reviewer.role", ROLES[0]));
  const [purposeId, setPurposeId] = useState(() => readStored("rtg.reviewer.purpose", ""));
  const [purposes, setPurposes] = useState<Purpose[]>([]);

  // Load the purpose vocabulary from the public config (single source of truth).
  useEffect(() => {
    let alive = true;
    api
      .publicConfig()
      .then((c) => {
        if (!alive) return;
        const ps = c.purposes ?? [];
        setPurposes(ps);
        // Default to the first purpose when none was stored.
        setPurposeId((cur) => cur || (ps[0]?.id ?? ""));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Persist + push into the api layer so HITL writes carry the identity.
  useEffect(() => writeStored("rtg.reviewer.name", name), [name]);
  useEffect(() => writeStored("rtg.reviewer.role", role), [role]);
  useEffect(() => writeStored("rtg.reviewer.purpose", purposeId), [purposeId]);
  useEffect(() => {
    setReviewerContext({
      reviewer: name.trim() ? { name: name.trim(), role } : undefined,
      purpose: purposeId || undefined,
    });
  }, [name, role, purposeId]);

  const purposeLabel = purposes.find((p) => p.id === purposeId)?.label ?? "";

  const value = useMemo<ReviewerState>(
    () => ({ name, role, purposeId, roles: ROLES, purposes, setName, setRole, setPurposeId, purposeLabel }),
    [name, role, purposeId, purposes, purposeLabel],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReviewer(): ReviewerState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReviewer must be used within a ReviewerProvider");
  return v;
}
