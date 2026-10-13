/**
 * The HITL pending queue — demo-pinned governance scenarios covering every flag
 * the readiness radar raises.
 *
 * Each item is a proposed governed change a reviewer can Approve / Reject /
 * Escalate. Approving applies the forwardOps (mutating BOTH the Neo4j projection
 * via the authorized writer AND the canonical RDF store); reverting later replays
 * the inverseOps to restore byte-identical prior state. The forward/inverse ops
 * are precomputed and exact inverses of each other — that is what makes the
 * round-trip provable in tests.
 *
 *   (a) promote the statistical disproportionality candidate to a human-approved
 *       mechanistic edge on the canvas (DRUG-CPI → AE-MYOCARDITIS);
 *   (b) resolve AE-CONFLICT (refuted → confirmed) so readiness rises;
 *   (c) attach provenance to TGT-NOPROV so the radar stops flagging it;
 *   (d) link DRUG-ORPHAN to its biological target (missing-cross-source-link);
 *   (e) record follow-up review on STAT-NOFOLLOWUP (missing-followup);
 *   (f) reconcile the STAT-DUP-A/STAT-DUP-B duplicate (clears BOTH flags);
 *   (g) refresh CON-STALE's stale ontology version.
 *
 * (d)–(g) make every remaining flagged node human-resolvable + revertible; the
 * defect nodes themselves are unchanged (still the 7-flag baseline) — these only
 * add their fixes.
 */
import type { HitlPendingItem, Provenance } from "@rnd/shared";
import { getEnqueued } from "./enqueue.js";

/** Curated provenance attached to TGT-NOPROV on approval of scenario (c). Synthetic,
 *  PHI-free — the same ALCOA+ triad shape every other node carries. */
export const TGT_NOPROV_PROVENANCE: Provenance = {
  sourceSystem: "UniProt (human-curated)",
  timestamp: "2026-06-29T00:00:00Z",
  license: "CC-BY-4.0",
  ontologyVersion: "UniProt 2026-06",
};

/** Build the three pending items fresh (no shared mutable state), then append any
 *  enqueued grounded-conclusion review requests from the file-backed queue. */
export function getPendingItems(): HitlPendingItem[] {
  return [
    // (a) Promote the statistical candidate to a human-approved edge.
    {
      id: "promote-cpi-myocarditis",
      title: "Promote disproportionality candidate (DRUG-CPI → AE-MYOCARDITIS)",
      description:
        "The statistical signal gc-disproportionality (STAT-MYO-CPI PRR) suggests a causal " +
        "link between the checkpoint inhibitor and immune-related myocarditis. A reviewer can " +
        "promote it to a governed HUMAN_APPROVED edge on the graph.",
      effect:
        "Approve: adds a DRUG-CPI –HUMAN_APPROVED→ AE-MYOCARDITIS edge (appears on the canvas). " +
        "Revert: removes that edge.",
      targetNodeId: "DRUG-CPI",
      forwardOps: [
        { op: "addEdge", source: "DRUG-CPI", target: "AE-MYOCARDITIS", kind: "HUMAN_APPROVED" },
      ],
      inverseOps: [
        { op: "removeEdge", source: "DRUG-CPI", target: "AE-MYOCARDITIS", kind: "HUMAN_APPROVED" },
      ],
    },

    // (b) Resolve AE-CONFLICT: refuted → confirmed, clear the conflict flag.
    {
      id: "resolve-ae-conflict",
      title: "Resolve conflicting annotation (AE-CONFLICT)",
      description:
        "AE-CONFLICT reuses code OAE_0001489 with status \"refuted\", which SHACL flags as a " +
        "conflicting annotation. A reviewer who has adjudicated it can confirm the node.",
      effect:
        "Approve: sets AE-CONFLICT status refuted → confirmed and clears its " +
        "conflicting-annotation flag (readiness rises). Revert: restores refuted + the flag.",
      targetNodeId: "AE-CONFLICT",
      forwardOps: [
        { op: "setProp", nodeId: "AE-CONFLICT", prop: "status", value: "confirmed" },
        { op: "setFlagResolved", nodeId: "AE-CONFLICT", flag: "conflicting-annotation" },
      ],
      inverseOps: [
        { op: "setProp", nodeId: "AE-CONFLICT", prop: "status", value: "refuted" },
        { op: "clearFlagResolved", nodeId: "AE-CONFLICT", flag: "conflicting-annotation" },
      ],
    },

    // (c) Attach provenance to TGT-NOPROV, clear the missing-provenance flag.
    {
      id: "attach-tgt-noprov-provenance",
      title: "Attach provenance (TGT-NOPROV)",
      description:
        "TGT-NOPROV carries no ALCOA+ provenance triad, so SHACL flags it as missing provenance. " +
        "A reviewer can attach a curated provenance record.",
      effect:
        "Approve: attaches a sourceSystem/timestamp/license/ontologyVersion provenance record to " +
        "TGT-NOPROV and clears its missing-provenance flag (radar stops flagging it). " +
        "Revert: removes the provenance and re-flags it.",
      targetNodeId: "TGT-NOPROV",
      forwardOps: [
        { op: "addProvenance", nodeId: "TGT-NOPROV", provenance: TGT_NOPROV_PROVENANCE },
        { op: "setFlagResolved", nodeId: "TGT-NOPROV", flag: "missing-provenance" },
      ],
      inverseOps: [
        { op: "removeProvenance", nodeId: "TGT-NOPROV", provenance: TGT_NOPROV_PROVENANCE },
        { op: "clearFlagResolved", nodeId: "TGT-NOPROV", flag: "missing-provenance" },
      ],
    },

    // (d) GAP — DRUG-ORPHAN has no biological-target link, so SHACL flags it as a
    // missing cross-source link. A curator links the investigational compound to
    // its annotated primary target (TGT-BTK, an existing BiologicalTarget).
    {
      id: "link-drug-orphan-target",
      title: "Link orphan drug to its target (DRUG-ORPHAN → TGT-BTK)",
      description:
        "DRUG-ORPHAN (investigational compound JNJ-XR) carries no rtg:TARGETS edge, which SHACL " +
        "flags as a missing cross-source link. A curator who has confirmed the annotation can link " +
        "it to its biological target.",
      effect:
        "Approve: adds a DRUG-ORPHAN –TARGETS→ TGT-BTK edge (appears on the canvas) and clears the " +
        "missing-cross-source-link flag (radar stops flagging it). Revert: removes the edge and re-flags it.",
      targetNodeId: "DRUG-ORPHAN",
      forwardOps: [
        { op: "addEdge", source: "DRUG-ORPHAN", target: "TGT-BTK", kind: "TARGETS" },
        { op: "setFlagResolved", nodeId: "DRUG-ORPHAN", flag: "missing-cross-source-link" },
      ],
      inverseOps: [
        { op: "removeEdge", source: "DRUG-ORPHAN", target: "TGT-BTK", kind: "TARGETS" },
        { op: "clearFlagResolved", nodeId: "DRUG-ORPHAN", flag: "missing-cross-source-link" },
      ],
    },

    // (e) GAP — STAT-NOFOLLOWUP is an escalated disproportionality signal with no
    // follow-up review, which SHACL flags as missing-followup. A signal reviewer who
    // has triaged it records the review (status escalated → reviewed).
    {
      id: "review-stat-nofollowup",
      title: "Record follow-up review (STAT-NOFOLLOWUP)",
      description:
        "STAT-NOFOLLOWUP is an escalated FAERS disproportionality signal with no recorded follow-up, " +
        "which SHACL flags as missing-followup. A PV signal reviewer who has triaged it can record the review.",
      effect:
        "Approve: sets STAT-NOFOLLOWUP status escalated → reviewed and clears the missing-followup flag " +
        "(readiness rises). Revert: restores escalated + the flag.",
      targetNodeId: "STAT-NOFOLLOWUP",
      forwardOps: [
        { op: "setProp", nodeId: "STAT-NOFOLLOWUP", prop: "status", value: "reviewed" },
        { op: "setFlagResolved", nodeId: "STAT-NOFOLLOWUP", flag: "missing-followup" },
      ],
      inverseOps: [
        { op: "setProp", nodeId: "STAT-NOFOLLOWUP", prop: "status", value: "escalated" },
        { op: "clearFlagResolved", nodeId: "STAT-NOFOLLOWUP", flag: "missing-followup" },
      ],
    },

    // (f) CONFLICT — STAT-DUP-A and STAT-DUP-B are two distinct SignalStats sharing
    // identity code FAERS-DUP-0001, which SHACL flags on BOTH as a duplicate record.
    // A data steward reconciles the duplicate by re-coding one import; both flags clear.
    {
      id: "reconcile-stat-duplicate",
      title: "Reconcile duplicate signal (STAT-DUP-A / STAT-DUP-B)",
      description:
        "STAT-DUP-A and STAT-DUP-B are two distinct imports sharing code FAERS-DUP-0001, which SHACL " +
        "flags as a duplicate record on both. A data steward reconciles them by re-coding the duplicate import.",
      effect:
        "Approve: re-codes STAT-DUP-B (FAERS-DUP-0001 → FAERS-DUP-0001-DEDUP) and clears the " +
        "duplicate-record flag on BOTH nodes. Revert: restores the shared code and both flags.",
      targetNodeId: "STAT-DUP-B",
      forwardOps: [
        { op: "setProp", nodeId: "STAT-DUP-B", prop: "code", value: "FAERS-DUP-0001-DEDUP" },
        { op: "setFlagResolved", nodeId: "STAT-DUP-A", flag: "duplicate-record" },
        { op: "setFlagResolved", nodeId: "STAT-DUP-B", flag: "duplicate-record" },
      ],
      inverseOps: [
        { op: "setProp", nodeId: "STAT-DUP-B", prop: "code", value: "FAERS-DUP-0001" },
        { op: "clearFlagResolved", nodeId: "STAT-DUP-A", flag: "duplicate-record" },
        { op: "clearFlagResolved", nodeId: "STAT-DUP-B", flag: "duplicate-record" },
      ],
    },

    // (g) GAP — CON-STALE carries ontologyVersion 2019-01, before the configured
    // staleBeforeYear (2023), which SHACL flags as a stale ontology version. An
    // ontology steward refreshes it to a current vocabulary release.
    {
      id: "refresh-con-stale-ontology",
      title: "Refresh stale ontology version (CON-STALE)",
      description:
        "CON-STALE (Cardiotoxicity) is coded against ontologyVersion 2019-01, which predates the " +
        "configured cutoff and SHACL flags as a stale ontology version. An ontology steward refreshes " +
        "it to a current release.",
      effect:
        "Approve: sets CON-STALE ontologyVersion 2019-01 → 2024-02 and clears the stale-ontology-version " +
        "flag (radar stops flagging it). Revert: restores 2019-01 + the flag.",
      targetNodeId: "CON-STALE",
      forwardOps: [
        { op: "setProp", nodeId: "CON-STALE", prop: "ontologyVersion", value: "2024-02" },
        { op: "setFlagResolved", nodeId: "CON-STALE", flag: "stale-ontology-version" },
      ],
      inverseOps: [
        { op: "setProp", nodeId: "CON-STALE", prop: "ontologyVersion", value: "2019-01" },
        { op: "clearFlagResolved", nodeId: "CON-STALE", flag: "stale-ontology-version" },
      ],
    },
    ...getEnqueued(),
  ];
}

/** Look up one pending item by id (used by POST /api/hitl/apply on approve). */
export function getPendingItem(id: string): HitlPendingItem | undefined {
  return getPendingItems().find((i) => i.id === id);
}
