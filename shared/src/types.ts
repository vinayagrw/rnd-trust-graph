/**
 * Shared contract between the BFF and the web app.
 * One graph, three beats — the types here mirror §4/§7 of the build plan.
 */

import type { DashboardSpec } from "./dashboard.js";
import type { GenerativeTile, GenerativeBoard, GenerativeDatasets, FieldMenuEntry } from "./generative.js";

// ---------------------------------------------------------------------------
// Graph primitives (what the force-graph canvas renders)
// ---------------------------------------------------------------------------

/** Node categories in the R&D Trust Graph. Drives colour/shape on the canvas. */
export type NodeKind =
  | "Patient"
  | "AdverseEvent"
  | "Drug"
  | "BiologicalTarget"
  | "Pathway"
  | "SignalStat"
  | "Evidence"
  | "PathologyImage"
  | "OmicsProfile"
  | "Concept" // ontology / UMLS-style concept node
  | "LiteratureAbstract" // PubMed/PMC abstract (literature modality)
  | "ClinicalTrial" // ClinicalTrials.gov registered study
  | "OntologySlice" // versioned ontology release the codes belong to
  | "RegulatoryDoc" // FDA label / EMA assessment excerpt (regulatory modality)
  | "GeneticAssociation" // Open Targets-style target-disease association
  | "ExternalPipeline"; // F8: synthetic competitor-pipeline node (labelled, never citable)

/** Relationship types along the deterministic explanation path. */
export type EdgeKind =
  | "REPORTS"
  | "SUSPECTED_IN"
  | "TARGETS"
  | "IN_PATHWAY"
  | "HAS_STAT"
  | "SUPPORTED_BY"
  | "RESOLVES_TO" // multimodal node -> concept (Beat 3)
  | "MENTIONS" // literature abstract -> drug/AE/target it discusses
  | "STUDIES" // clinical trial -> drug/AE it investigates
  | "IN_ONTOLOGY" // concept/AE -> the versioned ontology slice it belongs to
  | "HAS_LABEL" // regulatory doc -> drug/AE it labels
  | "GENETIC_EVIDENCE" // genetic association -> target / disease concept it supports
  | "HUMAN_APPROVED" // HITL: an edge a human reviewer promoted (governed mutation)
  | "COMPETES_WITH"; // F8: synthetic external pipeline -> our drug/target it competes with

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Display label, e.g. "Atrial fibrillation (49436004)" — codes are opaque labels. */
  label: string;
  /** Optional readiness score 0..100 used by the Beat-1 radar colour scale. */
  readiness?: number;
  /** Arbitrary display attributes (e.g. PRR/ROR on a SignalStat). */
  attrs?: Record<string, string | number>;
  provenance?: Provenance;
  /** F8: true for a clearly-labelled SYNTHETIC overlay node (e.g. a competitor
   *  pipeline). Synthetic nodes are served from a separate endpoint, never written
   *  to Neo4j, and therefore never in the grounding allow-list — the agent can
   *  never cite one. Rendered distinctly (dashed) so it can't be mistaken for real. */
  synthetic?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** Human-friendly type label rendered on the edge, e.g. "targets" for TARGETS. */
  label?: string;
  /** Reviewer-added free-text tags (HITL overlay, not graph data). Rendered as #tag. */
  tags?: string[];
  provenance?: Provenance;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** F8 — a synthetic competitive-pipeline overlay. A separate, clearly-labelled
 *  payload (every node `synthetic: true`) merged CLIENT-SIDE only; it never enters
 *  Neo4j or the grounding allow-list, so the agent can never cite it. */
export interface CompetitiveOverlay {
  synthetic: true;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------------------------------------------------------------------------
// Provenance / governance (the ALCOA+ / Part 11 drill-down)
// ---------------------------------------------------------------------------

export interface Provenance {
  sourceSystem: string; // e.g. "Synthea v4.0.0", "Hetionet v1.0", "openFDA FAERS"
  code?: string; // ontology code if any
  ontologyVersion?: string; // e.g. "OAE 2025-09"
  ruleVersion?: string; // version of the Cypher rule that asserted the edge
  timestamp: string; // ISO-8601
  license: string; // "CC0" | "CC-BY-4.0" | "public-domain" | "Apache-2.0"
}

// ---------------------------------------------------------------------------
// Beat 2 — deterministic explanation path
// ---------------------------------------------------------------------------

/** One hop in the reveal: the new node reached and the edge that reached it. */
export interface PathHop {
  index: number;
  node: GraphNode;
  /** The edge traversed to reach `node` (undefined for the seed hop). */
  edge?: GraphEdge;
}

export interface ExplanationPath {
  /** Pinned hero path id so the wow always fires deterministically. */
  pathId: string;
  scenario: string; // human-readable, e.g. "Oncology PV signal: <drug> -> <AE>"
  hops: PathHop[];
  /** True when the conclusion is a deductive path-exists fact (auto-accept). */
  deductive: boolean;
}

// ---------------------------------------------------------------------------
// Beat 1 — FAIR / ALCOA+ readiness radar
// ---------------------------------------------------------------------------

export type RiskFlag =
  | "missing-cross-source-link"
  | "dangling-reference"
  | "conflicting-annotation"
  | "missing-provenance"
  | "stale-ontology-version"
  | "duplicate-record" // two distinct nodes share an identity key that must be unique
  | "missing-followup"; // an escalated/referred node lacks its required downstream follow-up

/** One human-readable "why was this flagged?" evidence record, derived from the
 *  SHACL validation report (never invented). `reason` is the SHACL
 *  sh:resultMessage; `rule` names the violated shape; `expected` spells out the
 *  expected-vs-actual where it is deterministically derivable. */
export interface RiskReason {
  flag: RiskFlag;
  /** The SHACL rule message — the WHY shown to the reviewer. */
  reason: string;
  /** The SHACL shape / rule that fired (e.g. "NodeProvenanceShape"). */
  rule?: string;
  /** Expected-vs-actual, e.g. "expected rtg:sourceSystem minCount 1, found 0". */
  expected?: string;
}

export interface RiskFinding {
  nodeId: string;
  flags: RiskFlag[];
  readiness: number; // 0..100
  /** Per-flag evidence path: why each flag fired (SHACL-grounded). Parallel to,
   *  but richer than, `flags` — one entry per flag in the same order. */
  reasons?: RiskReason[];
}

// ---------------------------------------------------------------------------
// Beat 1 — fixed remediation policy (severity + owner per RiskFlag)
//
// This is POLICY METADATA, not a fact source: it does not assert anything about
// the graph, it only routes a SHACL-grounded flag to a severity band and the
// role accountable for fixing it. Kept here (shared) so grounding (BFF) and the
// radar UI read ONE total map. Adding a RiskFlag without an entry is a type
// error — RISK_POLICY is typed Record<RiskFlag, …> so the map stays TOTAL.
// ---------------------------------------------------------------------------

/** Severity band for a data-quality flag. P0 = blocks scale-up, P2 = hygiene. */
export type RiskSeverity = "P0" | "P1" | "P2";

export interface RiskPolicy {
  severity: RiskSeverity;
  /** The role accountable for remediating this class of defect. */
  owner: string;
}

/** TOTAL map: every RiskFlag → its fixed severity + remediation owner. */
export const RISK_POLICY: Record<RiskFlag, RiskPolicy> = {
  "missing-provenance": { severity: "P0", owner: "Data steward" },
  "conflicting-annotation": { severity: "P0", owner: "PV signal lead" },
  "missing-cross-source-link": { severity: "P1", owner: "Bioinformatics lead" },
  "stale-ontology-version": { severity: "P1", owner: "Ontology steward" },
  "duplicate-record": { severity: "P1", owner: "Data steward" },
  "missing-followup": { severity: "P0", owner: "PV signal lead" },
  "dangling-reference": { severity: "P2", owner: "Data steward" },
};

export interface RiskReport {
  /** Overall FAIR + ALCOA+ completeness, 0..100. */
  overall: number;
  findings: RiskFinding[];
  /** SHACL cameo conformance, if the side-copy was run. */
  shacl?: { conforms: boolean; reportPath: string };
  /** Node ids a human reviewer has approved a governed change about (an applied,
   *  non-reverted HITL change set targets them). Drives the canvas "verified"
   *  green-check stamp so approving ANY governed item — not only edge-adding ones
   *  — visibly marks the node as reviewed; clears on revert. */
  humanReviewed?: string[];
}

// ---------------------------------------------------------------------------
// UC4 — Data-Quality & Patient-Safety Risk Radar (subject-safety, R&D-native)
//
// A SECOND, ISOLATED radar (parallel to the FAIR readiness radar above). It
// detects where poor data-quality RELATIONSHIPS create clinical / operational /
// AI-safety risk on trial-subject data — the source brief's Use Case 4. It is built by
// the same SHACL → finding pattern, but over a SEPARATE data + shapes graph
// (data/rdf/safety.ttl + data/shacl/safety-shapes.ttl, served by
// bff/src/safety/service.ts), so the FAIR radar and its exact-flag invariants
// stay byte-identical and untouched.
//
// Each finding carries the source brief's seven attributes (risk type, affected subject,
// source system, severity, evidence, remediation owner, audit trail) PLUS a
// multi-hop evidence PATH — the "clicking a risk opens the graph path"
// interaction: Subject → relationship → gap → safety rule → risk → sources.
// ---------------------------------------------------------------------------

export type SafetyRiskType =
  | "missing-allergy-status"
  | "conflicting-medication"
  | "stale-lab-result"
  | "referral-without-followup"
  | "duplicate-subject"
  | "unmapped-local-code";

/** One step in a safety finding's evidence path. `tone` drives rendering:
 *  fact = an asserted hop, gap = an ABSENT / expected-but-missing hop (rendered
 *  struck-through / dashed), rule = the safety rule that requires it, risk = the
 *  raised risk, source = the source systems affected. */
export interface SafetyPathStep {
  /** The narrative label, e.g. "has active prescription" / "but no allergy record". */
  label: string;
  /** Secondary line — a node label, code, or value. */
  detail?: string;
  /** The real node id when this hop is an actual graph node (fact hops). */
  nodeId?: string;
  /** The relationship traversed to reach this hop. */
  relation?: string;
  tone: "fact" | "gap" | "rule" | "risk" | "source";
}

export interface SafetyFinding {
  /** Stable finding id (riskType + subject). */
  id: string;
  riskType: SafetyRiskType;
  /** The primary affected subject (brief: "affected patients"). */
  subjectId: string;
  subjectLabel: string;
  /** Every subject implicated (>1 only for duplicate-subject). */
  affectedSubjects: string[];
  severity: RiskSeverity;
  /** Recommended remediation owner (role). */
  owner: string;
  /** The source systems the unsafe relationship spans (brief: "source systems affected"). */
  sourceSystems: string[];
  /** Plain-English why, grounded in the SHACL rule message (never invented). */
  reason: string;
  /** The safety SHACL shape that fired. */
  rule: string;
  /** Expected-vs-actual, derived from the shape's constraint. */
  expected: string;
  /** The multi-hop evidence path revealed when the risk is clicked. */
  path: SafetyPathStep[];
  /** Recommended remediation action. */
  remediation: string;
  /** The reversible corrective change set that CLEARS this finding when applied by
   *  the authorized safety-writer (safety/ops.ts). Built from the SAME live query
   *  that produced the evidence path, so every op is grounded — never fabricated.
   *  Empty forward ops means the risk type has no defined auto-correction. */
  correction: { forwardOps: SafetyChangeOp[]; inverseOps: SafetyChangeOp[] };
}

export interface SafetyReport {
  /** Subject-safety score 0..100 = round(100·(safe subjects / assessed)). The
   *  REPRODUCIBLE headline — every unsafe subject counts identically, so a QA can
   *  recompute it from the audit. Kept unchanged for that audit contract. */
  overall: number;
  /** Severity-WEIGHTED risk index 0..100 (100 = clean). Penalises a P0 finding
   *  more than a P2 (weights from admin config `safety`), so clearing a high-severity
   *  finding visibly moves this more than clearing a low one. Shown ALONGSIDE
   *  `overall` — it does not replace the reproducible score. */
  weightedIndex: number;
  subjectsAssessed: number;
  findings: SafetyFinding[];
  /** The 8th risk in the brief — "AI answer attempted without sufficient evidence" — is
   *  the Beat-4 grounding guardrail (faithfulness + ungrounded refusal), NOT a
   *  data finding. Named here so the radar cross-links it honestly. */
  aiSafetyNote: string;
}

/** Fixed policy per safety risk type — label, severity band, remediation owner,
 *  the SHACL shape that detects it, the safety obligation it violates, and the
 *  recommended fix. TOTAL map (typed Record) so adding a risk type is a type error
 *  until its policy is supplied. */
export interface SafetyPolicyEntry {
  label: string;
  severity: RiskSeverity;
  owner: string;
  rule: string;
  /** The safety obligation this risk violates (drives the "rule" path step + why). */
  obligation: string;
  remediation: string;
}

export const SAFETY_POLICY: Record<SafetyRiskType, SafetyPolicyEntry> = {
  "missing-allergy-status": {
    label: "Missing allergy status",
    severity: "P0",
    owner: "Clinical safety lead",
    rule: "AllergyStatusShape",
    obligation: "a subject on an active prescription must have an allergy record on file",
    remediation: "Capture the subject's allergy status before the next dose is administered",
  },
  "conflicting-medication": {
    label: "Conflicting medication records",
    severity: "P0",
    owner: "Clinical safety lead",
    rule: "MedicationConflictShape",
    obligation: "a subject must not hold two active prescriptions for contraindicated drugs",
    remediation: "Reconcile the medication list and deconflict the contraindicated pair",
  },
  "stale-lab-result": {
    label: "Lab result too old for pathway decision",
    severity: "P0",
    owner: "Clinical safety lead",
    rule: "LabRecencyShape",
    obligation: "a dosing decision must rest on a lab result inside the recency window",
    remediation: "Re-order the required lab before the dosing/pathway decision proceeds",
  },
  "referral-without-followup": {
    label: "Referral without follow-up",
    severity: "P0",
    owner: "Care-coordination lead",
    rule: "ReferralFollowupShape",
    obligation: "an open referral must have a booked follow-up appointment",
    remediation: "Book the follow-up appointment and link it to the referral",
  },
  "duplicate-subject": {
    label: "Duplicate subject risk",
    severity: "P1",
    owner: "Data steward",
    rule: "DuplicateSubjectShape",
    obligation: "an enrolment identifier must resolve to exactly one subject record",
    remediation: "Merge the duplicate subject records under one golden identity",
  },
  "unmapped-local-code": {
    label: "Unmapped local code",
    severity: "P1",
    owner: "Terminology steward",
    rule: "LocalCodeMappingShape",
    obligation: "every local code on a subject record must map to a current terminology concept",
    remediation: "Map the local code to a current MedDRA / SNOMED concept",
  },
};

/**
 * F2 · Agentic Remediate — a propose-only, reversible remediation the agent drafts
 * for ONE SafetyFinding and routes to the accountable owner via the HITL queue.
 *
 * TRUST INVARIANT: routing/approving records a GOVERNED remediation task through the
 * existing authorized HITL writer (audit-logged + revertible). It DELIBERATELY carries
 * no data-mutating ops — the agent never fabricates or edits patient/clinical data;
 * the accountable owner performs the real fix in the source system of record. That
 * restraint is the defensible posture for patient safety, and it keeps BOTH the FAIR
 * and safety baselines byte-identical. Pure data-stewardship fixes (dedupe, code
 * mapping) are LABELLED as such so a connected steward workflow can later apply them
 * under the same governance — never silently, never inside this radar.
 */
export interface SafetyRemediation {
  /** The finding this remediates (SafetyFinding.id). */
  findingId: string;
  riskType: SafetyRiskType;
  subjectId: string;
  subjectLabel: string;
  severity: RiskSeverity;
  /** The specific remediation action (grounded in SAFETY_POLICY — never invented). */
  action: string;
  /** The accountable remediation owner (role). */
  owner: string;
  /** Clinical judgement (owner acts in the EHR) vs a pure data-stewardship change
   *  (dedupe / code mapping). Drives the UI label + the honesty note. */
  kind: "clinical-judgement" | "data-stewardship";
  /** Every subject implicated (>1 only for duplicate-subject). */
  affectedSubjects: string[];
  /** Source systems where the owner performs the real-world fix. */
  sourceSystems: string[];
  /** Always true — applying is a reversible governed record. */
  reversible: boolean;
  /** Plain-English preview of exactly what Apply does (and what it does NOT). */
  effect: string;
  /** Deterministic id of the HITL pending item this becomes when routed. */
  pendingItemId: string;
  /** True once an identical governed task is already queued or applied. */
  routed?: boolean;
  /** True once the corrective change set has been APPLIED (finding cleared). */
  applied?: boolean;
  /** The reversible corrective ops that CLEAR this finding's SHACL shape when
   *  applied by the authorized safety-writer (safety reasoner + :Safety Neo4j).
   *  Grounded in the finding — a governed data correction, never fabricated
   *  narrative. Empty only if a risk type has no defined correction. */
  forwardOps: SafetyChangeOp[];
  /** The exact inverse of `forwardOps` — replaying them restores byte-identical
   *  prior state, so every correction is fully revertible. */
  inverseOps: SafetyChangeOp[];
}

/**
 * A reversible mutation over the ISOLATED safety substrate (the dedicated safety
 * reasoner + the `:Safety`-tagged Neo4j projection). Distinct from the canonical
 * `ChangeOp` because safety uses its own relationship/property vocabulary
 * (HAS_ALLERGY_RECORD, MAPS_TO, FOLLOWED_BY, enrolmentId, …) that is deliberately
 * NOT part of the FAIR `EdgeKind` union. Applied ONLY by `bff/src/safety/ops.ts`
 * via the authorized direct-driver write() + reasoner.update() — never the
 * read-only agent/MCP path. `kind`/`prop` are validated against a safe-identifier
 * pattern before interpolation.
 */
export type SafetyChangeOp =
  | { op: "addEdge"; source: string; target: string; kind: string }
  | { op: "removeEdge"; source: string; target: string; kind: string }
  // A datatype-tagged literal set (e.g. a re-ordered lab's fresh xsd:dateTime).
  // `datatype` is the XSD local name ("dateTime", "boolean", …) or absent for a
  // plain string literal. Inverse is the setProp that restores the prior value.
  | { op: "setProp"; nodeId: string; prop: string; value: string; datatype?: string }
  | { op: "unsetProp"; nodeId: string; prop: string; value: string; datatype?: string }
  // Ensure a node exists with a domain label (for a governed new record — the
  // re-ordered lab, the mapped concept, the booked appointment). Inverse deletes it.
  | { op: "ensureNode"; nodeId: string; label: string; nodeLabel?: string }
  | { op: "deleteNode"; nodeId: string; label: string; nodeLabel?: string };

/** One subject's line in the safety-score audit: which safety shapes fired and
 *  the raw SHACL messages behind them (so a validator can trace every flag). */
export interface SafetySubjectAudit {
  id: string;
  /** The safety SHACL shapes that flagged this subject (deduped). */
  firedShapes: string[];
  /** The verbatim SHACL messages behind those flags. */
  shaclMessages: string[];
}

/** The reproducible audit behind "Patient-safety readiness N/100". Everything the
 *  score is computed from is exposed so QA can independently recompute it — the
 *  assessed subject inventory (from Neo4j), the unsafe set, the per-subject fired
 *  rules, and the exact formula — rather than trusting the headline number. */
export interface SafetyAudit {
  /** The headline readiness score (identical to SafetyReport.overall). */
  overall: number;
  /** The exact formula the score is computed by (human-readable). */
  formula: string;
  /** COUNT(DISTINCT Subject) read from the Neo4j projection. */
  assessedCount: number;
  /** The number of DISTINCT subject records that fired ≥1 safety shape. */
  unsafeCount: number;
  /** Every assessed subject id (from Neo4j), sorted. */
  assessed: string[];
  /** The unsafe subject ids (the ones subtracted in the formula), sorted. */
  unsafe: string[];
  /** Per unsafe subject: the shapes that fired + their raw messages. */
  perSubject: SafetySubjectAudit[];
}

/** One point on the patient-safety readiness TREND — an append-only snapshot of
 *  the score at a moment in time, persisted as a `:SafetyScoreSnapshot` node in
 *  Neo4j. A governed correction (or revert) writes a new point, so the trend line
 *  bends when a finding is actually cleared — the payoff of the corrective loop. */
export interface SafetyTrendPoint {
  /** ISO-8601 timestamp of the snapshot. */
  at: string;
  /** Reproducible readiness score at that time (SafetyReport.overall). */
  overall: number;
  /** Severity-weighted risk index at that time (SafetyReport.weightedIndex). */
  weightedIndex: number;
  /** Assessed-subject count (denominator) at that time. */
  assessed: number;
  /** Distinct unsafe-subject count (numerator subtracted) at that time. */
  unsafe: number;
  /** Optional human note — e.g. "SUBJ-206 code mapped" — annotating what moved it. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Beat 3 — multimodal resolve
// ---------------------------------------------------------------------------

export interface ResolveMatch {
  concept: GraphNode; // the ontology Concept node the embedding resolves to
  score: number; // cosine similarity 0..1
  /** True if this concept already lies on the active explanation path. */
  onPath: boolean;
}

export interface ResolveResult {
  sourceNodeId: string; // the PathologyImage / OmicsProfile node clicked
  matches: ResolveMatch[];
}

// ---------------------------------------------------------------------------
// HITL governance gate (shown as a product beat)
// ---------------------------------------------------------------------------

export interface GatedConclusion {
  id: string;
  summary: string;
  kind: "deductive" | "statistical";
  confidence?: number; // present for statistical conclusions
  routedToHuman: boolean;
}

// ---------------------------------------------------------------------------
// HITL mutate + revert (governed, reversible writes via the authorized writer)
//
// A reviewer's approval is recorded as a ChangeSet: an ordered list of forward
// ops PLUS the exact inverse ops that undo them. Every op is applied over BOTH
// the Neo4j projection (via the authorized direct-driver write(), NEVER the
// read-only agent/MCP path) and the canonical RDF store (via SPARQL update).
// Reverting replays the inverse ops, restoring byte-identical prior state.
//
// SHACL "resolved" flags are a RUNTIME OVERLAY only (setFlagResolved /
// clearFlagResolved) — the static ETL TTL is never edited, so the clean baseline
// stays byte-identical and an empty overlay ⇒ today's exact flag set.
// ---------------------------------------------------------------------------

/** One reversible graph mutation. Discriminated on `op`; each variant carries
 *  exactly the fields needed to apply it over Neo4j + the RDF store, and the
 *  ChangeSet stores the matching inverse so revert is exact. */
export type ChangeOp =
  | { op: "addEdge"; source: string; target: string; kind: EdgeKind }
  | { op: "removeEdge"; source: string; target: string; kind: EdgeKind }
  | { op: "setProp"; nodeId: string; prop: string; value: string }
  | { op: "unsetProp"; nodeId: string; prop: string; value: string }
  | { op: "addProvenance"; nodeId: string; provenance: Provenance }
  | { op: "removeProvenance"; nodeId: string; provenance: Provenance }
  | { op: "setFlagResolved"; nodeId: string; flag: RiskFlag }
  | { op: "clearFlagResolved"; nodeId: string; flag: RiskFlag }
  // Manual reviewer flag — an ADDITIVE runtime overlay (mirror of setFlagResolved):
  // addManualFlag raises a flag a human reviewer asserts on any node, removeManualFlag
  // clears it. Overlay-only (no graph data touched), so the baseline TTL stays
  // byte-identical and the pair is an exact inverse → fully reversible.
  | { op: "addManualFlag"; nodeId: string; flag: RiskFlag; reason?: string }
  | { op: "removeManualFlag"; nodeId: string; flag: RiskFlag }
  // Reviewer edge tag — an ADDITIVE runtime overlay keyed on the edge triple
  // (source, kind, target), mirror of addManualFlag. Overlay-only (no graph data
  // touched), so the baseline stays byte-identical and removeEdgeTag is an exact
  // inverse → fully reversible.
  | { op: "addEdgeTag"; source: string; target: string; kind: EdgeKind; tag: string; reason?: string }
  | { op: "removeEdgeTag"; source: string; target: string; kind: EdgeKind; tag: string };

/** Who performed a governed review action, and under what stated purpose (F6).
 *  Audit metadata only — stamped on the change set so every write records who/why.
 *  Purpose is a transparently-labelled disclosure, NOT a hard data ACL. */
export interface ReviewerIdentity {
  name: string;
  role: string; // from the risk-owner vocabulary
}

/** A stated review purpose id (drawn from the admin purposePolicies vocabulary). */
export type ReviewPurpose = string;

/** A reviewer-approved, fully-reversible bundle of mutations. Persisted to
 *  bff/hitl-changesets.json (gitignored), mirroring the threads.json pattern. */
export interface ChangeSet {
  id: string;
  ts: string; // ISO-8601 — when it was applied
  actor: string; // who approved it (demo reviewer identity)
  /** Structured reviewer identity (F6). Optional + additive — older change sets
   *  and reverts are unaffected (this is metadata, never part of the op replay). */
  reviewer?: ReviewerIdentity;
  /** The stated purpose of this review action (F6); disclosure metadata only. */
  purpose?: ReviewPurpose;
  title: string;
  description: string;
  targetNodeId?: string; // the primary node the change is about (for the UI)
  /** The originating pending-item id (when this change set came from approving a
   *  queue item). Lets the pending queue hide an item that is currently applied
   *  (and resurface it after a revert). Absent for ad-hoc changes (e.g. manual
   *  reviewer flags) that have no pending-queue counterpart. */
  itemId?: string;
  forwardOps: ChangeOp[];
  inverseOps: ChangeOp[];
  status: "applied" | "reverted";
}

/** One item in the HITL pending queue — a proposed governed change the reviewer
 *  can Approve (apply the changeset), Reject, or Escalate. The forward/inverse
 *  ops are precomputed so an approval is a deterministic apply. */
export interface HitlPendingItem {
  id: string;
  title: string;
  description: string;
  /** Plain-English summary of exactly what Approve will mutate (and revert undo). */
  effect: string;
  targetNodeId?: string;
  forwardOps: ChangeOp[];
  inverseOps: ChangeOp[];
}

// ---------------------------------------------------------------------------
// Narrator / Ask (SSE) — streamed events
// ---------------------------------------------------------------------------

/** Why a live LLM call dropped to the cached/safe fallback — surfaced so the
 *  presenter is never left guessing whether the demo is really live. */
export type FallbackReason =
  | "disabled" // live mode off (no provider configured)
  | "spawn-failed" // `claude` binary not found / failed to start
  | "not-authenticated" // CLI ran but isn't logged in
  | "no-tools" // MCP server (uvx/Neo4j) didn't connect → no read tools
  | "timeout" // idle watchdog fired
  | "empty-output" // CLI produced no assistant text
  | "ungrounded" // narration cited a node not on the path → refused (enforced invariant)
  | "api-error"; // cloud Messages API call failed

// ---------------------------------------------------------------------------
// Answer-quality scoring (F1 faithfulness + F4 hallucination-at-generation)
//
// OBSERVABILITY/SCORING ONLY (same discipline as FinOps): a faithfulness score
// is computed AFTER the grounded answer is produced, from the served answer text
// + the attributes of the nodes it actually cited. It never edits the answer,
// never adds an agent tool, and never writes. A low score surfaces a VISIBLE
// "low-confidence" stamp — it never silently suppresses an answer.
// ---------------------------------------------------------------------------

/** Confidence band derived from the faithfulness score (fixed cutoffs). */
export type FaithfulnessBand = "high" | "medium" | "low";

/** How the score was produced: the always-on deterministic coverage check, or
 *  the optional LLM judge (which falls back to deterministic on any failure). */
export type FaithfulnessMethod = "deterministic" | "judge";

/** Per-claim trace: was this atomic claim traceable to cited evidence, and which
 *  cited node(s) supported it. Drives the F4 "unverified claim" inline flag. */
export interface ClaimTrace {
  claim: string;
  supported: boolean;
  supportingNodeIds: string[];
}

/** The faithfulness verdict for one grounded answer. `score` is 0..1 (fraction of
 *  evidence-bearing claims traceable to cited nodes); `unsupportedClaims` are the
 *  claims with named entities/figures NOT found in the cited evidence. */
export interface FaithfulnessResult {
  score: number;
  band: FaithfulnessBand;
  method: FaithfulnessMethod;
  unsupportedClaims: string[];
  citedNodeIds: string[];
  /** Optional per-claim breakdown (best-effort; present from the deterministic core). */
  claims?: ClaimTrace[];
  /** True when score is below the configured gate threshold → show a visible
   *  low-confidence stamp (never a silent suppression). */
  gated?: boolean;
}

// ---------------------------------------------------------------------------
// F7 — Literature evidence synthesis (source-ranked, inline-cited)
// ---------------------------------------------------------------------------

/** One LiteratureAbstract node, ranked for synthesis. `rank` is 1-based (1 = top
 *  source). `tier`/`tierLabel` explain WHY it ranks where it does. */
export interface RankedAbstract {
  nodeId: string; // e.g. LIT-PMID-27959767
  title: string; // the node label
  summary: string; // the abstract text (attrs.summary)
  source: string; // provenance.sourceSystem, e.g. "PubMed"
  tier: number; // source-tier rank input (lower = stronger source class)
  tierLabel: string; // human label for the tier, e.g. "Regulatory", "Journal"
  year?: number; // parsed from the provenance timestamp when present
  rank: number; // final 1-based rank after sorting
}

/** A grounded literature synthesis. `narrative` cites abstracts inline by node id;
 *  `citedNodeIds` is the validated subset (⊆ the supplied ranked abstracts).
 *  `isFallback` true when the deterministic template produced it (no live LLM). */
export interface LiteratureSynthesis {
  narrative: string;
  citedNodeIds: string[];
  ranked: RankedAbstract[];
  isFallback: boolean;
}

// ---------------------------------------------------------------------------
// F3 — Adaptive retrieval routing
// ---------------------------------------------------------------------------

/** How the router decided to approach a question. `vector-resolve` = semantic kNN
 *  seeding; `cypher-traversal` = relational graph walk; `hybrid` = both. */
export type RetrievalStrategy = "vector-resolve" | "cypher-traversal" | "hybrid";

/** The router's decision for one question. `seedNodeIds` are REAL candidate ids
 *  (lexical + semantic matches) handed to the agent as "candidates to verify" —
 *  they are NOT citations and can only become one if a read-only query returns
 *  them in a row. */
export interface RouteDecision {
  strategy: RetrievalStrategy;
  rationale: string;
  seedNodeIds: string[];
}

// ---------------------------------------------------------------------------
// F5 — Scientific Workflows / playbooks ("safety dossier")
// ---------------------------------------------------------------------------

/** One step in a playbook. `ask` runs the REAL grounded agent; `checkpoint`
 *  enqueues a HITL review (non-blocking); `synth` marks dossier assembly. */
export type PlaybookStepKind = "ask" | "checkpoint" | "synth";

export interface PlaybookStep {
  id: string;
  kind: PlaybookStepKind;
  title: string;
  /** For `ask` steps: the question handed verbatim to the grounded agent. */
  question?: string;
  /** For `checkpoint` steps: what the reviewer is asked to confirm. */
  prompt?: string;
}

export interface Playbook {
  id: string;
  title: string;
  description: string;
  steps: PlaybookStep[];
  /** Provenance of the definition. Curated playbooks ship in code and are
   *  read-only; `custom` ones were authored by a user (AI-assisted) and are
   *  editable/deletable. Absent is treated as `curated` for back-compat. */
  origin?: "curated" | "custom";
  /** Light audit trail for custom playbooks (reviewer id + epoch millis). */
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** A NOT-YET-SAVED playbook the AI drafted (or the user is editing). Same shape
 *  as a Playbook minus persistence identity, plus schema-lint `warnings` (e.g.
 *  a step whose question names a label not in the graph). Purely advisory — it
 *  never blocks saving, and every answer is still grounded at run time. */
export interface PlaybookDraft {
  title: string;
  description: string;
  steps: PlaybookStep[];
  warnings: string[];
}

/** Response of POST /api/playbooks/draft and /refine. `grounded` is false when
 *  the deterministic skeleton fallback produced the draft (LLM unavailable). */
export interface PlaybookDraftResponse {
  draft: PlaybookDraft;
  grounded: boolean;
}

/** The result of running ONE playbook step. An `ask` step carries the grounded
 *  answer + citations + faithfulness (F1); a `checkpoint` step carries the id of
 *  the HITL queue item it enqueued (the reviewer approves it asynchronously). */
export interface DossierStepResult {
  stepId: string;
  title: string;
  kind: PlaybookStepKind;
  answer?: string;
  citedNodeIds?: string[];
  faithfulness?: FaithfulnessResult | null;
  isFallback?: boolean;
  /** For checkpoint steps: the pending HITL item id awaiting review. */
  pendingItemId?: string;
}

/** The assembled safety dossier — every step's grounded result in order. */
export interface DossierResult {
  playbookId: string;
  title: string;
  steps: DossierStepResult[];
}

/** SSE events streamed by POST /api/playbooks/run. */
export type PlaybookEvent =
  | { type: "step-started"; stepId: string; title: string; kind: PlaybookStepKind }
  | { type: "step-result"; result: DossierStepResult }
  | { type: "done"; dossier?: DossierResult }
  | { type: "error"; message: string };

/** A recurring schedule ("routine") that runs a playbook on a cadence. Presets
 *  map to a 5-field cron string; `cron` is the source of truth either way. A
 *  routine is pure ORCHESTRATION config — it only decides WHEN an existing
 *  playbook runs; the run itself is the unchanged grounded path (checkpoints
 *  still enqueue non-blocking HITL). */
export type RoutineCadence = "hourly" | "daily" | "weekly" | "cron";

export interface PlaybookRoutine {
  id: string;
  playbookId: string;
  cadence: RoutineCadence;
  /** 5-field cron (min hour dom month dow). Presets persist as their cron too. */
  cron: string;
  enabled: boolean;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  /** Last time this routine actually ran (schedule or manual). */
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  /** Pointer into the run history for the most recent run. */
  lastRunId?: string;
  /** Computed on read (NOT persisted): next fire time in epoch ms, or null when
   *  disabled or nothing is due within the look-ahead horizon. */
  nextRunAt?: number | null;
}

/** One recorded execution of a routine — a light audit/history entry surfaced in
 *  the UI. Holds only run metadata (counts + status), never a new answer source. */
export interface RoutineRun {
  id: string;
  routineId: string;
  playbookId: string;
  playbookTitle: string;
  startedAt: number;
  finishedAt?: number;
  status: "ok" | "error";
  /** Whether the scheduler fired it or a user pressed "Run now". */
  trigger: "schedule" | "manual";
  stepCount: number;
  /** How many checkpoint steps enqueued a HITL item this run. */
  checkpointCount: number;
  error?: string;
}

export type StreamEvent =
  | { type: "token"; text: string }
  // F3 routing: the chosen retrieval strategy + the candidate seeds, emitted first
  // so the trace shows "why this strategy". Seeds are candidates-to-verify, never
  // citations (citations still derive only from returned rows).
  | { type: "route"; strategy: RetrievalStrategy; reason: string; seedNodeIds: string[] }
  // Answer-quality (F1/F4): the faithfulness verdict for the grounded answer,
  // emitted once after the answer settles (never on a refusal/fallback).
  | { type: "faithfulness"; result: FaithfulnessResult }
  // Narrator grounding: the node IDs the narration actually cited, validated
  // against the path's allow-list. `ungroundedAttempts` lists any IDs the model
  // tried to cite that are NOT on the path (should always be empty once enforced).
  | { type: "citations"; nodeIds: string[]; ungroundedAttempts?: string[] }
  // F7 literature synthesis: the source-ranked abstracts, emitted first so the UI
  // can show provenance before the narrative streams.
  | { type: "ranked"; ranked: RankedAbstract[] }
  // /ask "show your work" trace — surfaced as first-class UI so the answer is
  // re-runnable, not taken on faith.
  | { type: "step"; label: string } // e.g. "Inspected the live graph schema"
  | { type: "cypher"; query: string } // the read-only Cypher the agent ran
  | { type: "rows"; preview: string } // the rows that query returned (truncated)
  | { type: "done"; isFallback: boolean; reason?: FallbackReason }
  | { type: "subgraph"; payload: GraphPayload } // /ask returns the touched subgraph
  // Generative dashboard (@rnd/dashboards): a validated, grounded DashboardSpec
  // composed after the answer settles. Emitted only on a grounded, cited answer
  // (never a refusal/fallback); the AG-UI bridge translates it into a
  // `render_dashboard` tool call. Additive — /ask consumers that don't know it
  // simply ignore the event.
  | { type: "dashboard"; spec: DashboardSpec; certified?: string[] }
  // Genuine token-streaming: one INCREMENTAL dashboard fragment emitted the
  // moment a widget closes during composition (parse-and-heal). Carries the
  // SAME inert widget shape as `dashboard`, just earlier and one/few widgets at
  // a time; the composer re-injects + re-filters the grounding root on every
  // partial, so a delta can never reference an un-cited node. The final
  // `dashboard` event still fires for idempotent reconciliation.
  | { type: "dashboard-delta"; spec: DashboardSpec }
  // Generative Studio (@rnd/generative): a validated, grounded IR-compiled tile
  // streamed the moment it closes during composition (mirrors dashboard-delta),
  // and the final board once the stream settles + datasets are bound. Grounded
  // gate identical to dashboards — emitted only on a grounded, cited answer.
  | { type: "generative-delta"; tile: GenerativeTile }
  | { type: "generative"; board: GenerativeBoard; datasets: GenerativeDatasets; fieldMenu: FieldMenuEntry[] }
  | { type: "error"; message: string };

/** /api/diag — presenter preflight: is the live path actually ready? */
export interface LiveStatus {
  provider: "api" | "claude-code";
  live: boolean; // overall: can we make a live call right now?
  checks: {
    neo4j: boolean;
    claudeBin: boolean; // `claude --version` succeeded
    uvx: boolean; // `uvx --version` succeeded (needed for /ask MCP)
    apiKey: boolean; // a cloud key is set (api provider)
  };
  detail?: string;
}

export interface NarrateRequest {
  beatId: string; // keys the cached fallback
  pathId?: string; // path to narrate (Beat 2)
}

export interface AskRequest {
  beatId: string;
  question: string;
}

// ---------------------------------------------------------------------------
// FinOps — token/cost observability (read-only; never gates the LLM)
// ---------------------------------------------------------------------------

/** Which LLM call site produced a usage record. Open-ended on purpose so new
 *  surfaces (explain-node, …) can be added without a breaking type change. */
export type FinOpsSurface =
  | "narrate"
  | "ask"
  | "runtime"
  | "explain-node"
  | "litsynth"
  | "dashboard" // generative-dashboard composer (@rnd/dashboards)
  | (string & {});

/** One LLM call's token usage + computed cost. Persisted to finops-ledger.json
 *  (mirrors the threads.json pattern). FinOps is OBSERVABILITY ONLY — recording a
 *  ledger entry never changes what the LLM is allowed to answer. */
export interface FinOpsEntry {
  id: string;
  ts: string; // ISO-8601
  surface: FinOpsSurface;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** True when tokens were estimated from text length (~4 chars/token) because
   *  the call path could not report real usage (e.g. the cloud streaming path). */
  estimated: boolean;
}

/** USD per 1,000,000 tokens for one model (the FinOps price-table row). */
export interface FinOpsModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Editable FinOps config — price table (per model) + budget. Lives in the admin
 *  config so it is hot-editable through the same GET/PUT path as the prompts. */
export interface FinOpsConfig {
  /** Price table keyed by model id (USD per 1M tokens). */
  prices: Record<string, FinOpsModelPrice>;
  /** Fallback price for any model not in the table (so cost is never NaN). */
  defaultPrice: FinOpsModelPrice;
  /** Session/daily budget in USD the running spend is measured against. */
  budgetUsd: number;
  /** Warn threshold as a percentage (0–100) of the budget. */
  warnThresholdPct: number;
}

// ---------------------------------------------------------------------------
// Eval scorecard (F2) — RAGAS-style answer-quality observability
//
// A SECOND observability ledger (mirrors FinOps): one entry per grounded answer
// holding its faithfulness (F1), context-recall (deterministic), and optional
// answer-relevancy (LLM judge; null when the judge is off). Pure observability —
// it never gates the LLM or weakens grounding; it only MEASURES answer quality.
// ---------------------------------------------------------------------------

/** One grounded answer's quality record. `answerRelevancy` is null when the
 *  optional LLM judge is disabled (the default) — the other two are deterministic. */
export interface EvalEntry {
  id: string;
  ts: string; // ISO-8601
  surface: FinOpsSurface;
  /** Truncated question (for the recent-list display; never the full transcript). */
  question: string;
  faithfulness: number; // 0..1
  contextRecall: number; // 0..1
  answerRelevancy: number | null; // 0..1, or null when the judge is off
  citedCount: number;
}

/** GET /api/eval/summary — rolling answer-quality averages + recent entries. */
export interface EvalSummary {
  entryCount: number;
  avgFaithfulness: number; // 0..1
  avgContextRecall: number; // 0..1
  avgAnswerRelevancy: number | null; // 0..1, or null when no judged entries
  recent: EvalEntry[];
}

/** A {tokens,cost} rollup for one breakdown bucket (surface or model). */
export interface FinOpsBreakdownRow {
  key: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  count: number;
}

/** GET /api/finops/summary — live session rollup the meter + dashboard render. */
export interface FinOpsSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  entryCount: number;
  bySurface: FinOpsBreakdownRow[];
  byModel: FinOpsBreakdownRow[];
  budget: {
    budgetUsd: number;
    warnThresholdPct: number;
    pctUsed: number; // 0..(>100) — costUsd / budget * 100
    overThreshold: boolean; // pctUsed >= warnThresholdPct
    overBudget: boolean; // costUsd >= budget
  };
}
