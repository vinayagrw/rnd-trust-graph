/**
 * Beat 1 — Data-Readiness / FAIR Integrity Radar. Colours the graph by ALCOA+/
 * FAIR completeness and lists the findings. The door-opener: "which of your
 * ~900 pilots have data trustworthy enough to scale?"
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  GraphPayload,
  RiskReport,
  GatedConclusion,
  GraphNode,
  GraphEdge,
  RiskFlag,
  RiskFinding,
} from "@rnd/shared";
import { readinessColor, RISK_POLICY } from "@rnd/shared";
import { api } from "../api.js";
import { log } from "../lib/log.js";
import { GraphCanvas } from "../components/GraphCanvas.js";
import { FiltersRail } from "../components/FiltersRail.js";
import { FiltersPopover } from "../components/FiltersPopover.js";
import { verifiedNodeIds, lowConfidenceIds } from "../lib/trust.js";
import { applyFilters, EMPTY_FILTERS, type GraphFilters } from "../lib/filterGraph.js";

/**
 * Decision-support shapes — a structural mirror of the BFF's
 * `GatedConclusionWithTrace` / `InferenceTrace` (bff/src/reasoner/service.ts).
 * The /api/gated endpoint ALREADY serves this `trace` on every conclusion; the
 * web client previously typed the response loosely as GatedConclusion[] and
 * dropped it. These additive types let the review panel surface the
 * server-side deterministic derivation WITHOUT any BFF or grounding change.
 */
interface InferenceStep {
  premise: string;
  note: string;
}
interface InferenceTrace {
  rule: string;
  steps: InferenceStep[];
  conclusion?: string;
}
type GatedConclusionWithTrace = GatedConclusion & { trace?: InferenceTrace };

/** PROTOTYPE-ONLY local decision states. Non-persistent, demo-scoped: these
 *  buttons record a reviewer's intent in React state and an in-memory audit
 *  log — they NEVER mutate the graph, the reasoner, or any server state. */
type ReviewDecision = "pending" | "accepted" | "rejected" | "escalated";

const FLAG_LABEL: Record<RiskFlag, string> = {
  "missing-cross-source-link": "Missing cross-source link",
  "dangling-reference": "Dangling reference",
  "conflicting-annotation": "Conflicting annotation",
  "missing-provenance": "Missing provenance",
  "stale-ontology-version": "Stale ontology version",
  "duplicate-record": "Duplicate record",
  "missing-followup": "Referral without follow-up",
};

/** Severity badge colour per band (P0 = block, P1 = soon, P2 = hygiene). */
const SEVERITY_TONE: Record<string, string> = {
  P0: "var(--risk-low, #f85149)",
  P1: "var(--risk-mid, #e0a93b)",
  P2: "var(--risk-high, #3fb950)",
};

export function RadarBeat({
  onNodeClick,
  onEdgeClick,
  lightCanvas,
  refreshKey,
  onOpenHitl,
}: {
  onNodeClick: (n: GraphNode) => void;
  onEdgeClick?: (e: GraphEdge) => void;
  lightCanvas?: boolean;
  /** Bumped by App after a governed HITL apply/revert so the radar refetches. */
  refreshKey?: number;
  /** Open the real HITL mutate+revert panel (the local gate below never mutates). */
  onOpenHitl?: () => void;
}) {
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] });
  const [report, setReport] = useState<RiskReport>();
  const [gated, setGated] = useState<GatedConclusionWithTrace[]>([]);

  // Refetch on mount AND whenever refreshKey changes (after a HITL mutation), so
  // a resolved flag / added edge shows up on the radar + canvas live.
  useEffect(() => {
    api.graph("all").then(setGraph).catch((e) => log.error("graph(all) load failed:", e));
    api.risk().then(setReport).catch((e) => log.error("risk() load failed:", e));
    // The /api/gated payload carries `trace` already; widen the type locally.
    api.gated().then((g) => setGated(g as GatedConclusionWithTrace[])).catch((e) => log.error("gated() load failed:", e));
  }, [refreshKey]);

  const readiness = useMemo(
    () => new Map(report?.findings.map((f) => [f.nodeId, f.readiness]) ?? []),
    [report],
  );
  const flagged = report?.findings.filter((f) => f.flags.length > 0) ?? [];

  // Trust lens + filters (derived purely from served payloads).
  const [filters, setFilters] = useState<GraphFilters>(() => ({ ...EMPTY_FILTERS, kinds: new Set() }));
  const verified = useMemo(() => {
    const s = verifiedNodeIds(graph);
    for (const id of report?.humanReviewed ?? []) s.add(id);
    return s;
  }, [graph, report]);
  const lowConfidence = useMemo(() => lowConfidenceIds(readiness), [readiness]);
  const flaggedSet = useMemo(
    () => new Set((report?.findings ?? []).filter((f) => f.flags.length > 0).map((f) => f.nodeId)),
    [report],
  );
  const shown = useMemo(
    () => applyFilters(graph, filters, readiness, verified, flaggedSet),
    [graph, filters, readiness, verified, flaggedSet],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <FiltersPopover>
          <FiltersRail graph={graph} filters={filters} onChange={setFilters} visibleCount={shown.nodes.length} />
        </FiltersPopover>
        <div style={{ flex: 1, minWidth: 0 }}>
          <GraphCanvas
            graph={shown}
            readiness={readiness}
            verified={verified}
            lowConfidence={lowConfidence}
            flagged={flaggedSet}
            searchable
            lightCanvas={lightCanvas}
            filtersSlot={<FiltersRail graph={graph} filters={filters} onChange={setFilters} visibleCount={shown.nodes.length} />}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            height={500}
          />
        </div>
      </div>
      <div style={{ padding: "10px 12px", color: "var(--canvas-text)", fontSize: 13 }}>
        <strong>FAIR / ALCOA+ readiness: {report?.overall ?? "…"} / 100</strong>
        {report?.shacl && (
          <span style={{ marginLeft: 12, opacity: 0.8 }}>
            SHACL cameo: {report.shacl.conforms ? "conforms ✓" : `${flagged.length} nodes flagged ✕`} ({report.shacl.reportPath})
          </span>
        )}
        <div style={{ marginTop: 6, opacity: 0.85 }}>{flagged.length} nodes flagged</div>
        <FlaggedList flagged={flagged} onNodeClick={onNodeClick} graph={graph} />
        {onOpenHitl && (
          <div style={{ marginTop: 10 }}>
            <button
              className="btn"
              onClick={onOpenHitl}
              title="Open the human-in-the-loop panel to approve a governed, reversible change to the graph"
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "6px 14px",
                borderRadius: 6,
                cursor: "pointer",
                color: "#0a0e14",
                background: "var(--clinical-blue-bright, #4a9eff)",
                border: "1px solid var(--clinical-blue-bright, #4a9eff)",
              }}
            >
              ⚖ Open HITL mutate &amp; revert…
            </button>
            <span style={{ marginLeft: 10, fontSize: 11.5, opacity: 0.65 }}>
              Resolve a flagged node or promote a candidate — a governed, fully
              reversible write (the gate below is a local prototype and never mutates).
            </span>
          </div>
        )}
        {gated.length > 0 && <HitlGate gated={gated} />}
        <ReadinessLegend />
      </div>
    </div>
  );
}

/**
 * Flagged-node list — the signature "clicking a risk opens the graph path"
 * interaction. Each flagged node shows, per flag: the WHY (the SHACL rule message,
 * server-grounded), the violated rule + expected-vs-actual, a deterministic
 * Severity badge and the Recommended owner (RISK_POLICY). Clicking the row opens
 * the node's provenance drawer / graph path.
 */
function FlaggedList({
  flagged,
  onNodeClick,
  graph,
}: {
  flagged: RiskFinding[];
  onNodeClick: (n: GraphNode) => void;
  graph: GraphPayload;
}) {
  if (flagged.length === 0) return null;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      {flagged.map((f) =>
        f.flags.map((fl, i) => {
          const policy = RISK_POLICY[fl];
          const reason = f.reasons?.find((r) => r.flag === fl);
          const node = nodeById.get(f.nodeId);
          return (
            <div
              key={`${f.nodeId}-${fl}`}
              onClick={() => node && onNodeClick(node)}
              title="Open this node's graph path / provenance drawer"
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                background: "var(--canvas-surface)",
                border: "1px solid var(--canvas-border)",
                borderLeft: `3px solid ${SEVERITY_TONE[policy.severity] ?? "var(--canvas-border)"}`,
                cursor: node ? "pointer" : "default",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: 999,
                    color: "#0a0e14",
                    background: SEVERITY_TONE[policy.severity] ?? "var(--canvas-border)",
                  }}
                >
                  {policy.severity}
                </span>
                <strong style={{ fontSize: 12.5 }}>{f.nodeId}</strong>
                <span style={{ fontSize: 12, opacity: 0.85 }}>· {FLAG_LABEL[fl]}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, opacity: 0.75 }}>
                  Owner: <strong>{policy.owner}</strong>
                </span>
              </div>
              {/* The "Why was this flagged?" evidence path — SHACL-grounded. */}
              {i === 0 && reason && (
                <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.5, opacity: 0.9 }}>
                  <div>
                    <span style={{ opacity: 0.65 }}>Why flagged: </span>
                    {reason.reason}
                  </div>
                  {(reason.rule || reason.expected) && (
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        opacity: 0.7,
                        marginTop: 2,
                      }}
                    >
                      {reason.rule && <span>rule: {reason.rule}</span>}
                      {reason.rule && reason.expected && <span> · </span>}
                      {reason.expected && <span>{reason.expected}</span>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

/**
 * Human-in-the-Loop governance gate — made unmissable. Deductive/structural
 * findings (routedToHuman=false) auto-accept; statistical findings route to a
 * human. Two visually distinct pill states + a one-line "why" per conclusion.
 */
function HitlGate({ gated }: { gated: GatedConclusionWithTrace[] }) {
  // PROTOTYPE-ONLY reviewer state: decision per conclusion + an in-memory audit
  // log. Nothing here persists or touches the server/graph (see banner below).
  const [decisions, setDecisions] = useState<Record<string, ReviewDecision>>({});
  const [audit, setAudit] = useState<AuditEntry[]>([]);

  const record = (g: GatedConclusionWithTrace, decision: ReviewDecision) => {
    setDecisions((d) => ({ ...d, [g.id]: decision }));
    setAudit((log) => [
      {
        ts: new Date().toISOString(),
        conclusionId: g.id,
        decision,
        reviewer: "demo-reviewer",
        confidence: g.confidence,
      },
      ...log,
    ]);
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        background: "var(--canvas-surface)",
        border: "1px solid var(--canvas-border)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          marginBottom: 8,
        }}
      >
        Human-in-the-Loop governance
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {gated.map((g) => {
          const human = g.routedToHuman;
          const why = human
            ? `statistical signal${g.confidence != null ? `, confidence ${g.confidence}` : ""} ⇒ routed to human`
            : "structural/deductive ⇒ auto-accepted";
          return (
            <div
              key={g.id}
              style={{
                padding: "8px 10px",
                borderRadius: 6,
                background: human ? "rgba(224,169,59,.10)" : "rgba(63,185,80,.10)",
                borderLeft: `3px solid ${human ? "var(--risk-mid)" : "var(--live)"}`,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                    padding: "3px 9px",
                    borderRadius: 999,
                    background: human ? "rgba(224,169,59,.18)" : "rgba(63,185,80,.18)",
                    color: human ? "var(--gov-review-text)" : "var(--gov-accept-text)",
                    border: `1px solid ${human ? "var(--risk-mid)" : "var(--live)"}`,
                  }}
                >
                  {human ? "🟩 → human review" : "🟦 auto-accept"}
                </span>
                <span style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{g.summary}</div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 2 }}>
                    {why}
                    {g.confidence != null && (
                      <span style={{ marginLeft: 8, fontVariantNumeric: "tabular-nums" }}>
                        conf {g.confidence}
                      </span>
                    )}
                  </div>
                </span>
              </div>
              {/* Decision-support is ONLY offered for review-routed (🟩) items.
                  Auto-accepted (🟦) structural/deductive conclusions need no
                  human and get no buttons — the gate's invariant is preserved. */}
              {human && (
                <DecisionSupportPanel
                  g={g}
                  decision={decisions[g.id] ?? "pending"}
                  onDecide={(d) => record(g, d)}
                />
              )}
            </div>
          );
        })}
      </div>
      {audit.length > 0 && <AuditTrail entries={audit} />}
    </div>
  );
}

/** One PROTOTYPE audit entry — in-memory only, lost on reload (see proposal in
 *  HITL_Design.md for real append-only persistence). */
interface AuditEntry {
  ts: string;
  conclusionId: string;
  decision: ReviewDecision;
  reviewer: string;
  confidence?: number;
}

const DECISION_LABEL: Record<ReviewDecision, string> = {
  pending: "Pending review",
  accepted: "Accepted",
  rejected: "Rejected",
  escalated: "Escalated",
};

/**
 * DECISION-SUPPORT PANEL (prototype). Surfaces, for a review-routed (🟩)
 * statistical conclusion: the deterministic reasoning trace served by the BFF
 * (rule + ground-triple premises + notes), the confidence, a recommended action
 * with rationale, and accept / reject / escalate affordances. Decisions are
 * LOCAL React state for the demo — clearly labelled, non-persistent, and they
 * never mutate the graph or weaken server-side grounding.
 */
function DecisionSupportPanel({
  g,
  decision,
  onDecide,
}: {
  g: GatedConclusionWithTrace;
  decision: ReviewDecision;
  onDecide: (d: ReviewDecision) => void;
}) {
  // Recommendation is a transparent function of the served confidence band.
  const conf = g.confidence ?? 0;
  const recommendation =
    conf >= 0.85
      ? { action: "Accept", rationale: "high confidence above the auto-route band" }
      : conf >= 0.6
        ? { action: "Escalate", rationale: "moderate confidence — corroborate before adopting" }
        : { action: "Reject", rationale: "low confidence — insufficient support to adopt" };

  const settled = decision !== "pending";

  return (
    <div
      style={{
        marginTop: 8,
        padding: 10,
        borderRadius: 6,
        background: "var(--canvas)",
        border: "1px solid var(--canvas-border)",
      }}
    >
      <Section title="Confidence">
        <ConfidenceMeter value={conf} />
      </Section>

      {g.trace && (
        <Section title="Deterministic reasoning trace (server-grounded)">
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--canvas-text)",
              lineHeight: 1.5,
            }}
          >
            <div style={{ opacity: 0.8, marginBottom: 4 }}>rule: {g.trace.rule}</div>
            {g.trace.steps.map((s, i) => (
              <div key={i} style={{ marginBottom: 3 }}>
                <span style={{ color: "var(--edge)" }}>{s.premise}</span>
                <span style={{ opacity: 0.6 }}> — {s.note}</span>
              </div>
            ))}
            {g.trace.conclusion && (
              <div style={{ marginTop: 4, color: "var(--live)" }}>⊢ {g.trace.conclusion}</div>
            )}
          </div>
        </Section>
      )}

      <Section title="Evidence & provenance">
        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
          Statistic read from the canonical store (SPARQL, read-only). Drill into the cited
          nodes on the graph above for full ALCOA+ provenance (source system, ontology version,
          timestamp, licence). Grounding is enforced server-side — the panel only displays what
          the reasoner reported.
        </div>
      </Section>

      <Section title="Recommended action">
        <div style={{ fontSize: 12.5 }}>
          <strong style={{ color: "var(--clinical-blue-bright)" }}>{recommendation.action}</strong>
          <span style={{ opacity: 0.8 }}> — {recommendation.rationale}</span>
        </div>
      </Section>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <DecisionButton
          label="Accept"
          tone="var(--live)"
          active={decision === "accepted"}
          onClick={() => onDecide("accepted")}
        />
        <DecisionButton
          label="Reject"
          tone="var(--risk-low)"
          active={decision === "rejected"}
          onClick={() => onDecide("rejected")}
        />
        <DecisionButton
          label="Escalate"
          tone="var(--risk-mid)"
          active={decision === "escalated"}
          onClick={() => onDecide("escalated")}
        />
        {settled && (
          <span style={{ fontSize: 11.5, opacity: 0.8, marginLeft: 4 }}>
            ✓ recorded: <strong>{DECISION_LABEL[decision]}</strong>
          </span>
        )}
      </div>
      <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 8, fontStyle: "italic" }}>
        Prototype: decisions are local demo state, not persisted, and never mutate the graph.
      </div>
    </div>
  );
}

/** A labelled sub-block inside the decision-support panel. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: 4,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

/** Confidence bar — purely a readout of the server-served confidence value. */
function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.85 ? "var(--risk-high)" : value >= 0.6 ? "var(--risk-mid)" : "var(--risk-low)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 999,
          background: "var(--canvas-surface-2)",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: tone }} />
      </div>
      <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: tone, fontWeight: 600 }}>
        {pct}%
      </span>
    </div>
  );
}

/** Accept/Reject/Escalate affordance — local UI only. */
function DecisionButton({
  label,
  tone,
  active,
  onClick,
}: {
  label: string;
  tone: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="btn"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: 12,
        fontWeight: 600,
        padding: "5px 12px",
        borderRadius: 6,
        cursor: "pointer",
        color: active ? "#0a0e14" : tone,
        background: active ? tone : "transparent",
        border: `1px solid ${tone}`,
      }}
    >
      {label}
    </button>
  );
}

/** In-memory audit trail (prototype). Real append-only persistence is a written
 *  proposal in HITL_Design.md, not wired here. */
function AuditTrail({ entries }: { entries: AuditEntry[] }) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 6,
        background: "var(--canvas)",
        border: "1px solid var(--canvas-border)",
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.4,
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: 6,
        }}
      >
        Audit trail (session · prototype)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {entries.map((e, i) => (
          <div
            key={i}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--canvas-text)",
              opacity: 0.85,
            }}
          >
            <span style={{ opacity: 0.6 }}>{e.ts}</span> · {e.reviewer} →{" "}
            <strong>{DECISION_LABEL[e.decision]}</strong> · {e.conclusionId}
            {e.confidence != null && (
              <span style={{ opacity: 0.6 }}> (conf {e.confidence})</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Readiness-score legend — explains the on-node number. 100 = clean provenance;
 * every data-quality defect subtracts 25. Colour comes from readinessColor().
 */
function ReadinessLegend() {
  const samples = [100, 75, 50, 25];
  return (
    <div
      style={{
        marginTop: 10,
        padding: 12,
        background: "var(--canvas-surface)",
        border: "1px solid var(--canvas-border)",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: "uppercase",
          marginBottom: 6,
        }}
      >
        Readiness score (FAIR / ALCOA+)
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", marginBottom: 6 }}>
        {samples.map((s) => (
          <span key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: readinessColor(s),
                display: "inline-block",
              }}
            />
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{s}</strong>
          </span>
        ))}
      </div>
      <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
        100 = clean provenance. Each data-quality defect subtracts 25 (75 = one flag, 50 = two, …).
        Colour follows the readiness scale.
      </div>
    </div>
  );
}
