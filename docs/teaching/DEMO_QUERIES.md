# Demo chat queries — user stories for the walkthrough

> A set of ready-to-paste questions for **Beat 4 · Conversation**, each framed as a user story so you
> can narrate *who* is asking and *why*. Every query is answerable from the graph, so the agent cites
> real nodes — except the two clearly-labelled **refusal** examples, which are there on purpose: they
> prove the app won't hallucinate. Pair these with [`DISPROPORTIONALITY.md`](./DISPROPORTIONALITY.md)
> and [`safety-dossier-story.html`](./safety-dossier-story.html). For the split-view Studios, see
> [`STUDIO_GUIDE.md`](./STUDIO_GUIDE.md) — grounded prompts for Dashboard & Generative Studio.

**How to read each card:** *User story* → *Query to paste* → *What the app does* → *Teaching point*.

---

## 1. Signal triage — the PV analyst

> **As a** pharmacovigilance signal analyst, **I want to** see which adverse events for the anti-PD-1
> checkpoint inhibitor cross the disproportionality threshold, **so that** I can prioritise what to
> investigate this week.

**Query:**
> "Which adverse events for the anti-PD-1 checkpoint inhibitor show disproportionality above the signal
> threshold? List their PRR, ROR and case counts."

**What the app does:** runs Cypher over the `SUSPECTED_IN` / `HAS_STAT` edges, returns myocarditis,
colitis and hypothyroidism with their `SignalStat` values, cites each `STAT-*` node, and shows a
faithfulness badge.

**Teaching point:** grounded triage — the numbers are cited, not asserted. Follow up with *"which of
these has the strongest independent confirmation?"* to set up the magnitude-vs-confirmation story.

---

## 2. Mechanism — the translational scientist

> **As an** R&D translational scientist, **I want to** understand *why* myocarditis is mechanistically
> linked to this drug, **so that** I can judge biological plausibility before escalating.

**Query:**
> "Why is myocarditis mechanistically linked to the checkpoint inhibitor? Show the target and pathway."

**What the app does:** returns the `DRUG-CPI —TARGETS→ TGT-PDCD1 —IN_PATHWAY→ PW-CHECKPOINT` chain and
the `CANDIDATE_SIGNAL` entailment, with the inference trace (Explanation beat visualises it hop by hop).

**Teaching point:** the signal is more than a statistic — the reasoner *entails* a candidate mechanism
via an OWL property chain, and shows its work.

---

## 3. Evidence sufficiency (Known / Missing / Conflicting) — the medical safety reviewer

> **As a** medical safety reviewer, **I want to** know what evidence supports the myocarditis signal
> and what is still missing, **so that** I know whether it's ready for a regulatory submission.

**Query:**
> "What evidence supports the myocarditis signal, and what is missing or conflicting?"

**What the app does:** the AnswerCanvas buckets cited nodes into **Known** (FAERS stat, literature,
FDA label, registry), **Missing** (gaps the agent names), and **Conflicting** (contradictory
evidence), with an explicit "bounded to N cited nodes" boundary.

**Teaching point:** the app is honest about gaps — it never fabricates a "Missing" item, and the
confidence boundary is explicit.

---

## 4. Provenance & audit — the data steward

> **As a** data steward, **I want to** verify the source, license and review status of the myocarditis
> FAERS statistic, **so that** I can trust it in a 21 CFR Part 11 context.

**Query:**
> "What is the source, license and last reviewer for the myocarditis FAERS statistic?"

**What the app does:** answers from the node's metadata and points to the PROV-O dossier (click
`STAT-MYO-CPI` → source system, timestamp, license, `HUMAN_APPROVED` edges).

**Teaching point:** every node carries ALCOA+ provenance; trust is inspectable, not asserted.

---

## 5. Literature synthesis (F7) — the safety physician

> **As a** safety physician, **I want to** a source-ranked summary of the published evidence for
> CPI-induced myocarditis with citations, **so that** I can cite primary literature in my assessment.

**Query:**
> "Summarise the literature evidence for checkpoint-inhibitor myocarditis, with citations."

**What the app does:** ranks the relevant `LiteratureAbstract` nodes (regulatory > trial > journal,
then recency) and synthesises with every inline `[LIT-PMID-…]` enforced ⊆ the supplied abstracts.

**Teaching point:** synthesis with **enforced** citations — an off-list reference refuses the narrative
and falls back to a deterministic restatement. (Note: F7's UI is a stub not yet wired to a beat; demo
it via `POST /api/litsynth` or narrate the capability.)

---

## 6. Competitive context (F8) — the portfolio strategist

> **As a** portfolio strategist, **I want to** see how our checkpoint-inhibitor programme sits against
> competitor pipelines, **so that** I can frame the differentiation story.

**Query / action:** toggle the **Competitive** overlay (header button or ⌘K), then ask
> "Which competitor pipelines compete with our checkpoint inhibitor?"

**What the app does:** renders the synthetic `EXT-PIPE-*` nodes (dashed, grey) merged client-side.

**Teaching point (say this out loud):** these competitor nodes are **synthetic and clearly labelled** —
the grounded agent can *never* cite one, because their ids never enter Neo4j or the citation allow-list.
Great for showing the trust boundary between "real, citable" and "illustrative overlay".

---

## 7. Refusal on purpose — off-graph clinical question

> **As a** curious stakeholder, **I want to** ask something the graph doesn't contain, **so that** I can
> see whether the system makes things up.

**Query:**
> "What corticosteroid dose is recommended for checkpoint-inhibitor myocarditis?"

**What the app does:** the graph has no dosing/treatment nodes, so the agent returns the configured
`NOT_IN_GRAPH` refusal and **draws nothing** — empty canvas, no diagrams.

**Teaching point:** the money moment for a trust demo. A generic chatbot would confidently invent a
dose; this one refuses because it can't cite it. Contrast this directly with query #1 (which *is*
answerable) to make the boundary vivid.

---

## 8. Refusal on purpose — out-of-scope entity

> **As a** skeptic, **I want to** ask about a drug that isn't in the dataset, **so that** I can confirm
> the agent won't confabulate about entities it doesn't know.

**Query:**
> "What are the adverse events for aspirin?"

**What the app does:** aspirin isn't a node in this synthetic dataset → `NOT_IN_GRAPH` refusal.

**Teaching point:** grounding is about *what's served*, not *what the model knows*. Even a household
drug gets refused if it isn't in the graph.

---

## Suggested demo arc (5 minutes)

1. **#1 Signal triage** → the numbers, cited.
2. **#3 Evidence sufficiency** → Known/Missing/Conflicting, honest gaps.
3. **#7 Refusal** → the app won't invent a dose.
4. **F5 playbook Run** → the whole thing orchestrated end-to-end (see `safety-dossier-story.html`).
5. **#4 Provenance** → click a cited node, show the PROV-O dossier + reviewer sign-off.

The through-line: *every claim is either traceable to a node, or refused.* That's the pitch.
