# R&D Trust Graph — Features Teaching Guide (Phases 1–3)

> A single, honest reference to **every feature** in the app: the four demo beats, the Trust
> Workbench redesign elements, and the eight competitor-inspired features **F1–F8** grouped by the
> phase in which they shipped. For each feature you get: **what it does**, **where to click**, **the
> key files**, **the API**, and an **honest caveat**.
>
> Companion pages:
> - [`features-guide.html`](./features-guide.html) — a clickable, phase-filtered feature map with an
>   animated view of where each feature sits *around* the grounded answer path.
> - [`safety-dossier-story.html`](./safety-dossier-story.html) — a narrated visual story of the F5
>   safety-dossier playbook (disproportionality charts, mechanistic chain, evidence provenance).
> - [`DISPROPORTIONALITY.md`](./DISPROPORTIONALITY.md) — what PRR / ROR / χ² / CI mean and how the app
>   uses them.
> - [`DEMO_QUERIES.md`](./DEMO_QUERIES.md) — ready-to-paste chat queries as user stories for the
>   walkthrough.
> - [`STUDIO_GUIDE.md`](./STUDIO_GUIDE.md) — Dashboard Studio & Generative Studio: the split view,
>   the pop-out canvas, grounded sample prompts, and the generative roadmap.
>
> _Accurate as of the codebase on 2026-06-30. Paths are relative to `rnd-trust-graph/`._

---

## Table of contents

1. [Quick start](#quick-start)
2. [The mental model — why this app exists](#the-mental-model)
3. [The four beats](#the-four-beats)
4. [Trust Workbench elements](#trust-workbench-elements)
5. [Feature tour F1–F8 (by phase)](#feature-tour-f1f8)
6. [Grounding & safety invariants](#grounding--safety-invariants)
7. [Reference — header buttons & ⌘K](#reference--header-buttons--k)
8. [Reference — HTTP endpoints](#reference--http-endpoints)
9. [Honest scope](#honest-scope)

---

## Quick start

**Prerequisites**

- Node ≥ 20
- Docker (for Neo4j; optional Fuseki)
- Claude CLI, logged in — required for **live** mode (`LLM_PROVIDER=claude-code`)
- `uvx` (from `uv`) — for the read-only Neo4j MCP the agent uses

**Bring it up** (from the repo root):

```bash
cp .env.example .env      # set NEO4J_PASSWORD; copy the same into bff/.env
npm install               # installs all workspaces (shared / bff / web)
npm run db:up             # start local Neo4j in Docker
npm run rdf               # generate + verify the canonical RDF
npm run etl               # RDF → reason → project into Neo4j + seed vector index
npm run dev               # BFF (:8787) + web (:5173), concurrently
```

Open **http://localhost:5173**.

**Ports**

| Port | Service |
|------|---------|
| 5173 | Web app (Vite; proxies `/api` → 8787) |
| 8787 | BFF (Fastify) |
| 7474 / 7687 | Neo4j Browser / Bolt |
| 3030 | Fuseki (only when `REASONER_BACKEND=fuseki`) |

**Scripted vs. live.** The header `Mode` toggle switches between **scripted** (deterministic cached
narration — safe for a demo with no network) and **live** (streams the real model). Everything
grounding-related is identical in both modes; only the narration source changes.

---

## The mental model

The app is a **pharmacovigilance / R&D knowledge-graph trust workbench**. The single thesis: an
answer is only as trustworthy as the evidence you can point at. So every feature is built **around a
grounded answer path** — the agent may only cite nodes the graph actually returned, must refuse when
the answer isn't in the graph, and may only mutate data through one authorized human-in-the-loop
writer. The competitor-inspired features (F1–F8) are **observability and workflow layers** wrapped
around that path — none of them is a new answer source, and none weakens grounding.

Keep this in mind as you read: whenever a feature *looks* like it could invent data (routing seeds,
literature synthesis, a synthetic competitor overlay), the guide points at exactly why it can't.

---

## The four beats

The app is organized as four "beats" you switch between from the header nav (`1 · Radar` …
`4 · Conversation`) or the command palette.

### Beat 1 · Radar — Data-readiness / FAIR integrity radar

- **What it does.** Colours the graph by ALCOA+/FAIR completeness (a readiness score 0–100), lists
  live SHACL validation findings across 7 risk types (missing-provenance, conflicting-annotation,
  missing-cross-source-link, stale-ontology-version, dangling-reference, duplicate-record,
  missing-followup), and routes each flag to an accountable owner (data steward, PV signal lead, …)
  via the `RISK_POLICY` severity bands (P0/P1/P2).
- **Where.** Header `1 · Radar`, or ⌘K → "Go to 1 · Radar".
- **Key files.** `web/src/beats/RadarBeat.tsx`, `web/src/components/FiltersRail.tsx`;
  BFF `bff/src/graph/risk.ts`.
- **API.** `GET /api/risk` (SHACL flags + readiness + human-reviewed ids), `GET /api/graph?scope=all`.
- **Caveat.** Readiness is recomputed live per request; SHACL flags are deterministic but derive from
  the static ontology shapes. Radar refetches on a `refreshKey` bump after any HITL apply/revert so
  flags stay in sync.

### Beat 2 · Explanation — PV signal-causality path _(the hero beat, default on load)_

- **What it does.** The deterministic multi-hop chain from an adverse event back to source evidence.
  Scripted mode auto-advances hop-by-hop; live mode streams grounded narration. Shows the mechanistic
  hop `CANDIDATE_SIGNAL ← TARGETS ∘ IN_PATHWAY` as an OWL property-chain entailment with an inference
  trace.
- **Where.** Header `2 · Explanation`, or ⌘K → "Go to 2 · Explanation". Step with "Next" / the hop
  rail.
- **Key files.** `web/src/beats/ExplanationBeat.tsx`, `ProvenanceStrip.tsx`, `HopRail.tsx`;
  BFF `bff/src/graph/queries.ts`, `bff/src/narrate/narrator.ts`, `bff/src/reasoner/service.ts`.
- **API.** `GET /api/explain` (3-hop path), `POST /api/narrate` (SSE narration + citations),
  `GET /api/graph?scope=hero`.
- **Caveat.** `IN_PATHWAY` transitivity is **declared** in the ontology but **not operationally
  entailed** (no transitive closure materialized). `validateGrounding` refuses any citation not in the
  served path — off-list claims abort the narration.

### Beat 3 · Multimodal — Pathology image / omics → concept resolution

- **What it does.** Click a `PathologyImage` or `OmicsProfile` node; its pre-computed 384-dim
  embedding resolves via **real Neo4j native vector kNN** (top-3 matches) to the ontology concept the
  explanation path already traverses — proving the graph is the single source for structured *and*
  multimodal data.
- **Where.** Header `3 · Multimodal`, or ⌘K → "Go to 3 · Multimodal". Click an image/omics node.
- **Key files.** `web/src/beats/MultimodalBeat.tsx`; BFF `bff/src/graph/resolve.ts`,
  `bff/src/etl/vector_seed.ts`.
- **API.** `GET /api/resolve?nodeId=<id>` (top-3 kNN concept matches + distance).
- **Caveat.** Only image/omics nodes resolve; other node clicks open the provenance drawer instead.
  Resolve is last-click-wins (a sequence guard drops out-of-order results). The vector index is built
  at ETL time — no online embedding inference.

### Beat 4 · Conversation — Grounded ask-the-graph chat

- **What it does.** A full grounded conversation over the read-only Neo4j graph, powered by CopilotKit
  v2 and the AG-UI bridge. Shows the real Cypher it ran, cites nodes, persists threads, and routes
  statistical conclusions to human review. No second LLM, no Runtime API key — grounding stays
  server-side.
- **Where.** Header `4 · Conversation`, or ⌘K → "Go to 4 · Conversation". Also reachable via
  "⤢ open full" from the floating AskDock on beats 1–3.
- **Key files.** `web/src/beats/CopilotChatBeat.tsx`, `GroundedDiagrams.tsx`, `AnswerCanvas.tsx`,
  `NodeContextBar.tsx`, `AskDock.tsx`; BFF `bff/src/ask/agent.ts`, `aguiBridge.ts`,
  `copilotRuntime.ts`, `threadStore.ts`, `enforced.ts`.
- **API.** `POST /api/agui` (AG-UI bridge), `/api/copilotkit/*` (full Runtime), `POST /api/ask`
  (legacy SSE), `GET/POST/PUT/DELETE /api/threads[/:id]`, `POST /api/hitl/enqueue`.
- **Caveat.** `citedNodeIds` are validated server-side with a rows-only guard (only ids returned by
  the Cypher can be cited). `NOT_IN_GRAPH` refusals draw **nothing** — empty canvas, no diagrams.
  Thread *history* is saved; grounding is per-turn and never touches Neo4j.

---

## Trust Workbench elements

Cross-cutting UI from the "Trust Workbench" redesign — the chrome that makes the trust story legible.

| Element | What it does | Where | Source |
|---|---|---|---|
| **FiltersRail (trust lens)** | Filters the canvas by node kind, readiness band, verified flag, or flagged status. Only hides nodes the BFF already sent; cited/active nodes are always kept, so filtering never breaks grounding. | Beats 1–3 (left rail) | `web/src/components/FiltersRail.tsx` |
| **Known / Missing / Conflicting AnswerCanvas** | Buckets real cited nodes into Known (in evidence), Missing (gaps the agent named), Conflicting (contradictory evidence), with an explicit "answer bounded to N cited node(s); off-graph refused" boundary. Never fabricates a gap. | Beat 4 right column | `web/src/components/AnswerCanvas.tsx` |
| **Send → Review (HITL enqueue)** | Enqueues a grounded conclusion for async human sign-off; carries only real cited ids + a summary. Bumps the ReviewBell immediately. | Beat 4, on each grounded answer | `CopilotChatBeat` → `hitlApi.enqueue()` |
| **PROV-O dossier + model card** | Per-node ALCOA+/21 CFR Part 11 provenance drawer: source system, timestamp, license, data-quality flags with "Why flagged?" evidence paths, reviewer approvals, model-card link. | Right drawer, click any node | `web/src/components/ProvenanceDrawer.tsx`, `web/src/lib/trust.ts` |
| **Notification bell (ReviewBell)** | Shows the count of governance items awaiting a human decision; polls every 8s and bumps after apply/revert. Dropdown lists the top 5; "view all" opens the HITL panel. | Header, right | `web/src/components/ReviewBell.tsx` |
| **Command palette (⌘K / Ctrl+K)** | Global search over all beats, all actions, and every hero-graph node. Esc dismisses. | Global hotkey | `web/src/components/CommandPalette.tsx` |
| **Help overlay (?)** | Keyboard-shortcut reference + the on-canvas trust legend. | `?` key or header `?` | `web/src/components/HelpOverlay.tsx` |
| **Reviewer menu** | Active reviewer name + purpose label (F6). Popover to set name/role/purpose; stamped on every HITL write. Does **not** gate the read-only agent. | Header, right | `web/src/components/ReviewerSelector.tsx`, `web/src/identity/ReviewerContext.tsx` |
| **Header breadcrumb (ContextBar)** | Slim "R&D Trust Graph › [beat] › [open node] · [context count]" breadcrumb with the ⌘K hint. Purely presentational. | Below header | `web/src/components/ContextBar.tsx` |

---

## Feature tour F1–F8

The eight competitor-inspired features, grouped by the phase in which they shipped. Each is a layer
**around** the grounded answer path — never a new answer source, never a new agent write tool.

### Phase 1 — the observability keystone (F1 → F4 → F2)

#### F1 · Faithfulness score + gate

- **What it does.** Scores how well an answer's claims trace back to its cited evidence. Deterministic
  core: extract claims → check whether each shares salient tokens (node ids, numbers, content words)
  with the cited-node vocabulary → score = supported ÷ evidence-bearing claims, banded high (≥0.8) /
  medium (≥0.5) / low. An optional LLM judge can refine the verdict (off by default). It **observes**;
  a low score surfaces a "low confidence" stamp but never silently suppresses the answer.
- **How to use it.** Ask a question in Beat 4 — grounded answers show a green/amber/red faithfulness
  badge. Also shown per step in Playbooks (F5).
- **Key files.** `bff/src/ask/faithfulness.ts`, `bff/src/ask/aguiBridge.ts`;
  web `CopilotChatBeat.tsx` → `faithfulnessRenderer()`.
- **API.** Embedded in the `/api/agui` tool-call stream (a `faithfulness` tool call).
- **Caveat.** Deterministic core is pure + unit-tested; the LLM judge is optional and default-off. The
  stopword list is deliberately small to avoid over-pruning claims.

#### F4 · Hallucination flag

- **What it does.** Per-claim hallucination detection. The faithfulness scorer flags claims whose
  salient tokens don't appear in the cited evidence (`unsupportedClaims`). If any exist, a
  `hallucination_flag` tool call renders a ⚠ banner listing the unverified claims. It **annotates**;
  it never edits the answer.
- **How to use it.** In Beat 4, a grounded answer with unsupported claims shows a ⚠ banner (up to 4
  claims, "+N more" beyond that).
- **Key files.** `bff/src/ask/faithfulness.ts` (unsupported-claim detection), `aguiBridge.ts`;
  web `CopilotChatBeat.tsx` → `hallucinationRenderer()`.
- **API.** Embedded in `/api/agui` (`hallucination_flag`).
- **Caveat.** Only fires when unsupported claims exist. Claims below 8 chars are ignored.

#### F2 · RAGAS-style eval scorecard

- **What it does.** Rolling answer-quality observability: faithfulness (F1), deterministic
  context-recall (of the salient entities named in the question, what fraction appear in cited
  evidence?), and optional answer-relevancy (LLM judge). Shows recent per-answer entries + rolling
  averages.
- **How to use it.** Header `Quality`, or ⌘K → "Open answer-quality scorecard".
- **Key files.** `web/src/eval/EvalScorecard.tsx`; BFF `bff/src/eval/scorecard.ts`, `aguiBridge.ts`.
- **API.** `GET /api/eval/summary?limit=50`.
- **Caveat.** Observability only; never gates the LLM. Refusals and fallbacks aren't scored. A corrupt
  ledger rolls back to empty history rather than crashing the demo.

### Phase 2 — literature + governance identity (F7, F6)

#### F7 · Literature synthesis

- **What it does.** Source-ranked, inline-cited synthesis over `LiteratureAbstract` nodes relevant to
  a focus node or topic. Ranks by source tier (regulatory > trial registry > journal > other), then by
  year descending; passes only those abstracts to a structured synth that **must** cite by node id.
  Every inline `[LIT-PMID-…]` citation is enforced ⊆ the supplied ids (reusing `validateGrounding`);
  an off-list cite refuses the narrative and a deterministic template restates the served summaries.
  Read-only; no agent tool.
- **How to use it.** Component exists (`LiteratureSynthesis.tsx`) but is **not yet wired to a beat**
  (see Honest scope). Intended entry point: the provenance drawer of a `LiteratureAbstract` node, or a
  future "Literature" header action.
- **Key files.** `bff/src/litsynth/service.ts`; web `web/src/components/LiteratureSynthesis.tsx`.
- **API.** `POST /api/litsynth` (`focusNodeId?`, `topic?`) → SSE (ranked, token, citations, done).
- **Caveat.** Same grounding discipline as `/narrate`. Fallback is deterministic. The demo corpus is
  all PubMed (Journal tier), so recency is the effective tiebreaker.

#### F6 · Reviewer identity + purpose

- **What it does.** A small React context holds **who** is reviewing (name + role, persisted to
  localStorage) and the **purpose** of their review. Both are stamped on every HITL write (apply/flag)
  for the audit trail. It's a **disclosure/affordance** — it does **not** gate the read-only agent or
  weaken grounding.
- **How to use it.** Header `⊙ [name] · [purpose]` (or `⊙ Reviewer` if unset) → popover to set
  name/role/purpose. Then approve something in the HITL panel and see it stamped in the audit log.
- **Key files.** `web/src/identity/ReviewerContext.tsx`, `ReviewerSelector.tsx`;
  BFF `bff/src/server.ts` (`/api/hitl/apply` accepts `reviewer`/`purpose`).
- **API.** `reviewer`/`purpose` in the `/api/hitl/apply` and `/api/hitl/flag` request bodies.
- **Caveat.** Roles come from the `RISK_POLICY` owner vocabulary; purposes from `config.purposePolicies`.
  Identity is **never** an access gate — it only labels the audit trail.

### Phase 3 — workflows, routing, competitive context (F5, F3, F8)

#### F5 · Safety-dossier playbooks

- **What it does.** Curated orchestration templates made of `ask` steps (each runs the **real**
  grounded agent) and `checkpoint` steps (each enqueues an async HITL review). Streams step progress,
  the faithfulness band per ask step, and HITL-enqueue confirmations, then assembles a final dossier.
  Pure orchestration over the real agent — no new answer source.
- **How to use it.** Header `Playbooks`, or ⌘K → "Run a scientific playbook (safety dossier)" → pick a
  playbook → **Run**.
- **Key files.** `bff/src/playbooks/definitions.ts`, `bff/src/playbooks/runner.ts`;
  web `web/src/playbooks/PlaybookPanel.tsx`.
- **API.** `GET /api/playbooks`, `POST /api/playbooks/run` (SSE: step-started / step-result / done).
- **Caveat.** Checkpoint steps **enqueue** HITL items (non-blocking) — they don't auto-mutate the
  graph; a reviewer approves later. Each run streams independently (stateless).

##### F5b · Author a playbook with AI

- **What it does.** Lets a user describe a safety question in natural language and have the AI **draft a
  whole playbook** (ordered `ask` / `checkpoint` / `synth` steps), edit it inline (reorder, add/remove,
  change kind, regenerate a step, or refine the whole draft by chat), then **Save** it as a runnable
  custom playbook that appears in the list beside the curated ones and runs on the **unchanged** path.
- **How to use it.** `Playbooks` → **✦ New with AI** → type a goal (or click a sample-prompt chip) →
  **Draft with AI** → edit → **Save playbook**. Custom rows get **✎ Edit** and **🗑 Delete** controls;
  curated rows show a **🔒 curated** lock badge and cannot be edited or deleted (immutable by design).
- **Sample prompts.** Word a goal as **signal + entity + reviewer/assembly intent** so the model
  produces a full `ask → checkpoint → synth` dossier over vocabulary the graph carries (drugs, adverse
  events, mechanisms, regulatory labeling — which keeps drafted questions answerable):
  - *Build a safety dossier for the hepatotoxicity signal of the JAK inhibitor: identify the implicated
    drug, quantify the signal, gather supporting evidence and mechanism, check the regulatory label, and
    route it to a reviewer for sign-off.*
  - *Assemble a signal dossier for immune-mediated colitis associated with checkpoint inhibitors — which
    drugs are implicated, how strong is the disproportionality signal, what evidence and mechanism
    support it, and does the current labeling reflect it — then send it for reviewer sign-off.*
  - *Create a dossier assessing the drug–drug interaction risk between the two co-prescribed agents:
    surface the interacting drugs, the adverse events they share, the mechanism of interaction, and the
    labeling guidance, ending with a reviewer checkpoint.*
  - *Draft a review of the most reported adverse events for the drug in the pediatric population,
    quantify each signal, gather the supporting evidence, compare against the label, and add a reviewer
    sign-off before assembling the dossier.*
  - *Build a dossier comparing the cardiovascular adverse-event profile of the drug against its
    therapeutic class: identify the class members, quantify the shared signals, gather mechanism and
    evidence, check labeling, and route to a reviewer.*
- **Key files.** `bff/src/playbooks/draft.ts` (draft/refine engine), `bff/src/playbooks/schema.ts`
  (live-schema seeding + schema-lint), `bff/src/playbooks/store.ts` (`playbooks-custom.json`
  persistence), `bff/src/playbooks/definitions.ts` (curated ∪ custom merge, curated immutability);
  web `web/src/playbooks/PlaybookAuthor.tsx`, `web/src/playbooks/PlaybookPanel.tsx`.
- **API.** `POST /api/playbooks/draft` `{goal}`, `POST /api/playbooks/refine` `{draft, instruction}`,
  `POST /api/playbooks` (create, 201), `PUT /api/playbooks/:id` (update), `DELETE /api/playbooks/:id`.
  Writing/deleting a curated id → 409; structural-validation failures → 400 with issues.
- **Trust.** A playbook is **orchestration config only** — questions/prompts, never answers, never graph
  writes. The draft is **schema-seeded** so questions stay answerable; amber warnings flag off-graph
  steps but never block saving. Authored text is treated as **untrusted input** to the downstream agent
  (goal handled as data; strings sanitized on write and read; step `kind` enum-locked). At run time each
  `ask` step is still answered by the **unchanged** grounded agent, which refuses off-graph on its own.
- **Caveat.** Drafting prefers the cloud API with a hard timeout; if the model is unavailable it
  degrades to a deterministic editable **skeleton** (marked "offline skeleton") rather than hanging or
  returning blank. Custom playbooks persist to `bff/playbooks-custom.json` (gitignored); curated ones
  ship in code.

##### F5c · Routines — run a playbook on a schedule

- **What it does.** Attaches a recurring **schedule** ("routine") to any playbook (curated or custom).
  An in-process scheduler on the BFF fires due routines HEADLESS on their cadence through the unchanged
  runner, and records each run in a bounded history (status + step/checkpoint counts). One routine per
  playbook. Scheduling never mutates the playbook definition, so curated immutability is untouched.
- **How to use it.** `Playbooks` → the **🕐 clock** button on any row → pick a cadence (**Hourly /
  Daily (09:00) / Weekly (Mon 09:00)**, or **Custom cron** for a raw 5-field expression) → toggle
  **Enabled** → **Save schedule**. The row then shows a green **🕐 cadence · next …** badge (or
  **paused** when disabled). **Run now** triggers the same headless run on demand.
- **Cadence.** Presets map to cron (`hourly`=`0 * * * *`, `daily`=`0 9 * * *`, `weekly`=`0 9 * * 1`).
  Custom cron is 5-field local time — e.g. `0 9 * * 1-5` (weekdays 09:00), `*/30 * * * *` (every 30 min).
- **Key files.** `bff/src/playbooks/cron.ts` (zero-dep 5-field matcher + nextRun),
  `bff/src/playbooks/routines.ts` (`routines.json` store + run history),
  `bff/src/playbooks/scheduler.ts` (the ticker); web `web/src/playbooks/RoutineEditor.tsx`,
  `web/src/playbooks/PlaybookPanel.tsx`.
- **API.** `GET /api/routines`, `GET /api/routines/runs?routineId=`, `PUT /api/playbooks/:id/routine`
  (upsert cadence/cron/enabled; 404 if the playbook is unknown, 400 on invalid cron),
  `DELETE /api/playbooks/:id/routine`, `POST /api/playbooks/:id/run-now`.
- **Trust.** A routine is orchestration config only — it decides WHEN a playbook runs, never WHAT is
  true. A scheduled run is byte-for-byte the same as pressing **Run**: each `ask` step drives the
  unchanged grounded agent (refuses off-graph on its own) and each `checkpoint` enqueues a **non-blocking
  HITL** item a human approves later. No new answer source, no graph write.
- **Caveat.** The scheduler runs **only while the server is up** (in-process, not a durable OS cron);
  a run spends model tokens on a timer, so disable a routine to pause spend. Safety rails: at most one
  run per routine per minute, never two concurrent runs of the same playbook, unknown playbook skipped,
  run errors caught + recorded (never crash the process). History persists to `bff/routines.json`
  (gitignored), capped at 100 runs.

#### F3 · Adaptive retrieval routing

- **What it does.** Classifies each question as vector-resolve / cypher-traversal / hybrid from lexical
  cues ("similar"/"looks like" → vector; "why"/"how"/"mechanism" → cypher; both → hybrid). Gathers
  **real** candidate seed ids from lexical label matches + (for vector/hybrid) semantic kNN neighbours,
  labelled "candidates to verify". Seeds are **not** citations — one only becomes a citation if the
  agent's own Cypher returns it in a row (the rows-only guard is untouched).
- **How to use it.** Transparent — runs on every Beat 4 question; the chosen strategy surfaces as a
  `route` event in the conversation trace.
- **Key files.** `bff/src/ask/router.ts`, `bff/src/ask/agent.ts`.
- **API.** Embedded in `/api/ask` and `/api/agui` (a `route` event).
- **Caveat.** Classification is pure + unit-tested; seed gathering degrades gracefully (graph/vector
  failure → no seeds). Default (no cues) → cypher-traversal, the safest choice for a knowledge graph.

#### F8 · Competitive-pipeline overlay

- **What it does.** A curated, **clearly synthetic** set of competitor pipeline nodes
  (`ExternalPipeline` kind, `COMPETES_WITH` our real drugs/targets), served separately and merged
  **client-side only**. Because the synthetic ids never enter Neo4j or the RDF store, they never enter
  `loadValidNodeIds()` — so the grounded agent can never cite one. Every node carries `synthetic: true`
  and renders distinctly (dashed, grey).
- **How to use it.** Header `Competitive` (toggles; shows "✓" when on), or ⌘K → "Toggle
  competitive-pipeline overlay (synthetic)".
- **Key files.** `bff/src/overlay/competitivePipeline.ts`; web `App.tsx` (`competitiveOpen` state +
  client-side `displayGraph` merge).
- **API.** `GET /api/overlay/competitive` → `{ synthetic: true, nodes, edges }`.
- **Caveat.** `EXT-PIPE-*` ids are trivially identifiable and never in the grounding allow-list. The
  overlay is fetched lazily and merged client-side only — the baseline graph/TTL stay byte-identical.
  A test asserts no `EXT-PIPE-*` id appears in Neo4j or RDF.

---

## Grounding & safety invariants

These are the non-negotiables the whole app is built to protect. Teach these — they're the trust
story, not a footnote.

1. **Served-payload-only citations.** The agent may only cite node ids that came back in its own
   Cypher result rows (rows-only guard in `agent.ts`), intersected with the valid-node allow-list. It
   cannot invent an id or cite one it merely "knows".
2. **Off-graph refusal draws nothing.** When the answer isn't in the graph, the agent emits the
   configured `NOT_IN_GRAPH` marker; the UI renders an empty canvas and **no** diagrams — no
   confident-looking fabrication.
3. **Authorized-writer-only mutation.** The only path that writes data is the HITL writer
   (`hitl/ops.ts` → `write()` + `reasoner.update()`). The agent's `ALLOWED_TOOLS` excludes every write
   tool and the Neo4j MCP is `--read-only`. There is no agent write path.
4. **Every F-feature is a layer around the answer, not a new answer.** F1/F2/F4 observe and score;
   F3 only seeds candidates the agent must still verify; F5 re-runs the *same* grounded agent; F6
   stamps audit metadata on writes that already flow through the authorized writer; F7 enforces
   inline citations ⊆ supplied abstracts; F8 data is synthetic-by-construction and non-citable.
5. **Synthetic never contaminates real.** F8 nodes live only in a client-side overlay; they are never
   written to Neo4j, so they can never enter the citation allow-list.

---

## Reference — header buttons & ⌘K

**Header buttons (left → right):** `1 · Radar`, `2 · Explanation`, `3 · Multimodal`,
`4 · Conversation`, LiveStatusPill (indicator), ReviewBell 🔔, `⊙ Reviewer · purpose`, FinOpsMeter,
`Quality`, `Competitive[✓]`, `Playbooks`, `Mode: scripted|live`, `Canvas: light|dark`,
`Skin: war-room|boardroom`, `Density: comfortable|compact`, `↱ Export to RDF (W3C)`, `⚖ HITL`,
`⚙ Admin`, `?`, AccountMenu.

**Command palette (⌘K / Ctrl+K):**

- _Go to:_ 1 · Radar / 2 · Explanation / 3 · Multimodal / 4 · Conversation
- _Actions:_ Open HITL review queue · Open Admin panel · Open FinOps dashboard · Open answer-quality
  scorecard · Toggle competitive-pipeline overlay (synthetic) · Run a scientific playbook (safety
  dossier) · Export hero subgraph to RDF (W3C) · Toggle canvas theme · Toggle chrome skin · Toggle
  layout density · Toggle mode (scripted/live) · Show help & keyboard shortcuts
- _Nodes:_ every hero-graph node (search + select → provenance drawer)

---

## Reference — HTTP endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/health`, `/api/diag` | Health + live-readiness preflight |
| `GET` | `/api/graph?scope=hero\|all` | Graph payload for the canvas |
| `GET` | `/api/explain` | Deterministic hero explanation path (3 hops) |
| `GET` | `/api/rdf` | Live hero subgraph as W3C RDF Turtle (export) |
| `POST` | `/api/sparql` | Read-only SPARQL (mutations rejected) |
| `GET` | `/api/provenance/:id` | Per-node ALCOA+ provenance dossier |
| `POST` | `/api/narrate` | SSE: grounded narration (live or cached) |
| `POST` | `/api/litsynth` | SSE: literature synthesis (source-ranked, inline-cited) |
| `GET` | `/api/playbooks` | List playbooks (curated ∪ custom) |
| `POST` | `/api/playbooks/run` | SSE: run a playbook (ask + checkpoint steps) |
| `POST` | `/api/playbooks/draft` | AI-draft a playbook from a goal (F5b) |
| `POST` | `/api/playbooks/refine` | Refine a draft by instruction (F5b) |
| `POST` | `/api/playbooks` | Create a custom playbook (201; curated id → 409) |
| `PUT` | `/api/playbooks/:id` | Update a custom playbook (curated id → 409) |
| `DELETE` | `/api/playbooks/:id` | Delete a custom playbook (curated id → 409) |
| `GET` | `/api/routines` | List playbook schedules (with computed nextRunAt) (F5c) |
| `GET` | `/api/routines/runs` | Routine run history (optional `?routineId=`) (F5c) |
| `PUT` | `/api/playbooks/:id/routine` | Upsert a playbook's schedule (F5c) |
| `DELETE` | `/api/playbooks/:id/routine` | Remove a playbook's schedule (F5c) |
| `POST` | `/api/playbooks/:id/run-now` | Run a playbook headless now (records history) (F5c) |
| `POST` | `/api/explain-node` | SSE: grounded 1-hop node explanation |
| `GET` | `/api/terminology` | SKOS synonyms + hierarchy |
| `GET` | `/api/resolve-entity` | External code → canonical node id |
| `GET` | `/api/resolve?nodeId=<id>` | Vector kNN matches for a multimodal node |
| `GET` | `/api/risk` | SHACL-grounded risk flags + readiness (Beat 1) |
| `GET` | `/api/gated` | GatedConclusion entries (with inference trace) |
| `POST` | `/api/ask` | SSE: grounded ask-anything (legacy) |
| `POST` | `/api/agui` | AG-UI bridge to the grounded agent |
| `*` | `/api/copilotkit/*` | CopilotKit v2 Runtime (full chat transport) |
| `GET/POST/PUT/DELETE` | `/api/threads[/:id]` | Conversation persistence (history-only) |
| `GET` | `/api/hitl/pending` | HITL review queue |
| `POST` | `/api/hitl/apply` | Apply a reviewed change (approve/reject/escalate) |
| `POST` | `/api/hitl/flag` | Raise/clear a manual reviewer flag |
| `POST` | `/api/hitl/enqueue` | Enqueue a grounded conclusion for review (Send→Review) |
| `GET` | `/api/hitl/changesets` | Audit log of applied/reverted changes |
| `POST` | `/api/hitl/revert` | Undo an applied change |
| `POST` | `/api/hitl/suggest-questions` | Suggested follow-ups for a change |
| `GET` | `/api/config/public` | Public config (notInGraphMarker, purposePolicies) |
| `GET/PUT` | `/api/admin/config` | Hot-apply editable prompts/marker/thresholds |
| `GET` | `/api/finops/summary` | Token spend + cost observability |
| `GET` | `/api/finops/ledger?limit=100` | Full token ledger |
| `GET` | `/api/eval/summary?limit=50` | Answer-quality scorecard (F2) |
| `GET` | `/api/overlay/competitive` | Synthetic competitive overlay (F8; grounding-safe) |

---

## Honest scope

**Real today (verified in code):** RDF-first reasoning (OWL entailment + live SHACL, oxigraph or
Fuseki backends); Neo4j projection cache + real vector kNN resolve (384-dim); enforced grounding +
refusal; full CopilotKit v2 Runtime (threads, HITL); generative grounded diagrams; hot-apply admin;
two-axis theming (skin × density).

**Deliberate demo-stage simplifications:** the Neo4j projection re-reads source CSVs (RDF is
authoritative for topology + reasoning, not byte-canonical for every node attr); `CANDIDATE_SIGNAL`
is a single-pass SPARQL `INSERT…WHERE` rule, not a full OWL engine; `IN_PATHWAY` transitivity is
declared but not operationally entailed.

**Feature-specific caveats to state plainly:** F7's UI is a stub not yet wired to a beat; the LLM-judge
portions of F1/F2 are default-off (deterministic floor only); F6 purpose gating is a transparent
disclosure, **not** a hard data ACL; F5 checkpoints are non-blocking enqueues (async approval).

**Scoped out:** production identity / multi-tenant auth; large-scale ingestion; clinical validation.
All data is synthetic and PHI-free by design (commercial-safe licenses only).
