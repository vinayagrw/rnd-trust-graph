<div align="center">

# 🛡️ Use Case 4 — Patient-Safety Risk Radar · End-to-End Demo Script

**A presenter's walk-through for the domain SME: "where are the data relationships unsafe, incomplete or contradictory — before you scale AI?"**

`Built ✅ (UC4 · Safety beat)` · `~7 min live` · `all-real, offline-safe`

[Verdict](#-verdict-is-it-built) · [Coverage map](#-coverage-map-brief--live-app) · [Pre-flight](#-pre-flight-60-seconds) · [The script](#-the-demo-3-acts) · [Sales close](#-the-sales-close) · [Governance](#-governance-angle) · [Honest gaps](#-honest-gaps) · [Under the hood](#-under-the-hood) · [Troubleshooting](#-troubleshooting)

</div>

---

## ✅ Verdict: is it built?

**Yes — literally now.** There is a dedicated **`UC4 · Safety`** beat (the second nav tab) that IS the source brief's *Data-Quality & Patient-Safety Risk Radar*: a dashboard of relationship-level safety risks on trial-subject data, each carrying the seven attributes the source brief asks for, and each opening the **exact multi-hop graph path** the brief describes when clicked.

> [!IMPORTANT]
> This is the patient-safety radar on the **real stack**. The trial subjects are projected into **Neo4j** by `npm run etl` (tagged `:Safety`); SHACL runs over a dedicated **canonical-built safety reasoner** ([`data/rdf/safety.ttl`](../../data/rdf/safety.ttl), [`data/shacl/safety-shapes.ttl`](../../data/shacl/safety-shapes.ttl)); the score's **assessed inventory is read live from Neo4j** (so `/api/safety` fails closed if the DB is down); the LLM **explains each finding grounded** (refuse-if-off-path); and a `/api/safety/audit` endpoint makes the score **independently reproducible**. The FAIR radar (Beat 1) reads a *separate* canonical store, so its "exactly 7 noise nodes" invariant and score are **byte-identical untouched** (proven by test).

The signature drill-down the source brief draws — *Patient → active prescription → but no allergy record → safety rule → risk raised → source systems affected* — **now exists and renders**, hop by hop, tone-coloured (the missing hop struck through in red, the raised risk in red, the source systems named).

---

## 🗺️ Coverage map (brief → live app)

### The 8 risk types the source brief lists

| # | brief risk type | Live? | In the `UC4 · Safety` beat |
|---|---|:--:|---|
| 1 | **Missing allergy status** | ✅ | subject on an active prescription with no allergy record (`SUBJ-201`) |
| 2 | **Conflicting medication records** | ✅ | two active prescriptions for a contraindicated drug pair — anticoagulant + NSAID (`SUBJ-202`) |
| 3 | **Outdated terminology mappings** | ✅ | stale ontology version — also on the FAIR radar (Beat 1) |
| 4 | **Unmapped local codes** | ✅ | a local site code with no terminology mapping (`SUBJ-206`) |
| 5 | **Duplicate patient risk** | ✅ | two subject records share one enrolment id (`SUBJ-205A/B`) |
| 6 | **Referral without follow-up** | ✅ | an open referral with no booked appointment (`SUBJ-204`) |
| 7 | **Lab result too old for pathway** | ✅ | renal-dosed prescription whose required lab is from 2023 (`SUBJ-203`) |
| 8 | **AI answer without sufficient evidence** | ✅ | the Beat-4 grounding guardrail (faithfulness + ungrounded refusal) — cross-linked on the radar |

**All 8 are now covered** — 6 as literal subject-safety findings on the new beat, #3 shared with the FAIR radar, #8 as the live AI guardrail.

### The 7 attributes the source brief says to build — all present, per finding

| brief attribute | Where it shows | Source |
|---|---|---|
| Risk type | the risk label on each card | `SafetyFinding.riskType` |
| Affected patients | the affected subject(s) on the card | `affectedSubjects` |
| Source system | "source systems affected" (last path hop) | `sourceSystems` |
| Severity | P0 / P1 badge | `SAFETY_POLICY[type].severity` |
| Evidence path | the expandable multi-hop graph path | `path[]` |
| Remediation owner | "Owner:" on the card | `SAFETY_POLICY[type].owner` |
| Audit trail | governed HITL apply → change-set → revert (Beat 1 panel) | `/api/hitl/*` |

---

## 🔎 How to validate "readiness 30 / 100" (the QA question)

Don't take the number on faith — it is **reproducible from source**:

1. In the beat, click **"How is this scored?"** — it opens the live audit: the formula
   `round(100 × (10 − 7) / 10) = 30`, the **10 assessed** subjects (read from Neo4j), the **7 unsafe**
   records, and a per-subject table of *which SHACL shape fired* with its raw message.
2. Or hit the endpoint: `curl localhost:8787/api/safety/audit` → `{ overall, assessedCount, unsafeCount, assessed[], unsafe[], perSubject[] }`. Recompute `round(100·(assessedCount−unsafeCount)/assessedCount)` yourself.
3. Or reproduce end-to-end: `npm run etl` re-projects the subjects into Neo4j and `GET /api/safety` returns `30` again — same number from the same source, every run.

> [!TIP]
> The duplicate pair (`SUBJ-205A/205B`) is why it's **7 unsafe but 6 findings**: both records count as
> unsafe, but their two SHACL hits collapse into one finding. The audit exposes both, so the arithmetic ties out.

---

## 🚀 Pre-flight (60 seconds)

From the repo root `rnd-trust-graph/`:

```bash
npm run db:up      # Neo4j (required — the subjects are projected into it)
npm run etl        # projects the FAIR graph AND the :Safety subject graph
npm run dev        # boots BFF (:8787) + web (:5173) together
```

- [ ] Open **http://localhost:5173**, click the **`UC4 · Safety`** tab (second in the nav).
- [ ] Confirm the banner: **Patient-safety readiness 30 / 100 · 6 safety risks across 10 assessed subjects.**

> [!NOTE]
> This radar is now on the **real stack**: the subjects are real Neo4j nodes (so the `/ask` agent can traverse them and the LLM can explain them), and the assessed count is read live from Neo4j — so **Neo4j must be up** (`npm run etl` must have run). Live Claude is optional: the "Explain this finding" button degrades to a deterministic, grounded template if the local `claude` CLI is unavailable.

---

## 🎬 The demo (3 acts)

### Act 1 — The radar (30s): *"Six relationship risks, prioritized, on your subjects."*

1. You're on **`UC4 · Safety`**. Point at the score, then the list.
2. Say: *"This isn't a field-level data-quality report. Every row is a **relationship** problem the graph found on a trial subject — and each carries a severity, the owner who fixes it, and a machine-checkable safety rule."*
3. The six findings, top (P0) first:

| Affected subject | Risk | Severity | Owner |
|---|---|:--:|---|
| `SUBJ-201` | Missing allergy status | 🔴 P0 | Clinical safety lead |
| `SUBJ-202` | Conflicting medication records | 🔴 P0 | Clinical safety lead |
| `SUBJ-203` | Lab result too old for pathway | 🔴 P0 | Clinical safety lead |
| `SUBJ-204` | Referral without follow-up | 🔴 P0 | Care-coordination lead |
| `SUBJ-205A + 205B` | Duplicate subject risk | 🟠 P1 | Data steward |
| `SUBJ-206` | Unmapped local code | 🟠 P1 | Terminology steward |

### Act 2 — Click a risk → the graph path (2 min): *"This is exactly the picture in the brief."*

1. Click **Missing allergy status (`SUBJ-201`)**. The card expands to the **evidence path**.
2. Walk the hops — this is the source brief's drawing, live:
   - **Trial subject 201** →
   - `HAS_PRESCRIPTION` **has an active prescription** — Apixaban (anticoagulant) →
   - ~~**but has no allergy record on file**~~ *(the gap, struck through in red)* →
   - **safety rule requires:** a subject on an active prescription must have an allergy record →
   - **→ patient-safety risk raised** (P0) →
   - **source systems affected:** Veeva Vault CTMS · SAP eRx / dosing system.
3. Say: *"The brief asked for `Patient → prescription → no allergy → rule → risk → sources`. That's this, hop for hop — and it's not a slide, it's a live SHACL rule firing on an RDF graph. The `rule:` and expected-vs-actual line below make it auditable."*
4. Click one more to show range — **Conflicting medication (`SUBJ-202`)** (two prescriptions, contraindicated drugs) or **Lab too old (`SUBJ-203`)** (a 2023 lab behind a renal-dosing decision).

> [!TIP]
> Every finding names its **source systems** on the last hop — that's the source brief's "source systems affected," and it's what makes the risk *actionable* (the steward knows exactly which system to fix).

### Act 3 — Govern the fix (90s): *"Every remediation is authorized and reversible."*

The safety radar surfaces the recommended **remediation + owner** on each expanded card. To show the *governed* fix loop, use the existing Beat-1 HITL panel (the same authorized writer backs both):

1. Switch to **Beat 1 (Radar)** → **⚖ Open HITL mutate & revert**.
2. Approve a pending fix → the change is applied through the **authorized graph writer** (Neo4j + RDF), logged, attributed; **Revert** restores exact prior state.
3. Say: *"Finding a safety risk is half the job. This is the other half — a remediation that's authorized, attributed and reversible. That's the difference between a dashboard and a governed system."*
4. Close on the **🛡️ AI-safety guardrail** note at the bottom of the safety radar: *"…and the 8th risk in the brief — the AI answering without evidence — is closed in Beat 4: the agent refuses to answer past the graph."*

---

## 💬 The sales close

Land the source brief's exact line, now earned by what they just saw:

> *"Before you scale AI or analytics, you need to know where the underlying data **relationships** are unsafe, incomplete or contradictory. You've just watched the graph find six of those on your trial subjects, prove each against a formal safety rule with the exact evidence path, name the source systems to fix — and the AI refuse to answer past the evidence. That's the readiness gate that goes **in front of** your models."*

Why it impresses: it links data quality to **patient safety and AI-readiness**, not a generic quality score — and every risk on screen was a real relationship gap, backed by a rule and a traceable path.

---

## 🏛️ Governance angle

The source brief cites **DCB0129** (health-IT *manufacturers*) and **DCB0160** (*deploying* organisations) — NHS clinical-safety assurance. For a pharma R&D / PV audience, name the **equivalent** regimes:

| NHS clinical | pharma R&D / PV equivalent |
|---|---|
| DCB0129 / DCB0160 clinical safety case | **GxP** data integrity · **ALCOA+** (every safety node carries the source/timestamp/license triad) |
| Health-IT risk management | **EMA GVP** (Good Pharmacovigilance Practices) |
| Audit & assurance | **21 CFR Part 11** (attributable, reversible records — the HITL change-set log) |
| Provenance / traceability | **W3C SHACL + PROV-O** (the rules are SHACL; provenance is standards-based) |

---

## 🧭 Honest gaps

Say these plainly if asked — straight talk on a PoC builds trust:

- **The data is a small, synthetic, PHI-free fixture** — 10 trial subjects engineered so each risk fires exactly once (plus 3 clean controls that prove the rules are specific, not blanket). It demonstrates the *engine*; production would point the same shapes at real subject data.
- **"Affected patients" is per-finding, not a fleet-wide roll-up** — each finding names its subject(s); it doesn't yet aggregate "N subjects affected across the study."
- **Remediation is demonstrated via the Beat-1 HITL loop**, not yet a one-click fix on the safety card itself — the governed writer is shared, so wiring a direct "Remediate" button is a small follow-up.

---

## 🔧 Under the hood

On the real stack, but isolated from the FAIR radar's reasoner so nothing regresses:

- **Data:** [`data/rdf/safety.ttl`](../../data/rdf/safety.ttl) — trial-subject A-Box (the committed canonical source, analogous to `dataset.generated.ttl`).
- **Rules:** [`data/shacl/safety-shapes.ttl`](../../data/shacl/safety-shapes.ttl) — six `sh:sparql` NodeShapes (one per risk).
- **Reasoner:** `buildSafetyReasoner()` / `getSafetyReasoner()` in [`bff/src/reasoner/service.ts`](../../bff/src/reasoner/service.ts) — a **second** canonical-built store (separate from the FAIR one → FAIR byte-identical).
- **Neo4j projection:** `projectSafetyToNeo4j()` in [`bff/src/etl/project.ts`](../../bff/src/etl/project.ts) — MERGEs the subjects into Neo4j tagged `:Safety` (excluded from the FAIR canvas by `getFullGraph`).
- **Service:** [`bff/src/safety/service.ts`](../../bff/src/safety/service.ts) — SHACL over the safety reasoner builds each finding + path; the assessed inventory is read from **Neo4j**.
- **Grounded explain:** [`bff/src/safety/explain.ts`](../../bff/src/safety/explain.ts) — reuses the `explainNode` discipline (allow-list = the finding's path + neighbours; refuse-if-off-list; deterministic fallback).
- **Endpoints:** `GET /api/safety` → `SafetyReport`; `GET /api/safety/audit` → `SafetyAudit` (reproducible score); `POST /api/safety/explain {subjectId}` → grounded SSE.
- **Tests:** [`bff/src/safety/service.test.ts`](../../bff/src/safety/service.test.ts) — hermetic SHACL-logic assertions + Neo4j-backed score/audit (30/100); [`bff/src/etl/project.test.ts`](../../bff/src/etl/project.test.ts) — subjects projected + FAIR canvas exclusion.
- **UI:** [`web/src/beats/SafetyRadarBeat.tsx`](../../web/src/beats/SafetyRadarBeat.tsx) — cards, "How is this scored?" audit, per-card "Explain this finding".

---

## 🩺 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `UC4 · Safety` tab shows nothing | BFF not up | confirm `npm run dev` printed `[bff] listening on :8787` |
| Score ≠ 30 / findings ≠ 6 | `safety.ttl` was edited | revert the file, or re-check `bff/src/safety/service.test.ts` |
| Path won't expand | — | click the card header row (the caret flips ▸ → ▾) |
| Act 3 HITL panel empty | prior demo left approvals applied | revert any `applied` change-set, or `npm run etl` |
| Port is `:5174` not `:5173` | `:5173` busy | use whatever Vite prints; the `/api` proxy still works |

---

<div align="center">
<sub>The <code>UC4 · Safety</code> beat implements the source brief Use Case 4 literally, isolated from the FAIR radar (Beat 1). All remediation goes through the authorized HITL writer — never the read-only path. Pair with <a href="../../UC4-VALIDATION.md">UC4-VALIDATION.md</a> and <a href="../../RUNBOOK.md">RUNBOOK.md</a>.</sub>
</div>
