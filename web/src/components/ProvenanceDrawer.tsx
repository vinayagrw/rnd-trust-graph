/**
 * Per-node provenance drawer — the ALCOA+ / 21 CFR Part 11 "drill to source"
 * moment. Slides in from the right when a node is clicked.
 *
 * Now also offers an on-demand, GROUNDED AI explanation of the node: streamed
 * from /api/explain-node, constrained to the node's real provenance + 1-hop
 * neighbourhood (+ defect reason). The explanation carries a grounded badge when
 * the LLM stayed on-graph, or a fallback badge (with a reason hint) when it
 * dropped to the deterministic templated explanation. Resets on node change.
 */
import { useEffect, useRef, useState } from "react";
import type { GraphNode, Provenance, FallbackReason, RiskReason, RiskFlag, ChangeSet } from "@rnd/shared";
import { explainNode, api, hitlApi, adminApi } from "../api.js";
import { LiteratureSynthesis } from "./LiteratureSynthesis.js";
import type { AdminConfig } from "../api.js";
import { Button } from "./ui/button.js";

/** Friendly labels for the manual-flag picker (the 7 RiskFlag kinds). */
const FLAG_LABELS: Record<RiskFlag, string> = {
  "missing-provenance": "Missing provenance",
  "conflicting-annotation": "Conflicting annotation",
  "missing-cross-source-link": "Missing cross-source link",
  "stale-ontology-version": "Stale ontology version",
  "duplicate-record": "Duplicate record",
  "missing-followup": "Missing follow-up",
  "dangling-reference": "Dangling reference",
};
const FLAG_OPTIONS = Object.keys(FLAG_LABELS) as RiskFlag[];

interface Props {
  node: GraphNode;
  prov: Provenance | null;
  /** True when a human reviewer verified this node (incident HUMAN_APPROVED edge). */
  verified?: boolean;
  /** The live model id (/api/health) shown on the model card. */
  model?: string;
  /** Notify the app after a governed change (manual flag raised/cleared) so the
   *  radar + canvas refetch and reflect it live. */
  onChanged?: () => void;
  onClose: () => void;
}

/** Changeset references this node when it's the target or any op touches it. */
function changeSetTouchesNode(cs: ChangeSet, nodeId: string): boolean {
  if (cs.targetNodeId === nodeId) return true;
  return cs.forwardOps.some((op) => {
    if ("nodeId" in op && op.nodeId === nodeId) return true;
    if ("source" in op && (op.source === nodeId || op.target === nodeId)) return true;
    return false;
  });
}

/** Plain-English explanation of why a live explanation dropped to the fallback. */
const REASON_HINT: Record<string, string> = {
  disabled: "Live mode is off — set LLM_PROVIDER=claude-code in bff/.env.",
  "spawn-failed": "`claude` CLI not found on PATH.",
  "not-authenticated": "Claude Code isn't logged in — run `claude` once to sign in.",
  "no-tools": "Local tools didn't connect.",
  timeout: "The model took too long and was cut off.",
  "empty-output": "The model returned no usable text.",
  ungrounded: "The explanation referenced something off the node's neighbourhood and was refused.",
  "api-error": "The model call failed.",
};

/** Node kinds that participate in MENTIONS edges, so a literature synthesis is
 *  meaningful (F7). Other kinds (Patient, OmicsProfile, …) hide the affordance. */
const LITSYNTH_KINDS = new Set([
  "Drug",
  "AdverseEvent",
  "BiologicalTarget",
  "LiteratureAbstract",
]);

function Row({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--frame-border)" }}>
      <span style={{ color: "var(--frame-text-muted)", fontSize: 12 }}>{k}</span>
      <span style={{ fontSize: 13, fontWeight: 500, textAlign: "right" }}>{v}</span>
    </div>
  );
}

export function ProvenanceDrawer({ node, prov, verified, model, onChanged, onClose }: Props) {
  const [explanation, setExplanation] = useState("");
  const [citedCount, setCitedCount] = useState(0);
  const [isFallback, setIsFallback] = useState(false);
  const [reason, setReason] = useState<FallbackReason | string | undefined>();
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [riskReasons, setRiskReasons] = useState<RiskReason[]>([]);
  // Manual reviewer flag controls (governed + reversible via /api/hitl/flag).
  const [flagType, setFlagType] = useState<RiskFlag>("missing-provenance");
  const [flagNote, setFlagNote] = useState("");
  const [flagBusy, setFlagBusy] = useState(false);
  // Bumped after a flag/unflag so the risk reasons refetch (radar refreshes too).
  const [riskNonce, setRiskNonce] = useState(0);
  const [reviews, setReviews] = useState<ChangeSet[]>([]);
  const [modelCard, setModelCard] = useState<AdminConfig["modelCard"]>();
  const cancelRef = useRef<null | (() => void)>(null);

  // Esc closes the dossier — consistent with every other overlay, and the
  // keyboard equivalent of the ✕ button. The drawer is NON-modal (no backdrop,
  // the page stays interactive), so we deliberately do NOT trap focus here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // "Reviewed by" — changesets from the governed audit log that touch this node.
  useEffect(() => {
    let live = true;
    hitlApi
      .changesets()
      .then((all) => {
        if (live) setReviews(all.filter((cs) => changeSetTouchesNode(cs, node.id)));
      })
      .catch(() => {
        if (live) setReviews([]);
      });
    return () => {
      live = false;
    };
  }, [node.id]);

  // Model card — static config block, fetched once (config is small + hot-editable).
  useEffect(() => {
    let live = true;
    adminApi
      .get()
      .then((r) => {
        if (live) setModelCard(r.config.modelCard);
      })
      .catch(() => {
        if (live) setModelCard(undefined);
      });
    return () => {
      live = false;
    };
  }, []);

  // Fetch this node's "why was this flagged?" evidence (Item 1) when it changes.
  // Read-only: surfaces the SHACL-grounded reason already served by /api/risk.
  useEffect(() => {
    let live = true;
    api
      .risk()
      .then((report) => {
        if (!live) return;
        const finding = report.findings.find((f) => f.nodeId === node.id);
        setRiskReasons(finding?.reasons ?? []);
      })
      .catch(() => {
        if (live) setRiskReasons([]);
      });
    return () => {
      live = false;
    };
  }, [node.id, riskNonce]);

  // Reset the explanation whenever the selected node changes (and on unmount).
  useEffect(() => {
    cancelRef.current?.();
    setExplanation("");
    setCitedCount(0);
    setIsFallback(false);
    setReason(undefined);
    setBusy(false);
    setStarted(false);
    setFlagNote("");
    setFlagType("missing-provenance");
    return () => cancelRef.current?.();
  }, [node.id]);

  /** Raise a manual reviewer flag on this node (governed + reversible). */
  async function raiseFlag() {
    if (flagBusy) return;
    setFlagBusy(true);
    try {
      await hitlApi.flag({ nodeId: node.id, flag: flagType, reason: flagNote.trim() || undefined });
      setFlagNote("");
      setRiskNonce((n) => n + 1);
      onChanged?.();
    } catch {
      /* never break the drawer on a flag failure */
    } finally {
      setFlagBusy(false);
    }
  }

  /** Clear a manual reviewer flag previously raised on this node. */
  async function removeFlag(flag: RiskFlag) {
    if (flagBusy) return;
    setFlagBusy(true);
    try {
      await hitlApi.flag({ nodeId: node.id, flag, remove: true });
      setRiskNonce((n) => n + 1);
      onChanged?.();
    } catch {
      /* ignore */
    } finally {
      setFlagBusy(false);
    }
  }

  // Manual flags currently on this node (rule stamped by the BFF merge).
  const manualFlags = riskReasons.filter((r) => r.rule === "Manual reviewer flag");

  function explain() {
    cancelRef.current?.();
    setBusy(true);
    setStarted(true);
    setExplanation("");
    setCitedCount(0);
    setIsFallback(false);
    setReason(undefined);
    let acc = "";
    cancelRef.current = explainNode(node.id, (e) => {
      if (e.type === "token") setExplanation((acc += e.text));
      else if (e.type === "citations") setCitedCount(e.nodeIds.length);
      else if (e.type === "done") {
        setIsFallback(e.isFallback);
        setReason(e.reason);
        setBusy(false);
      } else if (e.type === "error") {
        setExplanation("(offline — could not reach the explanation service)");
        setIsFallback(true);
        setBusy(false);
      }
    });
  }

  const grounded = started && !busy && !isFallback;

  return (
    <div
      role="region"
      aria-label={`Provenance for ${node.label}`}
      style={{
        position: "fixed", top: 0, right: 0, bottom: 0, width: 340,
        // Above the GraphCanvas fullscreen overlay (zIndex 1000) so clicking a
        // node while expanded still surfaces its dossier on every page.
        zIndex: 1100,
        background: "var(--frame-surface)", borderLeft: "1px solid var(--frame-border)",
        boxShadow: "-8px 0 24px rgba(10,37,64,.12)",
        display: "flex", flexDirection: "column",
      }}
    >
      {/* Scrollable dossier body — the quick-flag bar below stays pinned.
          minHeight:0 is required so this flex item can shrink below its content
          height; without it overflow never engages and the footer is pushed off-screen. */}
      <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)" }}>
            {node.kind}
          </div>
          <h3 style={{ margin: "4px 0 12px" }}>{node.label}</h3>
        </div>
        <Button variant="control" size="brand" onClick={onClose} aria-label="close">✕</Button>
      </div>

      {/* Trust chips — human-verified (green) and/or flagged (red). */}
      {(verified || riskReasons.length > 0) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {verified && (
            <span
              title="A human reviewer verified this node (a governed HUMAN_APPROVED edge)."
              style={{
                fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
                background: "rgba(43,182,115,.16)", color: "#2bb673",
                border: "1px solid rgba(43,182,115,.5)",
              }}
            >
              ✓ Human-verified
            </span>
          )}
          {riskReasons.length > 0 && (
            <span
              title="The readiness radar flags a data-quality defect on this node."
              style={{
                fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 999,
                background: "rgba(222,74,59,.14)", color: "#de4a3b",
                border: "1px solid rgba(222,74,59,.5)",
              }}
            >
              ⚑ Flagged
            </span>
          )}
        </div>
      )}

      <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 4 }}>
        Provenance (ALCOA+)
      </div>
      {prov ? (
        <>
          <Row k="Source system" v={prov.sourceSystem} />
          <Row k="Code" v={prov.code} />
          <Row k="Ontology version" v={prov.ontologyVersion} />
          <Row k="Rule version" v={prov.ruleVersion} />
          <Row k="Timestamp" v={prov.timestamp} />
          <Row k="License" v={prov.license} />
        </>
      ) : (
        <p style={{ color: "var(--risk-low)", fontSize: 13 }}>
          ⚠ No provenance recorded — flagged by the readiness radar.
        </p>
      )}

      {/* PROV-O view — the SAME provenance, re-expressed in W3C PROV vocabulary
          (entity / activity / agent). A relabel of fields already shown above;
          no new fetch, no new claim. */}
      {prov && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 4 }}>
            Provenance (W3C PROV-O)
          </div>
          <Row k="prov:Entity" v={`${node.kind} · ${node.id}`} />
          <Row k="prov:Activity" v={prov.ruleVersion ? `ETL / ${prov.ruleVersion}` : `ingest from ${prov.sourceSystem}`} />
          <Row k="prov:Agent" v={prov.sourceSystem} />
          <Row k="prov:generatedAtTime" v={prov.timestamp} />
          <Row k="prov:wasDerivedFrom" v={prov.code} />
          <Row k="dcterms:license" v={prov.license} />
        </div>
      )}

      {/* Reviewed by — governed changesets from the audit log that touch this node. */}
      {reviews.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 6 }}>
            Reviewed by
          </div>
          {reviews.map((cs) => (
            <div
              key={cs.id}
              style={{
                marginBottom: 6, padding: 8, borderRadius: 6,
                background: "rgba(43,182,115,.07)", border: "1px solid rgba(43,182,115,.3)",
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                {cs.actor}
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: cs.status === "reverted" ? "var(--frame-text-muted)" : "#2bb673" }}>
                  · {cs.status}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--frame-text-muted)", marginTop: 1 }}>{cs.title}</div>
              <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 10.5, color: "var(--frame-text-muted)", marginTop: 2 }}>
                {cs.ts}
              </div>
            </div>
          ))}
        </div>
      )}

      {riskReasons.length > 0 && (
        <div
          style={{
            marginTop: 14,
            padding: 10,
            borderRadius: 6,
            background: "rgba(248,81,73,.08)",
            border: "1px solid rgba(248,81,73,.4)",
          }}
        >
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 6 }}>
            Why was this flagged?
          </div>
          {riskReasons.map((r) => (
            <div key={r.flag} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{r.reason}</div>
              <div style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11, color: "var(--frame-text-muted)", marginTop: 2 }}>
                {r.rule && <span>rule: {r.rule}</span>}
                {r.rule && r.expected && <span> · </span>}
                {r.expected && <span>{r.expected}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {node.attrs && (
        <>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", margin: "16px 0 4px" }}>
            Attributes
          </div>
          {Object.entries(node.attrs).map(([k, v]) => (
            <Row key={k} k={k} v={String(v)} />
          ))}
        </>
      )}

      {/* --- Flags already on this node: removable chips only. Raising a NEW flag
            lives in the pinned quick-flag bar at the foot of the drawer (single
            entry point — avoids a duplicate dropdown). Each × clears the flag via
            the same governed, reversible changeset. Hidden when there are none. */}
      {manualFlags.length > 0 && (
        <div style={{ marginTop: 18, borderTop: "1px solid var(--frame-border)", paddingTop: 12 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 6 }}>
            Flags on this node
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {manualFlags.map((r) => (
              <span
                key={r.flag}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 6,
                  fontSize: 11, fontWeight: 600, padding: "2px 6px 2px 9px", borderRadius: 999,
                  background: "rgba(222,74,59,.14)", color: "#de4a3b",
                  border: "1px solid rgba(222,74,59,.5)",
                }}
                title={r.reason}
              >
                ⚑ {FLAG_LABELS[r.flag] ?? r.flag}
                <button
                  type="button"
                  disabled={flagBusy}
                  onClick={() => void removeFlag(r.flag)}
                  aria-label={`Remove ${FLAG_LABELS[r.flag] ?? r.flag} flag`}
                  title="Clear this reviewer flag (governed, reversible)"
                  style={{
                    border: "none", background: "transparent", color: "inherit",
                    cursor: flagBusy ? "default" : "pointer", fontSize: 13, lineHeight: 1, padding: 0,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* --- AI explanation: grounded, on-demand, constrained to this node's
            real provenance + 1-hop neighbourhood (+ defect reason). --------- */}
      <div style={{ marginTop: 18, borderTop: "1px solid var(--frame-border)", paddingTop: 12 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 6 }}>
          AI explanation
        </div>
        <Button variant="control" size="brand" onClick={explain} disabled={busy}>
          {busy ? "Explaining…" : "✨ Explain this node"}
        </Button>

        {started && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
              {grounded && citedCount > 0 && (
                <span
                  title="Every entity named is this node or one of its 1-hop neighbours — enforced, not just requested."
                  style={{
                    fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999,
                    background: "rgba(63,185,80,.16)", color: "#56d364",
                    border: "1px solid rgba(63,185,80,.5)",
                  }}
                >
                  ✓ grounded in {citedCount} graph node{citedCount === 1 ? "" : "s"}
                </span>
              )}
              {grounded && citedCount === 0 && (
                <span className="badge-live" style={{ fontSize: 11, padding: "1px 7px", borderRadius: 999 }}>
                  ✓ grounded
                </span>
              )}
              {!busy && isFallback && (
                <span
                  className="badge-fallback"
                  title={reason ? REASON_HINT[reason] ?? String(reason) : undefined}
                  style={{ cursor: reason ? "help" : "default" }}
                >
                  templated fallback{reason ? ` · ${reason}` : ""}
                </span>
              )}
            </div>
            <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>
              {explanation || (busy ? "…" : "")}
            </p>
          </div>
        )}

        {/* F7 — literature synthesis affordance for entities that participate in
            MENTIONS edges (drug / AE / target / the abstract itself). Source-ranked,
            inline-cited, enforced ⊆ the served abstracts; degrades to a template. */}
        {LITSYNTH_KINDS.has(node.kind) && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--frame-border)", paddingTop: 12 }}>
            <LiteratureSynthesis focusNodeId={node.id} />
          </div>
        )}
      </div>

      {/* Model card — who/what produces the AI explanations. Static config
          (admin) + the live model id (/api/health). Describes the system, not
          this node's provenance, so it appears ONLY after the user runs
          "Explain this node" (gated on `started`) — right next to the AI output
          it actually describes, instead of stamped on every node. */}
      {started && (modelCard || model) && (
        <div style={{ marginTop: 18, borderTop: "1px solid var(--frame-border)", paddingTop: 12 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: "var(--frame-text-muted)", marginBottom: 4 }}>
            Model card
          </div>
          <Row k="Model (live)" v={model || modelCard?.name} />
          <Row k="Name" v={modelCard?.name} />
          <Row k="Version" v={modelCard?.version} />
          <Row k="Provider" v={modelCard?.provider} />
          <Row k="Intended use" v={modelCard?.intendedUse} />
          <Row k="Evaluation" v={modelCard?.evaluation} />
          <Row k="Limitations" v={modelCard?.limitations} />
          <Row k="Training cutoff" v={modelCard?.trainingCutoff} />
        </div>
      )}
      </div>{/* end scrollable dossier body */}

      {/* Pinned quick-flag bar — the single entry point for raising a reviewer
          flag, always visible regardless of scroll so flagging never requires
          hunting to the bottom of the dossier. Governed + reversible: applied
          immediately as a changeset, surfaced on the radar + HITL audit log. */}
      <div
        style={{
          flex: "0 0 auto", borderTop: "1px solid var(--frame-border)",
          background: "var(--frame-surface)", padding: "10px 14px",
          display: "flex", flexDirection: "column", gap: 6,
        }}
      >
        <input
          type="text"
          value={flagNote}
          onChange={(e) => setFlagNote(e.target.value)}
          disabled={flagBusy}
          placeholder="Optional note (why you're flagging it)…"
          aria-label="Flag note"
          style={{
            width: "100%", boxSizing: "border-box", fontSize: 12.5,
            padding: "6px 8px", borderRadius: 6, border: "1px solid var(--frame-border)",
            background: "var(--frame-surface)", color: "var(--frame-text)",
          }}
        />
        <select
          value={flagType}
          onChange={(e) => setFlagType(e.target.value as RiskFlag)}
          disabled={flagBusy}
          aria-label="Flag type"
          style={{
            width: "100%", boxSizing: "border-box", fontSize: 12.5, padding: "6px 7px", borderRadius: 6,
            border: "1px solid var(--frame-border)", background: "var(--frame-surface)",
            color: "var(--frame-text)",
          }}
        >
          {FLAG_OPTIONS.map((f) => (
            <option key={f} value={f}>{FLAG_LABELS[f]}</option>
          ))}
        </select>
        {/* Full-width, high-contrast amber fill (the ⚑ flag colour) so the primary
            action is unmistakable — the faint `control` style on the dark drawer
            surface was effectively invisible. */}
        <Button
          variant="control"
          size="brand"
          onClick={() => void raiseFlag()}
          disabled={flagBusy}
          style={{
            width: "100%", background: "#e0a93b", borderColor: "#e0a93b",
            color: "#1b1300", fontWeight: 700,
          }}
        >
          {flagBusy ? "Flagging…" : "⚑ Flag this node"}
        </Button>
        <div style={{ fontSize: 10.5, color: "var(--frame-text-muted)" }}>
          Governed &amp; reversible — recorded in the HITL audit log; clear it here or Revert it there.
        </div>
      </div>
    </div>
  );
}
