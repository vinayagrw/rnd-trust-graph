/**
 * UC4 — Data-Quality & Patient-Safety Risk Radar (subject-safety).
 *
 * The brief's Use Case 4: a dashboard of relationship-level safety risks over
 * trial-subject data. Each row carries the seven attributes (risk type · affected
 * subject · source system · severity · evidence · remediation owner · audit) and,
 * on click, REVEALS THE GRAPH PATH — Subject → relationship → gap → safety rule →
 * risk raised → source systems affected. All findings are SHACL-grounded on the
 * BFF (GET /api/safety), served from an isolated store so the FAIR radar (Beat 1)
 * is untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  SafetyReport,
  SafetyFinding,
  SafetyPathStep,
  SafetyAudit,
  SafetyRemediation,
  SafetyTrendPoint,
  GraphPayload,
  StreamEvent,
} from "@rnd/shared";
import { api, explainSafetyFinding, askSafety } from "../api.js";
import { GraphCanvas } from "../components/GraphCanvas.js";
import { SafetyFiltersRail } from "../components/SafetyFiltersRail.js";
import {
  applySafetyFilters,
  EMPTY_SAFETY_FILTERS,
  type SafetyGraphFilters,
} from "../lib/filterSafetyGraph.js";
import { Sparkline } from "../finops/Sparkline.js";
import { log } from "../lib/log.js";
import type { RiskSeverity, SafetyRiskType } from "@rnd/shared";

/** Severity rank so a subject in multiple findings takes its WORST band. */
const SEVERITY_RANK: Record<RiskSeverity, number> = { P0: 3, P1: 2, P2: 1 };

/** Severity badge colour per band (matches the FAIR radar's SEVERITY_TONE). */
const SEVERITY_TONE: Record<string, string> = {
  P0: "var(--risk-low, #f85149)",
  P1: "var(--risk-mid, #e0a93b)",
  P2: "var(--risk-high, #3fb950)",
};

/** Path-step colour by tone. gap = the problem hop, rule = the safety rule,
 *  risk = the raised risk, source = the systems affected. */
const TONE: Record<SafetyPathStep["tone"], { dot: string; strike?: boolean }> = {
  fact: { dot: "var(--edge, #6b7684)" },
  gap: { dot: "var(--risk-low, #f85149)", strike: true },
  rule: { dot: "var(--clinical-blue-bright, #4a9eff)" },
  risk: { dot: "var(--risk-low, #f85149)" },
  source: { dot: "var(--edge, #6b7684)" },
};

export function SafetyRadarBeat({ lightCanvas }: { lightCanvas?: boolean }) {
  const [report, setReport] = useState<SafetyReport>();
  const [openId, setOpenId] = useState<string | null>(null);
  const [audit, setAudit] = useState<SafetyAudit>();
  const [showAudit, setShowAudit] = useState(false);
  // F1 — the projected subject-safety subgraph (was invisible until now).
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] });
  // F4 — the single configured refusal marker, so Ask-the-radar detects a refusal
  // exactly the way the agent emits it (never a hard-coded guess).
  const [notInGraphMarker, setNotInGraphMarker] = useState<string>();
  // F2 — the agent's remediation per finding, keyed by finding id.
  const [remediations, setRemediations] = useState<Map<string, SafetyRemediation>>(new Map());
  // The persisted readiness trend — a governed correction/revert bends this line.
  const [trend, setTrend] = useState<SafetyTrendPoint[]>([]);
  // Bumped after a correction lands, so the canvas remounts on the fresh graph.
  const [busy, setBusy] = useState(false);

  // Re-fetch every live surface — the report (score + findings), the subject graph,
  // the remediations (with their applied flag), and the trend. Called on mount and
  // after a correction is applied/reverted so the whole beat reflects the movement.
  const reload = useCallback(async () => {
    await Promise.all([
      api.safety().then(setReport).catch((e) => log.error("safety() load failed:", e)),
      api.safetyGraph().then(setGraph).catch((e) => log.error("safetyGraph() load failed:", e)),
      api
        .safetyRemediation()
        .then((items) => setRemediations(new Map(items.map((r) => [r.findingId, r]))))
        .catch((e) => log.error("safetyRemediation() load failed:", e)),
      api.safetyTrend().then(setTrend).catch((e) => log.error("safetyTrend() load failed:", e)),
    ]);
  }, []);

  useEffect(() => {
    void reload();
    api
      .publicConfig()
      .then((c) => setNotInGraphMarker(c.notInGraphMarker))
      .catch((e) => log.error("publicConfig() load failed:", e));
  }, [reload]);

  // Apply / revert a finding's governed correction, then reload the whole beat so
  // the finding drops out, the subject un-flags, the score moves, and the trend
  // gains a point — the close-the-loop moment, on one screen.
  const onCorrection = useCallback(
    async (findingId: string, direction: "apply" | "revert") => {
      setBusy(true);
      try {
        if (direction === "apply") await api.applyRemediation(findingId);
        else await api.revertRemediation(findingId);
        await reload();
      } catch (e) {
        log.error(`${direction}Remediation() failed:`, e);
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const findings = report?.findings ?? [];

  // The open finding's evidence-path node ids → flow particles + bright stroke
  // across the canvas (same pathNodes contract Beat 2/4 use). Empty when collapsed.
  const openFinding = findings.find((f) => f.id === openId);
  const pathNodes = useMemo(
    () =>
      new Set(
        (openFinding?.path ?? [])
          .map((s) => s.nodeId)
          .filter((id): id is string => Boolean(id)),
      ),
    [openFinding],
  );
  // Every unsafe subject → amber "!" stamp on the canvas, so the failing records
  // read at a glance even before a card is opened. Derived from findings only.
  const flaggedSet = useMemo(
    () => new Set(findings.flatMap((f) => f.affectedSubjects)),
    [findings],
  );

  // Filter dimensions, derived purely from the served findings (grounded).
  // A subject in >1 finding takes its worst severity and unions its risk types.
  const severityById = useMemo(() => {
    const m = new Map<string, RiskSeverity>();
    for (const f of findings) {
      for (const id of f.affectedSubjects) {
        const cur = m.get(id);
        if (!cur || SEVERITY_RANK[f.severity] > SEVERITY_RANK[cur]) m.set(id, f.severity);
      }
    }
    return m;
  }, [findings]);
  const riskTypesById = useMemo(() => {
    const m = new Map<string, Set<SafetyRiskType>>();
    for (const f of findings) {
      for (const id of f.affectedSubjects) {
        (m.get(id) ?? m.set(id, new Set()).get(id)!).add(f.riskType);
      }
    }
    return m;
  }, [findings]);
  const presentRiskTypes = useMemo(
    () => Array.from(new Set(findings.map((f) => f.riskType))).sort(),
    [findings],
  );

  // Presenter-trusted client-side filters (hide-only; grounding intact).
  const [filters, setFilters] = useState<SafetyGraphFilters>(() => ({
    ...EMPTY_SAFETY_FILTERS,
    kinds: new Set(),
  }));
  // Never hide a node on the currently-lit evidence path (`keep` guard).
  const shownGraph = useMemo(
    () => applySafetyFilters(graph, filters, severityById, riskTypesById, flaggedSet, pathNodes),
    [graph, filters, severityById, riskTypesById, flaggedSet, pathNodes],
  );
  // Click a subject node → open its finding card (canvas ↔ rail link).
  const openBySubject = (nodeId: string) => {
    const hit = findings.find(
      (f) => f.subjectId === nodeId || f.affectedSubjects.includes(nodeId),
    );
    if (hit) setOpenId(hit.id);
  };
  // Click a risk-type bar in the signal strip → open the first finding of that type.
  const openByType = (riskType: SafetyFinding["riskType"]) => {
    const hit = findings.find((f) => f.riskType === riskType);
    if (hit) setOpenId(hit.id);
  };

  // Lazy-load the score audit only when the presenter opens it.
  useEffect(() => {
    if (showAudit && !audit) {
      api.safetyAudit().then(setAudit).catch((e) => log.error("safetyAudit() load failed:", e));
    }
  }, [showAudit, audit]);

  const scoreTone =
    (report?.overall ?? 100) >= 70
      ? "var(--risk-high, #3fb950)"
      : (report?.overall ?? 100) >= 40
        ? "var(--risk-mid, #e0a93b)"
        : "var(--risk-low, #f85149)";

  return (
    <div
      style={{
        height: "100%",
        overflowY: "auto",
        color: "var(--canvas-text)",
        padding: "4px 2px",
      }}
    >
      {/* Score banner — the door-opener. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          padding: "10px 12px",
          borderRadius: 8,
          background: "var(--canvas-surface)",
          border: "1px solid var(--canvas-border)",
        }}
      >
        <strong style={{ fontSize: 15 }}>Patient-safety readiness:</strong>
        <span style={{ fontSize: 22, fontWeight: 800, color: scoreTone, fontVariantNumeric: "tabular-nums" }}>
          {report?.overall ?? "…"} / 100
        </span>
        {/* Dual headline — the reproducible % (above, for the audit) sits next to the
            SEVERITY-WEIGHTED index so a P0 clearing visibly outweighs a P2. */}
        <span
          title="Severity-weighted risk index (100 = clean). A P0 finding lowers it more than a P2 — clearing a high-severity risk moves it most."
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "2px 9px",
            borderRadius: 999,
            border: "1px solid var(--canvas-border)",
            color: "var(--canvas-text)",
            opacity: 0.9,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          weighted {report?.weightedIndex ?? "…"} / 100
        </span>
        <span style={{ fontSize: 12.5, opacity: 0.8 }}>
          {report ? `${findings.length} safety risks across ${report.subjectsAssessed} assessed subjects` : "loading…"}
        </span>
        {report && (
          <button
            type="button"
            onClick={() => setShowAudit((v) => !v)}
            style={{
              marginLeft: "auto",
              fontSize: 11,
              padding: "3px 9px",
              borderRadius: 6,
              cursor: "pointer",
              border: "1px solid var(--canvas-border)",
              background: "transparent",
              color: "var(--canvas-text)",
              opacity: 0.85,
            }}
            title="Show exactly how this score is computed — assessed set, unsafe set, and the formula"
          >
            {showAudit ? "Hide audit" : "How is this scored?"}
          </button>
        )}
      </div>

      {/* F3 — the population signal, before any single card. */}
      {findings.length > 0 && (
        <SignalStrip
          findings={findings}
          overall={report?.overall}
          assessed={report?.subjectsAssessed}
          onPick={openByType}
        />
      )}

      {/* The readiness TREND — bends when a governed correction clears a finding. */}
      <TrendPanel trend={trend} />

      {showAudit && <ScoreAudit audit={audit} />}

      <div style={{ margin: "10px 2px 8px", fontSize: 12.5, opacity: 0.85, lineHeight: 1.5 }}>
        Each risk below is a <strong>relationship gap</strong> the graph found — not a field error.
        Click a subject on the graph (or open a card) to light up its <strong>evidence path</strong>:
        subject → relationship → gap → safety rule → risk → source systems.
      </div>

      {/* F1 — the subject-safety subgraph, finally on screen. Failing subjects carry
          an amber flag; opening a finding flows its evidence path across the canvas. */}
      {graph.nodes.length > 0 && (
        <div style={{ display: "flex", gap: 10, alignItems: "stretch", margin: "2px 0 12px" }}>
          <div style={{ width: 190, flex: "0 0 auto" }}>
            <SafetyFiltersRail
              graph={graph}
              filters={filters}
              onChange={setFilters}
              presentRiskTypes={presentRiskTypes}
              visibleCount={shownGraph.nodes.length}
            />
          </div>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid var(--canvas-border)",
            }}
          >
            <GraphCanvas
              graph={shownGraph}
              pathNodes={pathNodes}
              flagged={flaggedSet}
              searchable
              lightCanvas={lightCanvas}
              filtersSlot={
                <SafetyFiltersRail
                  graph={graph}
                  filters={filters}
                  onChange={setFilters}
                  presentRiskTypes={presentRiskTypes}
                  visibleCount={shownGraph.nodes.length}
                />
              }
              onNodeClick={(n) => openBySubject(n.id)}
              height={360}
            />
          </div>
        </div>
      )}

      {/* The risk dashboard. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {findings.map((f) => (
          <SafetyCard
            key={f.id}
            finding={f}
            remediation={remediations.get(f.id)}
            open={openId === f.id}
            onToggle={() => setOpenId(openId === f.id ? null : f.id)}
            onCorrection={onCorrection}
            busy={busy}
            lightCanvas={lightCanvas}
          />
        ))}
      </div>

      {/* F4 — grounded, read-only Q&A over the projected subject graph. */}
      <AskRadar notInGraphMarker={notInGraphMarker} />

      {/* The 8th risk — AI answer without evidence — cross-linked honestly. */}
      {report?.aiSafetyNote && (
        <div
          style={{
            marginTop: 12,
            padding: "9px 12px",
            borderRadius: 8,
            background: "rgba(74,158,255,.08)",
            border: "1px solid var(--clinical-blue-bright, #4a9eff)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <strong>🛡️ AI-safety guardrail — </strong>
          {report.aiSafetyNote}
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, opacity: 0.6, lineHeight: 1.5, padding: "0 2px" }}>
        Grounded live by SHACL over an RDF trial-subject graph. Findings are read-only; remediation runs
        through the same governed, reversible HITL writer as Beat 1 — every fix is attributed and revertible.
      </div>
    </div>
  );
}

/** One risk row → expands to the multi-hop evidence path on click. */
function SafetyCard({
  finding: f,
  remediation,
  open,
  onToggle,
  onCorrection,
  busy,
  lightCanvas,
}: {
  finding: SafetyFinding;
  remediation?: SafetyRemediation;
  open: boolean;
  onToggle: () => void;
  onCorrection: (findingId: string, direction: "apply" | "revert") => void;
  busy: boolean;
  lightCanvas?: boolean;
}) {
  const tone = SEVERITY_TONE[f.severity] ?? "var(--canvas-border)";
  return (
    <div
      style={{
        borderRadius: 6,
        background: "var(--canvas-surface)",
        border: "1px solid var(--canvas-border)",
        borderLeft: `3px solid ${tone}`,
        overflow: "hidden",
      }}
    >
      <div
        onClick={onToggle}
        title="Open this risk's evidence path"
        style={{ padding: "9px 11px", cursor: "pointer" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 999,
              color: "#0a0e14",
              background: tone,
            }}
          >
            {f.severity}
          </span>
          <strong style={{ fontSize: 13 }}>{SAFETY_LABEL[f.riskType]}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            · {f.affectedSubjects.join(" + ")}
          </span>
          <span style={{ marginLeft: "auto", fontSize: 11.5, opacity: 0.75 }}>
            Owner: <strong>{f.owner}</strong>
          </span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>{open ? "▾" : "▸"}</span>
        </div>
        <div style={{ marginTop: 5, fontSize: 11.5, lineHeight: 1.5, opacity: 0.9 }}>
          <span style={{ opacity: 0.65 }}>Why flagged: </span>
          {f.reason}
        </div>
      </div>

      {open && (
        <div
          style={{
            padding: "4px 12px 12px",
            borderTop: "1px solid var(--canvas-border)",
          }}
        >
          {/* The graph path — the source brief's "clicking a risk opens the graph path". */}
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              opacity: 0.7,
              margin: "10px 0 8px",
            }}
          >
            Evidence path
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {f.path.map((s, i) => (
              <PathStep key={i} step={s} last={i === f.path.length - 1} />
            ))}
          </div>

          {/* Rule + expected-vs-actual (the auditable "why"). */}
          <div
            style={{
              marginTop: 10,
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              opacity: 0.75,
              lineHeight: 1.5,
            }}
          >
            <div>rule: {f.rule}</div>
            <div>{f.expected}</div>
            <div>source systems: {f.sourceSystems.join(" · ")}</div>
          </div>

          {/* Recommended remediation. */}
          <div
            style={{
              marginTop: 10,
              padding: "8px 10px",
              borderRadius: 6,
              background: lightCanvas ? "rgba(0,0,0,.03)" : "rgba(255,255,255,.03)",
              border: "1px solid var(--canvas-border)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "var(--clinical-blue-bright, #4a9eff)" }}>
              Recommended remediation
            </strong>{" "}
            — {f.remediation} <span style={{ opacity: 0.7 }}>(owner: {f.owner})</span>
          </div>

          {/* F2 — the agent's remediation: preview, route to owner, AND apply the
              governed correction that closes the loop. */}
          {remediation && (
            <RemediationBlock
              finding={f}
              remediation={remediation}
              onCorrection={onCorrection}
              busy={busy}
              lightCanvas={lightCanvas}
            />
          )}

          {/* Grounded LLM explanation — cites only the finding's path + neighbours. */}
          <ExplainBlock subjectId={f.subjectId} lightCanvas={lightCanvas} />
        </div>
      )}
    </div>
  );
}

/**
 * F2 · Agentic Remediate — the agent's PROPOSE-ONLY remediation for one finding.
 *
 * Shows the drafted action, the accountable owner, exactly what routing/approving
 * records (the honesty note), and a "Route to <owner>" action that enqueues a
 * governed, reversible task into the SAME HITL queue as Beat 1. It NEVER mutates
 * patient data from here — approval flows through the existing authorized writer.
 */
function RemediationBlock({
  finding: f,
  remediation: rem,
  onCorrection,
  busy,
  lightCanvas,
}: {
  finding: SafetyFinding;
  remediation: SafetyRemediation;
  onCorrection: (findingId: string, direction: "apply" | "revert") => void;
  busy: boolean;
  lightCanvas?: boolean;
}) {
  const [status, setStatus] = useState<"idle" | "routing" | "routed" | "error">(
    rem.routed ? "routed" : "idle",
  );
  const stewardship = rem.kind === "data-stewardship";
  const kindLabel = stewardship ? "Data stewardship" : "Clinical judgement";
  const correctable = rem.forwardOps.length > 0;

  const route = async () => {
    setStatus("routing");
    try {
      await api.routeRemediation(f.id);
      setStatus("routed");
    } catch (e) {
      log.error("routeRemediation() failed:", e);
      setStatus("error");
    }
  };

  return (
    <div
      style={{
        marginTop: 8,
        padding: "9px 11px",
        borderRadius: 6,
        background: lightCanvas ? "rgba(124,92,246,.06)" : "rgba(124,92,246,.10)",
        border: "1px solid rgba(124,92,246,.45)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ color: "var(--agent-violet, #a78bfa)" }}>🤖 Agent remediation plan</strong>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 7px",
            borderRadius: 999,
            border: "1px solid rgba(124,92,246,.5)",
            opacity: 0.9,
          }}
          title={
            stewardship
              ? "A pure data-stewardship fix (dedupe / code mapping) — appliable later by a connected steward workflow under the same governance."
              : "A clinical judgement — the accountable owner performs the fix in the source system of record; the agent never edits clinical data."
          }
        >
          {kindLabel}
        </span>
        <span style={{ fontSize: 11, opacity: 0.7 }}>reversible · audit-logged</span>
      </div>

      <div style={{ marginTop: 6 }}>
        <span style={{ opacity: 0.65 }}>Proposed task: </span>
        {rem.action} <span style={{ opacity: 0.7 }}>→ {rem.owner}</span>
      </div>
      <div style={{ marginTop: 5, fontSize: 11.5, opacity: 0.82 }}>{rem.effect}</div>

      <div style={{ marginTop: 9, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={status === "routing" || status === "routed"}
          onClick={route}
          style={{
            fontSize: 11.5,
            fontWeight: 600,
            padding: "5px 12px",
            borderRadius: 6,
            cursor: status === "routing" || status === "routed" ? "default" : "pointer",
            border: "1px solid rgba(124,92,246,.6)",
            background: status === "routed" ? "transparent" : "rgba(124,92,246,.18)",
            color: "var(--canvas-text)",
            opacity: status === "routing" ? 0.7 : 1,
          }}
        >
          {status === "routing"
            ? "Routing…"
            : status === "routed"
              ? "✓ Routed to review queue"
              : `Route to ${rem.owner} for approval →`}
        </button>
        {status === "routed" && (
          <span style={{ fontSize: 11, opacity: 0.75 }}>
            Approve it in Beat&nbsp;1’s HITL panel — the governed, reversible writer records the decision.
          </span>
        )}
        {status === "error" && (
          <span style={{ fontSize: 11, color: "var(--risk-low, #f85149)" }}>
            Routing failed — is the BFF reachable?
          </span>
        )}
      </div>

      {/* Close-the-loop — apply the governed correction (clears the finding + moves
          the score), or revert it (byte-identical restore). */}
      {correctable && (
        <div
          style={{
            marginTop: 9,
            paddingTop: 9,
            borderTop: "1px dashed rgba(124,92,246,.35)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {rem.applied ? (
            <>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--risk-high, #3fb950)" }}>
                ✓ Correction applied — finding cleared, score updated
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => onCorrection(f.id, "revert")}
                style={{
                  fontSize: 11.5,
                  padding: "5px 12px",
                  borderRadius: 6,
                  cursor: busy ? "default" : "pointer",
                  border: "1px solid var(--canvas-border)",
                  background: "transparent",
                  color: "var(--canvas-text)",
                  opacity: busy ? 0.6 : 0.9,
                }}
              >
                Revert
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCorrection(f.id, "apply")}
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                padding: "5px 12px",
                borderRadius: 6,
                cursor: busy ? "default" : "pointer",
                border: "1px solid var(--risk-high, #3fb950)",
                background: "rgba(63,185,80,.16)",
                color: "var(--canvas-text)",
                opacity: busy ? 0.7 : 1,
              }}
              title="Apply the reversible governed correction on the safety graph — clears this finding and moves the readiness score."
            >
              {busy ? "Applying…" : "Apply correction & close the loop →"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The readiness TREND — a persisted score history (:SafetyScoreSnapshot). The line
 * bends exactly when a governed correction clears a finding (or a revert restores
 * it), so "is safety improving?" has a live, honest answer. Dependency-free SVG
 * (reuses the FinOps Sparkline). Shows the first reading honestly when there is no
 * history yet.
 */
function TrendPanel({ trend }: { trend: SafetyTrendPoint[] }) {
  if (trend.length === 0) return null;
  const overallSeries = trend.map((p) => p.overall);
  const weightedSeries = trend.map((p) => p.weightedIndex);
  const latest = trend[trend.length - 1];
  const first = trend[0];
  const delta = latest.overall - first.overall;
  const lastNote = [...trend].reverse().find((p) => p.note)?.note;

  return (
    <div
      style={{
        margin: "8px 2px 4px",
        padding: "9px 12px",
        borderRadius: 8,
        background: "var(--canvas-surface)",
        border: "1px solid var(--canvas-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5 }}>Readiness trend</strong>
        {trend.length < 2 ? (
          <span style={{ fontSize: 11.5, opacity: 0.7 }}>
            first reading — apply a correction to bend the line
          </span>
        ) : (
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color:
                delta > 0
                  ? "var(--risk-high, #3fb950)"
                  : delta < 0
                    ? "var(--risk-low, #f85149)"
                    : "var(--canvas-text)",
            }}
          >
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "—"} {delta > 0 ? "+" : ""}
            {delta} over {trend.length} readings
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: 0.85 }}>
            <Sparkline points={overallSeries} width={96} height={22} stroke="#3fb950" title="Reproducible readiness score over time" />
            score
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, opacity: 0.85 }}>
            <Sparkline points={weightedSeries} width={96} height={22} stroke="#a78bfa" title="Severity-weighted index over time" />
            weighted
          </span>
        </div>
      </div>
      {lastNote && (
        <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>
          latest change: <span style={{ fontStyle: "italic" }}>{lastNote}</span>
        </div>
      )}
    </div>
  );
}

/** The reproducible score audit — answers "how is this N/100 computed?" with the
 *  assessed set (Neo4j), the unsafe set, the formula, and the per-subject fired
 *  shapes. Every number is served live by GET /api/safety/audit. */
function ScoreAudit({ audit }: { audit?: SafetyAudit }) {
  if (!audit) {
    return (
      <div style={{ margin: "8px 2px", fontSize: 12, opacity: 0.7 }}>Loading audit…</div>
    );
  }
  const safe = audit.assessed.filter((id) => !audit.unsafe.includes(id));
  return (
    <div
      style={{
        margin: "8px 2px",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid var(--canvas-border)",
        background: "var(--canvas-surface)",
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6 }}>How the readiness score is computed</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, marginBottom: 8 }}>
        overall = round(100 × ({audit.assessedCount} − {audit.unsafeCount}) / {audit.assessedCount}) ={" "}
        <strong>{audit.overall}</strong>
      </div>
      <div style={{ marginBottom: 6 }}>
        <strong>{audit.assessedCount} subjects assessed</strong> (from Neo4j): {audit.assessed.join(", ")}
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong style={{ color: "var(--risk-low, #f85149)" }}>{audit.unsafeCount} unsafe</strong>:{" "}
        {audit.unsafe.join(", ")} ·{" "}
        <strong style={{ color: "var(--risk-high, #3fb950)" }}>{safe.length} safe</strong>: {safe.join(", ")}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5, width: "100%" }}>
          <thead>
            <tr>
              {["Subject", "Fired shape(s)", "SHACL message"].map((h) => (
                <th
                  key={h}
                  style={{
                    textAlign: "left",
                    padding: "3px 10px 3px 0",
                    opacity: 0.7,
                    borderBottom: "1px solid var(--canvas-border)",
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {audit.perSubject.map((s) => (
              <tr key={s.id}>
                <td style={{ padding: "3px 10px 3px 0", fontFamily: "var(--font-mono)", verticalAlign: "top" }}>
                  {s.id}
                </td>
                <td style={{ padding: "3px 10px 3px 0", verticalAlign: "top" }}>{s.firedShapes.join(", ")}</td>
                <td style={{ padding: "3px 0", opacity: 0.8 }}>{s.shaclMessages.join(" ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, opacity: 0.65 }}>
        Reproduce it: <code>npm run etl</code> → <code>GET /api/safety/audit</code>. The assessed set is read
        from the Neo4j projection; the unsafe set + fired shapes are SHACL over the safety reasoner — nothing
        here is hand-entered.
      </div>
    </div>
  );
}

/** On-demand grounded explanation of one finding (SSE). Streams from
 *  /api/safety/explain; shows a grounded badge when the LLM stayed on the
 *  finding's path, or a templated-fallback badge (with a reason) otherwise. */
function ExplainBlock({ subjectId, lightCanvas }: { subjectId: string; lightCanvas?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [isFallback, setIsFallback] = useState(false);
  const [reason, setReason] = useState<string | undefined>();
  const [citedCount, setCitedCount] = useState(0);
  const cancelRef = useRef<null | (() => void)>(null);

  useEffect(() => () => cancelRef.current?.(), []);

  function run() {
    cancelRef.current?.();
    setStarted(true);
    setBusy(true);
    setText("");
    setIsFallback(false);
    setReason(undefined);
    setCitedCount(0);
    let acc = "";
    cancelRef.current = explainSafetyFinding(subjectId, (e) => {
      if (e.type === "token") setText((acc += e.text));
      else if (e.type === "citations") setCitedCount(e.nodeIds.length);
      else if (e.type === "done") {
        setIsFallback(e.isFallback);
        setReason(e.reason);
        setBusy(false);
      } else if (e.type === "error") setBusy(false);
    });
  }

  const grounded = started && !busy && !isFallback;
  return (
    <div style={{ marginTop: 10 }}>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        style={{
          fontSize: 12,
          padding: "5px 11px",
          borderRadius: 6,
          cursor: busy ? "default" : "pointer",
          border: "1px solid var(--clinical-blue-bright, #4a9eff)",
          background: "transparent",
          color: "var(--clinical-blue-bright, #4a9eff)",
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? "Explaining…" : started ? "↻ Re-explain this finding" : "✨ Explain this finding"}
      </button>
      {started && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 10px",
            borderRadius: 6,
            background: lightCanvas ? "rgba(0,0,0,.03)" : "rgba(255,255,255,.03)",
            border: "1px solid var(--canvas-border)",
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          {text || (busy ? "…" : "")}
          {!busy && (
            <div style={{ marginTop: 6, fontSize: 10.5 }}>
              {grounded ? (
                <span style={{ color: "var(--risk-high, #3fb950)" }}>
                  ✓ grounded{citedCount ? ` · ${citedCount} nodes cited` : ""}
                </span>
              ) : (
                <span
                  style={{ color: "var(--risk-mid, #e0a93b)" }}
                  title={reason ? `fallback reason: ${reason}` : undefined}
                >
                  templated fallback{reason ? ` · ${reason}` : ""}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One hop in the evidence path — a coloured dot + label, tone-styled. */
function PathStep({ step: s, last }: { step: SafetyPathStep; last: boolean }) {
  const t = TONE[s.tone];
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      {/* connector column */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto" }}>
        <span
          style={{
            width: 11,
            height: 11,
            borderRadius: "50%",
            background: t.dot,
            marginTop: 4,
            flex: "0 0 auto",
          }}
        />
        {!last && <span style={{ width: 2, flex: 1, minHeight: 14, background: "var(--canvas-border)" }} />}
      </div>
      <div style={{ paddingBottom: last ? 0 : 8 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: s.tone === "risk" || s.tone === "rule" ? 700 : 500,
            textDecoration: t.strike ? "line-through" : "none",
            color: s.tone === "risk" ? "var(--risk-low, #f85149)" : "var(--canvas-text)",
          }}
        >
          {s.relation && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, opacity: 0.6, marginRight: 6 }}>
              {s.relation}
            </span>
          )}
          {s.label}
        </div>
        {s.detail && (
          <div style={{ fontSize: 11.5, opacity: 0.75, marginTop: 1 }}>{s.detail}</div>
        )}
      </div>
    </div>
  );
}

/** F4 — sample questions offered as one-click chips (grounded, answerable over the
 *  projected subject graph). */
const ASK_SAMPLES = [
  "Which subjects are on an anticoagulant prescription but have no allergy record?",
  "List every subject that shares an enrolment id with another subject.",
  "Which subjects have an open referral with no follow-up appointment?",
];

/**
 * F4 — grounded "Ask the radar". A read-only Q&A over the projected subject graph
 * via the existing /ask agent (Neo4j MCP, `--read-only`): the answer is grounded on
 * returned rows, cites real node ids, and refuses (NOT_IN_GRAPH) when unsupported —
 * making the brief's "8th risk" (AI answering past its evidence) literal on subject
 * data. Shows the agent's own trace (chosen strategy + the read-only Cypher it ran).
 * A client-side timeout caps the run so a stalled local `claude` CLI degrades to an
 * honest message instead of spinning.
 */
function AskRadar({ notInGraphMarker }: { notInGraphMarker?: string }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [trace, setTrace] = useState<string[]>([]);
  const [cited, setCited] = useState<string[]>([]);
  const [status, setStatus] = useState<
    "idle" | "streaming" | "done" | "refused" | "timeout" | "error"
  >("idle");
  const stopRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = () => {
    stopRef.current?.();
    stopRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => cleanup, []);

  const run = (question: string) => {
    const text = question.trim();
    if (!text || status === "streaming") return;
    cleanup();
    setQ(text);
    setAnswer("");
    setTrace([]);
    setCited([]);
    setStatus("streaming");
    let acc = "";
    // Cap the run: the grounded /ask agent runs the local CLI, which can stall.
    timerRef.current = setTimeout(() => {
      cleanup();
      setStatus((s) => (s === "streaming" ? "timeout" : s));
    }, 30_000);

    stopRef.current = askSafety(text, (e: StreamEvent) => {
      switch (e.type) {
        case "route":
          setTrace((t) => [...t, `strategy: ${e.strategy} — ${e.reason}`]);
          break;
        case "step":
          setTrace((t) => [...t, e.label]);
          break;
        case "cypher":
          setTrace((t) => [...t, `cypher: ${e.query}`]);
          break;
        case "rows":
          setTrace((t) => [...t, `rows: ${e.preview}`]);
          break;
        case "token":
          acc += e.text;
          setAnswer(acc);
          break;
        case "citations":
          setCited(e.nodeIds);
          break;
        case "done":
          if (timerRef.current) clearTimeout(timerRef.current);
          setStatus(
            e.isFallback || (notInGraphMarker && acc.includes(notInGraphMarker))
              ? "refused"
              : "done",
          );
          break;
        case "error":
          if (timerRef.current) clearTimeout(timerRef.current);
          setStatus("error");
          break;
      }
    });
  };

  const badge = {
    idle: null,
    streaming: { text: "thinking… (read-only Cypher)", color: "var(--clinical-blue-bright, #4a9eff)" },
    done: { text: `✓ grounded${cited.length ? ` · ${cited.length} node${cited.length > 1 ? "s" : ""} cited` : ""}`, color: "var(--risk-high, #3fb950)" },
    refused: { text: "refused — this isn't supported by the graph (honest refusal, not an error)", color: "var(--risk-mid, #e0a93b)" },
    timeout: { text: "no response — local model stalled (set LLM_PROVIDER=api for a live answer)", color: "var(--risk-mid, #e0a93b)" },
    error: { text: "the live model stream dropped mid-answer (usually a transient local-CLI stall) — press Ask to retry", color: "var(--risk-low, #f85149)" },
  }[status];

  return (
    <div
      style={{
        margin: "12px 0 4px",
        padding: "11px 12px",
        borderRadius: 8,
        background: "var(--canvas-surface)",
        border: "1px solid var(--canvas-border)",
      }}
    >
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 2 }}>Ask the radar</div>
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
        A grounded, read-only question over the subject graph. Answers cite real nodes or refuse —
        never guess.
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(q);
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. which subjects on an anticoagulant have no allergy record?"
          style={{
            flex: 1,
            fontSize: 12,
            padding: "6px 9px",
            borderRadius: 6,
            border: "1px solid var(--canvas-border)",
            background: "transparent",
            color: "var(--canvas-text)",
          }}
        />
        <button
          type="submit"
          disabled={status === "streaming" || !q.trim()}
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "6px 13px",
            borderRadius: 6,
            cursor: status === "streaming" ? "default" : "pointer",
            border: "1px solid var(--clinical-blue-bright, #4a9eff)",
            background: "var(--clinical-blue-bright, #4a9eff)",
            color: "#04111f",
            opacity: status === "streaming" || !q.trim() ? 0.55 : 1,
          }}
        >
          {status === "streaming" ? "…" : "Ask"}
        </button>
      </form>

      {/* Sample prompts */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {ASK_SAMPLES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => run(s)}
            disabled={status === "streaming"}
            style={{
              fontSize: 10.5,
              padding: "3px 8px",
              borderRadius: 999,
              cursor: "pointer",
              border: "1px dashed var(--canvas-border)",
              background: "transparent",
              color: "var(--canvas-text)",
              opacity: 0.85,
            }}
          >
            {s.length > 46 ? s.slice(0, 44) + "…" : s}
          </button>
        ))}
      </div>

      {badge && (
        <div style={{ marginTop: 9, fontSize: 11, fontWeight: 700, color: badge.color }}>{badge.text}</div>
      )}
      {answer && (
        <div style={{ marginTop: 6, fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{answer}</div>
      )}
      {cited.length > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 7 }}>
          {cited.map((id) => (
            <span
              key={id}
              style={{
                fontSize: 10,
                fontFamily: "var(--mono, ui-monospace, monospace)",
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--canvas-bg, rgba(0,0,0,0.15))",
                border: "1px solid var(--canvas-border)",
              }}
            >
              {id}
            </span>
          ))}
        </div>
      )}
      {trace.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 10.5, opacity: 0.7, cursor: "pointer" }}>
            Show the agent's work ({trace.length} step{trace.length > 1 ? "s" : ""})
          </summary>
          <div
            style={{
              marginTop: 5,
              fontSize: 10.5,
              fontFamily: "var(--mono, ui-monospace, monospace)",
              lineHeight: 1.5,
              opacity: 0.85,
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {trace.map((t, i) => (
              <div key={i} style={{ marginBottom: 3 }}>
                {t}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * F3 — Fleet / cohort signal view. Turns the six isolated findings into a
 * population signal: a readiness meter, the P0/P1 severity split, risk-by-type
 * mini-bars, and the most-affected source systems. Pure aggregation over the
 * already-served findings (no new endpoint, no LLM) — every bar drills back to the
 * exact subjects behind it via `onPick`, so there are no un-sourced totals.
 */
function SignalStrip({
  findings,
  overall,
  assessed,
  onPick,
}: {
  findings: SafetyFinding[];
  overall?: number;
  assessed?: number;
  onPick: (riskType: SafetyFinding["riskType"]) => void;
}) {
  const p0 = findings.filter((f) => f.severity === "P0").length;
  const p1 = findings.filter((f) => f.severity === "P1").length;
  // Findings grouped by risk type (each finding = one fired safety rule).
  const byType = findings.reduce<Record<string, SafetyFinding[]>>((acc, f) => {
    (acc[f.riskType] ??= []).push(f);
    return acc;
  }, {});
  const typeRows = Object.entries(byType).sort((a, b) => b[1].length - a[1].length);
  const maxType = Math.max(1, ...typeRows.map(([, fs]) => fs.length));
  // Source systems touched, counted across all findings.
  const bySource = new Map<string, number>();
  for (const f of findings)
    for (const s of f.sourceSystems) bySource.set(s, (bySource.get(s) ?? 0) + 1);
  const topSources = [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

  const band =
    (overall ?? 100) >= 70
      ? "var(--risk-high, #3fb950)"
      : (overall ?? 100) >= 40
        ? "var(--risk-mid, #e0a93b)"
        : "var(--risk-low, #f85149)";

  const box: CSSProperties = {
    flex: 1,
    minWidth: 150,
    padding: "9px 11px",
    borderRadius: 8,
    background: "var(--canvas-surface)",
    border: "1px solid var(--canvas-border)",
  };
  const heading: CSSProperties = {
    fontSize: 10,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    opacity: 0.6,
    marginBottom: 7,
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 2px" }}>
      {/* Readiness meter + severity split */}
      <div style={box}>
        <div style={heading}>Cohort readiness</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: band, fontVariantNumeric: "tabular-nums" }}>
            {overall ?? "…"}
          </span>
          <span style={{ fontSize: 11, opacity: 0.6 }}>/ 100</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, background: "var(--canvas-border)", overflow: "hidden", margin: "6px 0 8px" }}>
          <div style={{ width: `${overall ?? 0}%`, height: "100%", background: band }} />
        </div>
        <div style={{ display: "flex", gap: 6, fontSize: 11 }}>
          <span style={{ color: SEVERITY_TONE.P0, fontWeight: 700 }}>{p0} × P0</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span style={{ color: SEVERITY_TONE.P1, fontWeight: 700 }}>{p1} × P1</span>
          <span style={{ marginLeft: "auto", opacity: 0.6 }}>{assessed ?? "…"} assessed</span>
        </div>
      </div>

      {/* Risk by type — click a bar to open that finding */}
      <div style={{ ...box, flex: 1.6 }}>
        <div style={heading}>Risk by type</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {typeRows.map(([type, fs]) => (
            <button
              key={type}
              type="button"
              onClick={() => onPick(type as SafetyFinding["riskType"])}
              title="Open this finding on the graph"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: 0,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--canvas-text)",
                font: "inherit",
              }}
            >
              <span style={{ flex: "0 0 118px", fontSize: 11, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {SAFETY_LABEL[type as SafetyFinding["riskType"]]}
              </span>
              <span style={{ flex: 1, height: 8, borderRadius: 3, background: "var(--canvas-border)", overflow: "hidden" }}>
                <span
                  style={{
                    display: "block",
                    width: `${(fs.length / maxType) * 100}%`,
                    height: "100%",
                    background: fs.some((f) => f.severity === "P0") ? SEVERITY_TONE.P0 : SEVERITY_TONE.P1,
                  }}
                />
              </span>
              <span style={{ flex: "0 0 auto", fontSize: 11, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {fs.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Source systems affected */}
      <div style={box}>
        <div style={heading}>Systems affected</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {topSources.map(([sys, n]) => (
            <div key={sys} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={sys}>
                {sys}
              </span>
              <span style={{ fontWeight: 700, opacity: 0.8, fontVariantNumeric: "tabular-nums" }}>{n}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const SAFETY_LABEL: Record<SafetyFinding["riskType"], string> = {
  "missing-allergy-status": "Missing allergy status",
  "conflicting-medication": "Conflicting medication records",
  "stale-lab-result": "Lab result too old for pathway decision",
  "referral-without-followup": "Referral without follow-up",
  "duplicate-subject": "Duplicate subject risk",
  "unmapped-local-code": "Unmapped local code",
};
