<div align="center">

# 🛡️ Use Case 4 — Data-Quality & Patient-Safety Risk Radar

**Step-by-step validation guide for the pharma R&D Trust Graph PoC (Beat 1 = Radar)**

`Risk type` · `Affected records` · `Source system` · `Severity` · `Evidence path` · `Remediation owner` · `Audit trail`

[Goal](#-goal) · [Prerequisites](#-prerequisites) · [Backend check](#1--backend-check-data-contract) · [UI walkthrough](#2--ui-walkthrough-beat-1--radar) · [Audit-trail proof](#3--audit-trail-proof-the-only-subtle-one) · [Result matrix](#-result-matrix) · [Troubleshooting](#-troubleshooting)

</div>

---

## 🎯 Goal

Confirm — with evidence, not assertion — that the seven UC-4 attributes the source brief asks for are **really** produced by the running app, and that the human-in-the-loop (HITL) audit trail is genuinely persisted and reversible.

When you finish this guide you will have seen, with your own eyes: 7 flagged nodes each carrying risk-type + affected-record + source-system + severity + evidence-path + owner, and one defect resolved through a governed, **revertible** change-set.

> [!IMPORTANT]
> The **audit trail has two surfaces, and only one persists.** The real, reversible log is the **HITL panel** (`Approve → ChangeSet → Revert`). The Accept / Reject / Escalate buttons *inline on each radar row* are a **prototype** — local React state that never mutates the graph. Demo and validate against the HITL panel, not the inline buttons.

---

## 📋 Prerequisites

| Need | Value |
|---|---|
| Repo root | `<repo root>` |
| Frontend (Vite) | `web/` → `http://localhost:5173` (may shift to `:5174`) |
| BFF (Fastify) | `bff/` → `http://localhost:8787` |
| Start everything | `npm run dev` (root) — boots BFF + web together |

> [!NOTE]
> The browser checks below call `/api/…` on the **app origin** (e.g. `http://localhost:5174/api/risk`), which Vite proxies to the BFF. Calling `http://localhost:8787` directly from the page is blocked by CORS — always use the relative `/api` path.

---

## 1. ✅ Backend check (data contract)

Proves the SHACL → RiskFinding pipeline and the HITL apply/revert round-trip at the unit level.

```bash
cd /path/to/rnd-trust-graph
npm test -w bff
```

**✓ Checkpoint:** you should see **`80 passed (80)`** (or higher) — including the HITL apply/revert and SHACL-conformance suites.

---

## 2. 🖥️ UI walkthrough (Beat 1 = Radar)

1. Open the app and select the **Radar** beat (leftmost tab).
2. **✓ Checkpoint — 7 flagged nodes.** Each card shows, in one row:
   - a **severity badge** (P0 / P1 / P2 colour),
   - the **`nodeId`** (the *affected record*),
   - the **flag label** (the *risk type*),
   - the **Owner** (remediation owner, from `RISK_POLICY`).
3. **✓ Checkpoint — "Why flagged".** The first card expands the **evidence path**: the SHACL rule name + an expected-vs-actual line (e.g. *"expected sourceSystem / timestamp / license minCount 1, found 0"*).
4. Click a flagged node (e.g. **`TGT-NOPROV`**) → the provenance drawer opens showing the source-system / ALCOA+ detail for that node.

The seven baseline flags you should see:

| Node | Risk type (flag) | Severity rule |
|---|---|---|
| `AE-CONFLICT` | conflicting-annotation | ConflictingAnnotationShape |
| `CON-STALE` | stale-ontology-version | OntologyVersionShape |
| `DRUG-ORPHAN` | missing-cross-source-link | DrugShape |
| `STAT-DUP-A` | duplicate-record | DuplicateRecordShape |
| `STAT-DUP-B` | duplicate-record | DuplicateRecordShape |
| `STAT-NOFOLLOWUP` | missing-followup | MissingFollowupShape |
| `TGT-NOPROV` | missing-provenance | NodeProvenanceShape |

---

## 3. 🔄 Audit-trail proof (the only subtle one)

This is the row that needs care. Validate it through the **HITL panel**, end to end.

1. Open the **HITL panel** (Human-in-the-Loop — *mutate & revert*).
2. In **Pending queue**, click **Approve** on *"Attach provenance (TGT-NOPROV)"*.
3. **✓ Checkpoint — defect resolved + audited:**
   - Return to **Radar** → `TGT-NOPROV` **drops off** (now **6** flagged).
   - Open `TGT-NOPROV` in the drawer → a **"Reviewed by"** block now appears.
   - Back in the HITL panel → **Audit log** shows a new `applied` change-set for `TGT-NOPROV`.
4. In the Audit log, click **Revert** on that change-set.
5. **✓ Checkpoint — reversible:** `TGT-NOPROV` **re-flags** (back to **7**), "Reviewed by" clears, and the change-set status flips to `reverted`.

> [!WARNING]
> Only **Approve** persists. `Reject` / `Escalate` return `{ mutated: false }` and are recorded as a toast only — they do **not** create a change-set. This is by design (the governed writer applies approvals; rejections are logged decisions, not graph writes).

### Every flag is now human-resolvable

The pending queue carries a governed, revertible fix for **all seven** flagged nodes — pick any row, Approve → the radar drops it, Revert → it returns. Each fix mutates the real graph (Neo4j + RDF) through the authorized writer and clears the radar flag via the reversible overlay.

| Pending item | Flag (category) | Node(s) | What Approve does |
|---|---|---|---|
| `attach-tgt-noprov-provenance` | missing-provenance (gap) | TGT-NOPROV | attaches the ALCOA+ provenance triad |
| `resolve-ae-conflict` | conflicting-annotation (conflict) | AE-CONFLICT | sets status refuted → confirmed |
| `link-drug-orphan-target` | missing-cross-source-link (gap) | DRUG-ORPHAN | links the orphan drug → TGT-BTK (`TARGETS`) |
| `review-stat-nofollowup` | missing-followup (gap) | STAT-NOFOLLOWUP | records the review (escalated → reviewed) |
| `reconcile-stat-duplicate` | duplicate-record (conflict) | STAT-DUP-A **+** STAT-DUP-B | re-codes the duplicate import; clears **both** flags |
| `refresh-con-stale-ontology` | stale-ontology-version (gap) | CON-STALE | refreshes ontologyVersion 2019-01 → 2024-02 |

> [!TIP]
> `reconcile-stat-duplicate` is the one fix that resolves **two** flagged nodes at once (the duplicate pair), so approving it drops the radar from 7 → 5; reverting restores both.

<details>
<summary><strong>Optional — verify the same round-trip from the browser console</strong> (no clicking)</summary>

Paste into the browser devtools console on the app tab:

```js
// 1) Approve via the same endpoint the UI calls
await fetch('/api/hitl/apply', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ itemId: 'attach-tgt-noprov-provenance', decision: 'approve' })
}).then(r => r.json());

// 2) Confirm the radar dropped TGT-NOPROV (count flagged nodes)
const risk = await fetch('/api/risk').then(r => r.json());
console.log('flagged:', risk.findings.filter(f => f.flags.length).map(f => f.nodeId));

// 3) Find the change-set id, then revert it
const { changeSets } = await fetch('/api/hitl/changesets').then(r => r.json());
const cs = changeSets.find(c => c.targetNodeId === 'TGT-NOPROV' && c.status === 'applied');
await fetch('/api/hitl/revert', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ changeSetId: cs.id })
}).then(r => r.json());

// 4) Confirm TGT-NOPROV is flagged again (back to 7)
const after = await fetch('/api/risk').then(r => r.json());
console.log('flagged after revert:', after.findings.filter(f => f.flags.length).map(f => f.nodeId));
```

Expected: step 2 omits `TGT-NOPROV`; step 4 includes it again; `risk.overall === 98`.

</details>

---

## 📊 Result matrix

What "pass" looks like for each of the seven UC-4 attributes:

| # | UC-4 attribute | Pass criterion | Source in code |
|---|---|---|---|
| 1 | **Risk type** | flag label on each card | `RiskFlag` union (7) · `FlaggedList` |
| 2 | **Affected records** | `nodeId` shown per flag | `finding.nodeId` |
| 3 | **Source system** | ALCOA+ provenance in drawer | `Provenance.sourceSystem` |
| 4 | **Severity** | P0/P1/P2 badge | `RISK_POLICY` · `SEVERITY_TONE` |
| 5 | **Evidence path** | rule + expected-vs-actual | `finding.reasons[]` |
| 6 | **Remediation owner** | owner line per flag | `RISK_POLICY[flag].owner` |
| 7 | **Audit trail** | Approve → log → Revert works | `HitlPanel` · `/api/hitl/*` |

> [!TIP]
> Pair the check with the source brief: Use Case 4 ("What to build") asks for risk type, affected patients, source system, severity, evidence path, recommended remediation owner, and audit trail — that is exactly the seven rows above.

---

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Failed to fetch` in console | called `http://localhost:8787` directly | use the relative `/api/…` path (Vite proxy) |
| Radar shows ≠ 7 flags | a prior demo approval wasn't reverted | revert any `applied` change-set in the HITL Audit log |
| "Reviewed by" never appears | approved the wrong item / inline prototype button | use the **HITL panel** Approve, not the inline radar button |
| `Reject`/`Escalate` "did nothing" | by design — they don't mutate | only **Approve** persists; this is expected |
| Port is `:5174` not `:5173` | `:5173` was busy | use whatever port Vite prints; `/api` proxy still works |

---

<div align="center">
<sub>Beat 1 (Radar) implements the source brief Use Case 4 composite. Backend unchanged by UI work — all writes go through the authorized HITL writer, never the read-only Cypher/MCP path.</sub>
</div>
