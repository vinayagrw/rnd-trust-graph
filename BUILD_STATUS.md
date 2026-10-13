# Build status

> **Headline (observed 2026-06-30):** the **fast BFF suite → 114 tests, 114 pass, 0 fail** (run after
> `npm run etl` to reset the shared-Neo4j baseline — the HITL apply→revert round-trip tests flake on a
> dirty radar; recovery is `npm run etl`). Plus the F5 playbook-runner file adds 2 more (116 total): its
> **structural test passes (1/1)**; its **live end-to-end integration test** drives 3 real Claude Code
> CLI agent calls and **could not be certified on this machine** — the local `claude` CLI hangs under the
> test harness (an environment issue, not a code defect; F5 endpoints were separately smoke-tested live
> via curl). `npm run typecheck` clean across shared + bff + web, `npm run build` green.
> (Test count grew 16 → 25 → 42 → 55 → 71 → 102 → 108 → **114 fast (+2 F5 runner)**.)
>
> **Two distinct "Phase" numberings — don't conflate:** the *v2 internal phases* below (Phase 2 = full
> Copilot Runtime; Phase 3 = shadcn/Tailwind reskin) are **shipped**. They are unrelated to the
> *competitor-features roadmap*, where **ALL 8 features are
> now shipped**: Phase 1 (F1 faithfulness + F4 hallucination flag + F2 eval scorecard), roadmap Phase 2
> (F7 literature synthesis + F6 reviewer identity), and roadmap Phase 3 (F5 safety-dossier playbooks +
> F3 adaptive retrieval routing + F8 competitive-pipeline overlay). See the competitor-features section
> below for the per-feature invariant notes.

## Generative dashboards — `@rnd/dashboards` (Phases 1+2+3 shipped, 2026-07-13)

Query-driven **generative dashboards**: on a grounded chat answer, a local Claude-Code call composes a
structurally-**inert** `DashboardSpec` (chooses *which* widgets over *which* cited node ids — never emits
numbers/URLs/HTML/Mermaid); the BFF validates it (Zod `.strict()` + grounding superRefine), **certifies**
tiles over real cited-node kinds, and the web renderer resolves every value from the live graph. It is a
layer **around** the grounded answer — same emit gate as `render_evidence` (`grounded && ≥1 cited id`),
never a new answer source.

- **Package layout:** `shared/src/dashboard.ts` (plain-TS spec + `mergeDashboard`), `bff/src/dashboards/`
  (`composer.ts` LLM-primary, `schema.ts` Zod v4 validator, `template.ts` deterministic net, `verified.ts`
  certified-query registry), `web/src/dashboards/` (`DashboardCanvas.tsx`, `registry.tsx`,
  `dashboardRenderer.tsx`, `lineageStore.ts`). Wired at `ask/agent.ts` (`emitDashboard`) → `ask/aguiBridge.ts`
  (`render_dashboard` tool call) → `CopilotChatBeat.tsx` (`dashboardRenderer` in `renderToolCalls`).
- **Features 1–8 DONE:** (1) spec+registry+tool-call, (2) LLM composer, (3) template safety net, (4) staggered
  reveal — **partial: cosmetic CSS stagger, not true token-streaming**, (5) cross-filter/linked brushing,
  (6) tile "⤷ Explain" drill-down (grounded follow-up via `askRef`), (7) live merge/patch (`mergeDashboard`
  + `lineageStore`, changed tiles pulse), (8) certified badges + `DashboardAudit` (trusted-BFF-computed,
  rides alongside the inert spec).
- **Discoverable entry point (2026-07-13):** the Conversation beat now shows a labelled **"✨ Generate a live
  dashboard"** launcher (`data-testid="dashboard-launcher"`, `BeatStarters` in `CopilotChatBeat.tsx`) with
  three curated grounded prompts. Previously a dashboard only appeared as a silent side-effect of a grounded
  answer with no affordance — this makes the capability visible. Routes through the identical grounded `ask()`
  path (no new answer route).
- **Verified:** typecheck clean (3 ws); **31/31** dashboards tests (18 + 7 certification + 6 merge); LIVE BFF
  end-to-end (`source:"llm"`, `certified:['w2','w3','w4','w5']`, audit `{model:claude-opus-4-8, estimated:false,
  faithfulnessScore:0.85, certifiedCount:4}`); frontend render-proof + launcher render-proof on `:5173`.
- **Phase 3 — features 9 & 10 SHIPPED (2026-07-13).** **F9 scheduled snapshots + delta briefs:**
  `bff/src/dashboards/snapshots.ts` (file-backed schedule + bounded snapshot store, mirrors
  `playbooks/routines.ts`); `playbooks/scheduler.ts` gains a `composeSnapshot` executor that recomposes
  headless via the **unchanged grounded `composeDashboard`**, delta-detects with `mergeDashboard().changedIds`,
  and briefs the change — `tickOnce` fires due dashboard schedules on the same cron/dedupe rails as routines.
  Grounding gate: 0 resolved cited nodes ⇒ metadata-only error snapshot (no spec stored). **F10 publish/save/
  share + governance:** `bff/src/dashboards/store.ts` (saved-board store, re-validates the spec with the **same
  `dashboardSpecSchema`** on every save); `/api/dashboards` CRUD + `/review` + `/schedules` + `/snapshots` +
  `/schedules/:key/run-now` in `server.ts`; `dashboardsApi` in `web/src/api.ts`. **"Send → Review"** reuses the
  exact `enqueueFromConclusion` HITL path Beat-4 uses (record-decision-only, empty ops → reversible + reviewer-
  stamped, no graph write). **Frontend entry point:** a **"🗂 Saved dashboards"** action in the ⚙ Tools menu opens
  `SavedDashboardsPanel.tsx` (list/open/delete/Send-to-Review saved boards + list schedules with latest brief +
  Run-now); a **💾 Save** affordance on `DashboardCanvas` publishes the on-screen inert spec + trusted audit.
  **Invariants held:** no graph writes (F9 recompose + F10 persist never touch Neo4j); grounding re-enforced on
  save; HITL widgets stay host-chrome (not spec-expressible); no new overlay `ChangeOp`; `App.tsx` node handler
  reused. **Verified:** typecheck clean (3 ws); **48/48** dashboards tests (31 + 17 new); **LIVE end-to-end** —
  save→list→Send-to-Review (real HITL item), grounding guard rejects a tampered spec (HTTP 400), schedule upsert
  + run-now composed headless via the **live** composer (`source:"llm"`, 5 widgets, delta brief); frontend render-
  proof on `:5173` (Tools-menu item present, panel opens with both sections). Proof artifacts cleaned up.
- **Design deliverable:** `docs/teaching/Dynamic_AI_Driven_Dashboards_Design.md` (2026-07-13) — positions the
  build as "Declarative Generative UI", folds in June–July-2026 SOTA (A2UI v0.9, Claude structured-outputs +
  fine-grained tool streaming GA, cosmos.gl v3, Mosaic/DuckDB, "citation grounding"), with a red-team + honest
  scope. Complements the earlier `GENERATIVE_DASHBOARDS_Technical_Design.md`.

## Header navigation (2026-07-13)

The header's ~13 control buttons (Quality, Competitive, Playbooks, Story, Mode, Motion, Canvas, Skin, Density,
Export, HITL, Admin, Help) — which wrapped across four rows — are collapsed into one **"⚙ Tools"** overflow
menu (`web/src/components/ToolsMenu.tsx`), grouped into **View** (state toggles with on/off chips) and
**Panels & tools** (actions). Beat nav + status trio (Live pill, review bell, FinOps) + avatar stay visible.
Pure information-architecture change — every item runs its original handler. Header buttons ~23 → 10; verified
live (toggle flips `data-density`, actions open their panels).

## Competitor-features roadmap — all 8 shipped (2026-06-30)

The `dreamy-snuggling-crown.md` roadmap (Causaly / Palantir / Neo4j-GraphRAG-inspired) is complete.
Every feature is a layer **around** the grounded answer path — never a new answer source, never a new
agent write tool, never a weakening of grounding. The three invariants held throughout: served-payload-
only grounding, off-graph refusal via the configured `NOT_IN_GRAPH` marker, authorized-writer-only
mutation. Verified: typecheck clean (3 ws); **114/114 fast BFF tests** + F5 structural test (1/1); the
F5 live end-to-end integration test is blocked by the local Claude Code CLI hanging under the harness
(environment, not code — F5 endpoints smoke-tested live via curl).

- **Phase 1 — F1 faithfulness / F4 hallucination flag / F2 eval scorecard (SHIPPED).** Faithfulness
  score + band computed server-side over the grounded answer; hallucination flag surfaced through the
  AG-UI bridge; RAGAS-style eval scorecard. Deterministic floor; LLM-judge parts default-off.
- **Phase 2 — F7 literature synthesis (SHIPPED).** `bff/src/litsynth/service.ts` ranks the relevant
  `LiteratureAbstract` nodes (`LIT-PMID-*`), passes ONLY those to a structured synth that must cite by
  node id, and enforces every inline `[LIT-PMID-…]` ⊆ supplied ids (clones `validateGrounding`);
  deterministic templated fallback. `POST /api/litsynth` (SSE). Web: `LiteratureSynthesis.tsx` with
  clickable citation chips, surfaced from `ProvenanceDrawer` on `LiteratureAbstract` nodes.
- **Phase 2 — F6 reviewer identity + purpose (SHIPPED).** `{name, role}` + review `purpose` stamped
  onto every HITL write via the **existing authorized writer** (no new write path); `ReviewerContext`
  provider + header selector; `purposePolicies` in admin config. Honest framing: purpose gating is a
  transparent disclosure/affordance, **not** a hard data ACL. Additive/optional on `ChangeSet` — the
  apply→revert round-trip stays byte-identical.
- **Phase 3 — F5 safety-dossier playbooks (SHIPPED).** `bff/src/playbooks/` defines an ordered playbook
  (myocarditis-safety-dossier) whose `ask` steps run the **real** `askGraph` (collecting sink harvests
  answer + citations + F1 faithfulness), `checkpoint` steps `enqueueFromConclusion` a **non-blocking**
  HITL review (reviewer approves asynchronously — no hung SSE), and `synth` assembles the dossier.
  `GET /api/playbooks` + `POST /api/playbooks/run` (SSE). Web: `PlaybookPanel.tsx`. Pure orchestration
  over the grounded agent — no new answer source.
- **Phase 3 — F3 adaptive retrieval routing (SHIPPED).** `bff/src/ask/router.ts` classifies each
  question `vector-resolve | cypher-traversal | hybrid` with a rationale; for vector/hybrid it seeds the
  agent prompt with kNN-resolved candidate ids **labeled "candidates to verify."** A `route` event
  renders in the trace. **Critical invariant intact:** citations still derive ONLY from result rows
  (`traceSink` guards `event.type === "rows"`), so an unverified seed can never become a citation.
- **Phase 3 — F8 competitive-pipeline overlay (SHIPPED).** Synthetic `EXT-PIPE-*` competitor nodes
  (`kind:"ExternalPipeline"`, `COMPETES_WITH` edge, `synthetic:true`) served from
  `GET /api/overlay/competitive` and merged **client-side only** — the baseline Neo4j graph and TTL stay
  byte-identical. Because `loadValidNodeIds()` reads Neo4j only, synthetic ids are automatically absent
  from the citation allow-list (test-proven); rendered dashed/grey and clearly labeled synthetic.

## Conversation persistence shared by the dock and Beat 4 (2026-06-30)

The floating **AskDock** now shares ONE persistent conversation with the full Beat-4 surface, fixing
"I don't see the conversation that happened in the docked chat when I expand it."

- **Root cause:** the dock rendered `<CopilotChat />` with **no `threadId`** and **never persisted**, so
  its messages lived only in memory; Beat 4 (which binds a `threadId`, persists every finalized turn to the
  history-only BFF store, and restores `localStorage["rtg.beat4.threadId"]` on mount) had nothing to load.
- **Fix (web-only, additive — no BFF/grounding change):** new `web/src/lib/thread.ts` exports the shared
  `LAST_THREAD_KEY` + `dedupeById` (both lifted from `CopilotChatBeat.tsx`, which now imports them — no
  behavioural change). `web/src/components/AskDock.tsx` gains a `useDockThread` hook mirroring Beat 4: on
  mount it restores the shared last-open thread (or creates one via `threadsApi.create`), binds
  `<CopilotChat key threadId>`, and persists messages + grounding on `onRunFinalized`. The two surfaces are
  never visible at once (the dock is hidden on the conversation beat), so the single shared key is race-free;
  the hand-off needs no `App` routing change — Beat 4's existing mount-restore picks up the dock's thread.
- **Guardrails intact:** same read-only `/api/copilotkit` → AG-UI → `/ask` path; no second LLM, no new
  answer path; the thread store stays history-only (never writes Neo4j). Verified: typecheck clean (3 ws);
  `npm run build` green; **108/108 BFF tests** (after `npm run etl`).

## v2 — RDF-first reasoner + HITL mutate/revert + accuracy cleanup (2026-06-29)

The v2 slice makes **"the graph reasons, the LLM narrates" literally true** and adds governed,
reversible writes. Verified: **102/102 BFF tests pass** (as of 2026-06-30), typecheck clean (shared+bff+web).

- **RDF-first toggleable reasoner — SHIPPED.** `bff/src/reasoner/` exposes a backend-agnostic
  `Reasoner` interface (`index.ts`) over two interchangeable backends behind one toggle
  (`REASONER_BACKEND` / admin config; default **oxigraph** in-process WASM, alternative **fuseki**
  Jena HTTP sidecar — `oxigraph.ts` / `fuseki.ts`). `service.ts` loads `data/rdf/ontology.ttl`
  (T-Box) + `data/rdf/dataset.generated.ttl` (A-Box), runs an ordered single-pass entailment rule set
  (`RULE_CANDIDATE_SIGNAL` — the OWL property-chain `TARGETS ∘ IN_PATHWAY ⟹ CANDIDATE_SIGNAL`,
  materialized operationally so both backends agree byte-for-byte), then serves the hero path,
  FAIR/ALCOA+ readiness, and gated conclusions via **SPARQL SELECT/ASK + live SHACL** (shacl-engine
  with the sparql extension flagging exactly the 4 noise nodes). Read-only `POST /api/sparql`
  (`server.ts:124`) rejects updates up front (`SparqlWriteRejectedError → 400`). Warmed at boot
  (`server.ts:450`, logs `backend=oxigraph`). Verified by named tests: `oxigraph: SELECT returns the
  Drug→Target→Pathway path`; `entail() materializes an inferred candidate-signal triple (ASK
  false→true)`; `canonical reasoner builds on oxigraph and materializes candidate-signal`; `hero path
  stays 3 hops along AE→DRUG→TGT→PW (SPARQL-confirmed edges)`; `live SHACL flags EXACTLY the 4 noise
  nodes and nothing else`. **FALSE-FALSE (intact):** single-pass SPARQL rule not a fixpoint OWL engine;
  `IN_PATHWAY` transitivity declared-not-entailed; Neo4j projection re-reads CSVs (RDF not byte-canonical
  for node `attrs`).
- **HITL mutate + revert (reversible change-set log) — SHIPPED.** `bff/src/hitl/` adds governed,
  fully-reversible graph writes with an append-only audit log. `pending.ts` holds three demo-pinned
  scenarios (promote candidate→mechanistic edge; resolve AE-CONFLICT; attach provenance to TGT-NOPROV),
  each carrying precomputed forward + exact-inverse ops. `store.ts` apply/revert persists to
  `bff/hitl-changesets.json` (gitignored, `HITL_CHANGESETS_PATH`-overridable). `ops.ts` mutates **BOTH**
  projections in lock-step via the **AUTHORIZED writer** — Neo4j `write()` + `reasoner.update()` —
  **never** the read-only agent/MCP path (the agent has no tool that reaches `write()`; `/api/sparql`
  write-guard + MCP `--read-only` + `enforced.ts` allow-list untouched). SHACL flag resolutions are a
  reversible runtime overlay (`overlay.ts`); the overlay is rebuilt from applied changesets on restart.
  Routes: `GET /api/hitl/pending`, `POST /api/hitl/apply`, `GET /api/hitl/changesets`,
  `POST /api/hitl/revert` (`server.ts:365–430`). Verified by named round-trip tests: `round-trip:
  promote-cpi-myocarditis apply→revert restores exact prior state` (+ `resolve-ae-conflict`,
  `attach-tgt-noprov-provenance`); `scenario (b) raises readiness while applied (AE-CONFLICT flag
  cleared)`; `audit log records applied then reverted status`. **Open:** audit-persistence / RBAC /
  routing-policy remain proposals in `../HITL_Design.md`.
- **Accuracy cleanup + regenerated conformance report — SHIPPED.** SPARQL write-guard unit-tested
  (`sparql.test.ts`: rejects INSERT/DELETE/DROP/CLEAR/LOAD; `does NOT false-trip on a forbidden keyword
  inside a string literal or comment`). Trust invariants now SPARQL/SHACL-confirmed (`clean baseline:
  exactly 4 flagged nodes + hero 3 hops`; `readiness formula preserved: base − penalty·flags (defaults
  100/25)`; `gated conclusions: deductive auto-accept (entailment) + statistical human-review`). SHACL
  conformance report **regenerated** from the live shapes (`data/shacl/conformance-report.txt`,
  2026-06-29 — `Conforms: False`, 6 violations across exactly DRUG-ORPHAN / CON-STALE / TGT-NOPROV /
  AE-CONFLICT, 1:1 with the radar). **Note:** the v2 effort was described as Part A/B/C incl. "5 audit
  fixes"; the individual five are not separately enumerated on disk — the net effect above is what the
  passing test names + regenerated artifact verify.
- **Phase 2 — full Copilot Runtime (retires `agents__unsafe_dev_only`).** Beat 4 now runs through the
  full Copilot Runtime: `web/src/beats/CopilotChatBeat.tsx` `<CopilotKitProvider
  runtimeUrl="/api/copilotkit">`; mounted by `bff/src/ask/copilotRuntime.ts` via
  `registerCopilotRuntime(app)` (`server.ts:268`) using `CopilotRuntime` / `createCopilotEndpoint` from
  `@copilotkit/runtime/v2`. The Runtime is a transparent AG-UI proxy whose single `default` agent is an
  `HttpAgent` to the **UNTOUCHED** grounded `/api/agui` bridge — **no LLM key, no model on the
  Runtime**; refusals still draw nothing. Typecheck clean. **Honest status:** route + wiring exist and
  compile; the "verified end-to-end through `/api/copilotkit`" claim rides on the in-code header note,
  not a render-proof captured in this docs pass.
- **Phase 3 — app-wide shadcn/Tailwind v4 + 2026 reskin.** The shadcn/ui + Tailwind v4 layer (begun
  additively under `.admin-root`) is the app-wide component/theme system via the existing `--frame-*`
  tokens; the four beats render unchanged, `prefers-reduced-motion` honored. 102/102 tests; typecheck
  clean. Follow-ups: admin-route auth (deferred); lazy-load mermaid.

## Overnight autonomous run — persistence + config + HITL prototype (2026-06-29)

Coordinator + parallel subagents executed seven work items (A–G); full write-up in
`../Overnight_Run_Report_2026-06-29.md`. Stack live throughout (`/api/diag` `live:true, apiKey:false`).
Three code changes shipped + verified; four are plans/docs. Grounding/read-only/no-API-key/enforced
constants held inviolate.

- **Conversation persistence + restore (Beat 4) — SHIPPED.** History-only file-backed BFF thread
  store `bff/src/ask/threadStore.ts` (`bff/threads.json`, gitignored, `.test.ts`), layered around the
  UNTOUCHED `/api/agui` grounded bridge. Routes added to `bff/src/server.ts`: `GET/POST /api/threads`,
  `GET/PUT/DELETE /api/threads/:id`. Web: `web/src/api.ts` (`threadsApi`) + `web/src/beats/CopilotChatBeat.tsx`
  (thread-switcher sidebar; persists `threadId` + messages + per-turn `{citedNodeIds,isFallback}`;
  restores via `agent.setMessages` + grounding replay; last-thread in localStorage). The store is
  structurally incapable of touching Neo4j (test-enforced). Verified: typecheck clean; `npm run build
  --workspace web` `✓ built`; BFF tests **35 pass / 0 fail** (7 new); live reload-restore render-proof
  `../persist_proof_before.png` / `../persist_proof_after.png`. Remaining CopilotKit features planned in
  `../Copilot_Features_Plan.md` (durable threads / `useThreads` / auto-suggestions are runtime-only).
- **Per-surface LLM model/effort/timeout config — SHIPPED.** `bff/src/config.ts` gains `config.narrate.*`
  + `config.ask.*` (model, idle/hard timeouts, max-tokens/turns) from `bff/.env`, replacing hardcoded
  literals in `narrator.ts`/`agent.ts`/`claudeCode.ts` (added optional per-call `model`). Defaults
  byte-identical; cheaper narration is opt-in (`NARRATE_MODEL=claude-haiku-4-5-20251001` — safe because
  `validateGrounding` refuses off-path citations → cached fallback). Enforced constants stayed hardcoded
  outside the editable schema. Verified: typecheck PASS (3 ws); BFF tests PASS (adminConfig 9 / narrator
  5 / verify 3 / rdf 4); `web build ✓ 35.59s`. Audit: `../Config_Audit.md`. **Open:** validate Haiku
  narration quality via `golden.test.ts` before flipping the default.
- **HITL decision-support cockpit (🟩-only prototype) — SHIPPED.** `web/src/beats/RadarBeat.tsx`
  (additive, reversible): on statistical/human-review (🟩) items only — confidence meter, server-grounded
  reasoning trace, evidence/provenance pointer, advisory recommendation+rationale, Accept/Reject/Escalate
  (local state), session audit trail. **Auto-accept 🟦 untouched** — gated on `routedToHuman===true`.
  Verified: typecheck green; `web build ✓ 55.28s`; BFF tests **42/42 pass** (incl. gated-conclusions
  invariant); render-proofs `../hitl_proof.png` + `../hitl_proof_after_escalate.png`. Design + 3
  self-critique passes in `../HITL_Design.md` (audit-persistence / RBAC / routing-policy left as proposals).
- **Plans/docs (not code):** `../Neo4j_Coverage_and_Plan.md` (coverage matrix + top-5; full-text index =
  safest quick win; nothing implemented by design), `../Gap_Analysis_and_Plan.md` (22 gaps; P0 =
  lazy-load mermaid · frontend grounding-gate test · admin-route auth at `server.ts:162/167`),
  re-mastered `../Business_Value_Animated.svg` (validator `[OK]`, two-frame proof).
- **Coordinator independent verification (post-run) — caught + fixed a pre-existing flaky test.**
  An integrated run (not per-subagent self-report) found the **full** BFF suite at **54/55** with one
  failure: `adminConfig.test.ts` "single source marker" expected `MARKER_X:`, got `NOT_IN_GRAPH:`.
  Root cause (passes 9/9 in isolation ×2): `node --test <glob>` runs each test file in its own process
  but all shared one on-disk `bff/admin-config.json`, and `getConfig()` re-reads on mtime change → a
  concurrent test process's write bled across. **Fix (test-infra + 1 additive line):** `ADMIN_CONFIG_PATH`
  env override in `adminConfig.ts` (default unchanged) + new `bff/test-setup.ts` giving each test worker
  a pid-keyed temp config under the OS temp dir + a new `bff/package.json` `test` script wiring it.
  Verified: `npm test` now **55/55, 0 fail, stable ×3 consecutive runs**; bff typecheck clean; tests no
  longer pollute the live config. Also restored a test-induced pollution of the live refusal marker
  (deleted the stray `admin-config.json`; `/api/config/public` → `NOT_IN_GRAPH:`, hot-applied).
  **Lesson reinforced (FALSE-TRUE):** isolated/sequential subagent runs reported green honestly but
  masked a concurrency flake — always run the integrated suite before certifying "done".

## Reskin v2 — theme variants (skin/density) complete + verified (2026-06-29)

**A two-axis, attribute-driven theme-variant system layered on top of the 2026 "clinical-trust"
reskin. Attribute/CSS-only — no component logic touched, no existing CSS variable removed.**
- **Files changed:** `web/src/theme/tokens.css` — added a `[data-skin="boardroom"]` light-pearl
  variant block (navy text), a `[data-density="compact"]` block (denser gaps/radii/padding), a bolder
  hero `.app-header > strong`, and a war-room palette deepening (all **overrides**); `web/src/App.tsx`
  — added `skin`/`density` `useState` toggles applied as `data-skin`/`data-density` on the root div,
  two new `.btn btn-control` header toggles, and wired `<main>` gap/padding to `var(--gap)`.
- **Behaviour:** default opens warroom/comfortable (unchanged look). `boardroom` = light pearl
  header/frame with navy text; `compact` = denser gaps/radii/padding. Zero component-logic regression.
- **Verification:** `cd web && npm run typecheck` clean; `npm run build` succeeds (`vite build` ok,
  only the pre-existing chunk-size advisory); live render-proof of all three states —
  `web/public/proof-reskin-v2-warroom.png`, `proof-reskin-v2-boardroom.png`,
  `proof-reskin-v2-compact.png` (captured against the live full stack on Beat 2 Explanation).
  `web/src/App.tsx` also **persists the toggle choice to localStorage** (keys `rtg.skin`/`rtg.density`,
  try/catch-guarded so private-mode can't break the demo): first load defaults to war-room/comfortable,
  the chosen combo is restored on reload. Persistence render-proof: `web/public/proof-reskin-v2-persist.png`.
  **Open item:** none — toggle persistence to localStorage is now **implemented + render-proven**
  (`rtg.skin`/`rtg.density`, default war-room/comfortable, proof `web/public/proof-reskin-v2-persist.png`;
  all four checks PASS — default on fresh load, write on toggle, survives reload, restores default on clear).

## Phased expansion — Phase 3 complete + verified (2026-06-29)

**In-UI prompt/guardrail admin (hot-apply) + 2026 reskin. The whole approved phased plan
(Phases 1–3 + business SVG) is now done and verified.**
- **3a — config store + hot-apply:** `bff/src/config/adminConfig.ts` (zod-typed, file-backed
  `bff/admin-config.json`, read at request time with mtime/size cache-invalidation). The narrator
  prompt, `/ask` instruction, `notInGraphMarker`, and risk thresholds (`readinessBase`,
  `penaltyPerFlag`, `staleBeforeYear`, `statisticalConfidence`) are editable; defaults are
  byte-identical to the former hardcoded values. Refactored: `narrator.ts`, `agent.ts`, `risk.ts`,
  `aguiBridge.ts`, `AskPanel.tsx`. Routes: `GET/PUT /api/admin/config` (+ `GET /api/config/public`
  for the marker). **Grounding enforced in code, NOT in the editable schema:** `bff/src/ask/enforced.ts`
  holds the read-only tool allow-list (write tool never present); a PUT that tries to add writes → 400;
  the marker is a single source consumed by agent+bridge+AskPanel.
- **3b — admin panel:** shadcn/ui + Tailwind v4 added ADDITIVELY (preflight-free scoped layers under
  `.admin-root`, so the four hand-styled beats render unchanged). `web/src/admin/AdminPanel.tsx` —
  ⚙ Admin sheet from the header, Editable + **Enforced (locked)** tabs; partial-PUT with inline zod
  errors; the locked tab visualizes the read-only/allow-list/refusal guarantees.
- **3c — 2026 reskin:** "clinical-trust data product" theme (deep-navy chrome, clinical-blue + teal
  accent, Geist/Newsreader type, calm live-pill heartbeat) applied THROUGH existing `--frame-*` CSS
  vars + shared classes — only `web/src/theme/tokens.css`, `web/src/admin/admin.css`, `web/index.html`
  changed; **no `.tsx`/BFF/logic touched**. `prefers-reduced-motion` honored.
- **Verification:** typecheck clean (3 ws); `web build` ok; **25/25 BFF tests** (16 + 9 config);
  live hot-apply transcript (penalty 25→40 ⇒ `/api/risk` overall 98→97 and Beat-1 radar updated, no
  restart; penalty=250 ⇒ 400 inline error, not applied; delete config file ⇒ byte-identical defaults);
  browser render-proof of every surface (`web/public/proof-admin-*.png` + `proof-reskin-*.png`); all
  interactions exercised, none regressed. **Follow-ups:** admin auth (deferred, demo); lazy-load
  mermaid (bundle ~2.7MB); productionize CopilotKit off the `unsafe_dev_only` path.

## Phased expansion — Phase 2 complete + verified (2026-06-29)

**Beat 4 "Conversation" is now CopilotKit's prebuilt `CopilotChat`, driving the UNTOUCHED grounded
`/ask` agent through a thin AG-UI bridge — no second LLM.** (Buy-before-build: prebuilt UI off the
shelf; we built only the bridge + the grounded diagram adapters.)
- **Bridge:** `bff/src/ask/aguiBridge.ts` → `POST /api/agui` translates `askGraph(question, sink)`
  events into AG-UI SSE: prose→`TEXT_MESSAGE_CONTENT`; real read-only Cypher+rows→`TOOL_CALL_*`
  (in-thread show-your-work); citations→`STATE_SNAPSHOT {citedNodeIds,isFallback}`; a `render_evidence`
  tool call (real cited ids) drives generative UI. Agent code unchanged; grounding stays server-side.
- **Frontend:** `web/src/beats/CopilotChatBeat.tsx` — `CopilotKitProvider` (v2) +
  `agents__unsafe_dev_only={{default: HttpAgent("/api/agui")}}` + prebuilt `CopilotChat`; `useAgent()`
  reads STATE_SNAPSHOT → companion `GraphCanvas` highlights cited nodes; `renderToolCalls` renders the
  Cypher trace + the grounded diagrams.
- **Grounded-by-construction diagrams:** `web/src/components/GroundedDiagrams.tsx` — cited-node
  force-graph + Recharts PRR/ROR bar chart + Mermaid hero flow, ALL from real returned rows; unknown
  ids dropped. **Grounding gate:** a refusal (`NOT_IN_GRAPH:`) yields empty citations + `isFallback`
  and NO `render_evidence` → draws nothing.
- **Deps:** `@copilotkit/react-core@2.0.0-next.1`, `@copilotkit/react-ui@2.0.0-next.1`,
  `@ag-ui/client@0.0.42` (locked to CopilotKit's bundled version — `0.0.57` breaks types), `mermaid`,
  `recharts`, `zod` (direct). React stayed 18.3 (no forced 19).
- **Verification:** typecheck clean (3 ws); `web build` succeeds with v2-next; **16/16 tests**;
  protocol round-trip via `curl POST /api/agui` (grounded: real SignalStat trace+citations+render_evidence;
  refusal: empty citations, no render_evidence); **live browser render-proof** —
  `web/public/proof-copilot-grounded.png` (8-signal table + Cypher trace + evidence subgraph + PRR/ROR
  chart) and `web/public/proof-copilot-refusal.png` (NOT_IN_GRAPH, no diagram). Temp "5 · Copilot" tab
  removed; hand-built `ConversationBeat` retired (unmounted). **Known follow-ups:** lazy-load mermaid
  (bundle 2.7MB); `agents__unsafe_dev_only` is dev-only (productionize with stable v2 + auth).
- Next: Phase 3 (in-UI prompt/guardrail admin + 2026 reskin).

## Phased expansion — Phase 1 complete + verified (2026-06-28)

The post-demo phased expansion (chat / admin / data / reskin / SVG) is underway. **Phase 1 is done
and live-verified:**
- **Live default:** app opens in live mode (`web/src/App.tsx` initial `Mode = "live"`); green pill on
  load; `/api/diag` → `live:true, neo4j:true, apiKey:false`.
- **HITL visibility fix:** Beat-1 "Human-in-the-Loop governance" panel made unmissable — 🟦 auto-accept
  (deductive) vs 🟩 → human-review (statistical) pills + a readiness-score legend (100 − 25/defect).
  Resolves the user's "can't see auto-accept in HITL".
- **Data ×4 (generic loaders):** immunology/RA chain (tofacitinib→JAK1→JAK-STAT→serious-infection,
  7 patients), oncology breadth (CDK4/6 / neutropenia), new `GeneticAssociation` kind (Open Targets,
  5) + `GENETIC_EVIDENCE`, new `RegulatoryDoc` modality (FDA/EMA, 4, embedded) + `HAS_LABEL`; more
  real PMIDs/NCTs/ontology slices. Node total ~47→ much larger; patients 24→34.
- **Honest semantic surfaces:** `GET /api/terminology` over a real SKOS thesaurus
  (`data/skos/thesaurus.ttl`), `GET /api/resolve-entity?code=…` cross-refs, an inference-trace line.
- **Verification:** ETL idempotent (hero still 3 hops); enlarged `scripts/verify.cypher` passes
  (immuno chain 3-hop/7-cases; RegulatoryDoc 4 / GeneticAssociation 5 / HAS_LABEL 8 / GENETIC_EVIDENCE
  10; new modalities resolve to CON-RA 0.80 / CON-HYPERTENSION 0.81); guardrails intact (only the 4
  noise nodes flag — `AE-MYOCARDITIS` co-flags `conflicting-annotation` only because the seeded
  `AE-CONFLICT` noise node deliberately shares its `OAE_0001489` code, i.e. by design, overall 98);
  typecheck + web build + **16/16 tests** green; browser render-proof captured (Beat 1 + Beat 2).
- Next: Phase 2 (CopilotKit chat + generative diagrams), Phase 3 (in-UI prompt/guardrail admin +
  2026 reskin), business SVG.

---

All 7 plan phases implemented end-to-end and **verified live on this machine** (2026-06-28):

- ✅ `npm install` — 205 packages, 0 vulnerabilities
- ✅ `npm run typecheck` — clean across shared + bff + web
- ✅ `npm run build --workspace web` — Vite bundles (1064 modules, ~114 kB gzip)
- ✅ BFF boots; `/api/health` → `{ok:false}` with Neo4j down, `{ok:true}` with it up
- ✅ **Full live run against Docker + Neo4j** — `db:up` healthy → `etl` → all 6 `verify.cypher` checks pass:
  hero path = 3 hops · case series = 6 · `concept_embeddings` vector index ONLINE (3 embedded) ·
  IMG-BIOPSY resolves → CON-MYOCARDITIS (score 0.803) · 4 noise nodes present.
- ✅ Endpoint smoke (Neo4j live): `/api/graph` `/api/explain` `/api/risk` (overall 90) `/api/gated`
  (statistical → `routedToHuman`) `/api/resolve` (`onPath:true`) `/api/provenance` all sane;
  `/api/narrate` + `/api/ask` SSE stream cached-fallback tokens (no API key set).

### ETL fix landed during live test
`bff/src/etl/run.ts` — the statement splitter (`statements()`) split on `;` but was **not
comment-aware**, so a `;` inside a `//` comment in `01_schema.cypher` emitted an invalid fragment
and aborted the load. Fixed: strip `//` line comments *before* splitting, quote-aware and guarding
`://` (so `file:///…` LOAD CSV URLs are untouched). Re-verified: ETL runs clean and idempotent;
typecheck still green.

| Phase | What's in | Key files |
|---|---|---|
| 1 · Foundations | monorepo, Docker Neo4j, shared types, brand tokens, README/RUNBOOK | `package.json`, `docker-compose.yml`, `shared/src/types.ts`, `web/src/theme/tokens.css` |
| 2 · Data spine | curated hero subgraph CSVs (Oncology CPI→myocarditis PV signal), idempotent ETL, constraints, vector index | `data/import/*.csv`, `bff/src/etl/*` |
| 3 · Beat 2 hero | `/graph` `/explain` `/provenance`; pinned deterministic path; canvas hop-by-hop reveal; provenance drawer | `bff/src/graph/queries.ts`, `web/src/beats/ExplanationBeat.tsx`, `web/src/components/GraphCanvas.tsx` |
| 4 · Narrator | `/narrate` SSE, live Opus 4.8 + cached fallback, scripted/live toggle | `bff/src/narrate/narrator.ts`, `data/fallbacks/narrations.json` |
| 5 · Radar | `/risk` `/gated` FAIR/ALCOA+ scoring, colour overlay, HITL gate, SHACL cameo | `bff/src/graph/risk.ts`, `data/shacl/*`, `web/src/beats/RadarBeat.tsx` |
| 6 · Multimodal | offline embedding seed, real Neo4j vector kNN `/resolve`, resolve animation | `bff/src/etl/vector_seed.ts`, `bff/src/graph/resolve.ts`, `web/src/beats/MultimodalBeat.tsx` |
| 7 · Ask + hardening | `/ask` SSE (Agent SDK → Neo4j MCP read-only) + safe read-only fallback, verify script | `bff/src/ask/agent.ts`, `scripts/verify.cypher` |

## To run

```bash
cp .env.example .env          # set NEO4J_PASSWORD; ANTHROPIC_API_KEY optional
npm install
npm run db:up && npm run etl  # build graph (idempotent) + seed embeddings
npm run dev                   # BFF :8787 + web :5173
```

Then run `scripts/verify.cypher` in Neo4j Browser (http://localhost:7474).

## Build-time verifications (flagged in the plan, §15)

- ✅ **CLOSED — `@anthropic-ai/claude-agent-sdk`** intentionally **NOT a dependency**. The `/ask`
  Agent-SDK block is loaded via a **guarded dynamic `import()`** (`bff/src/ask/agent.ts` ~L152); any
  resolve failure degrades safely to the read-only fallback. The live demo path is the local `claude`
  CLI provider, which does **not** need this SDK — so it is deliberately left out of `package.json`
  (adding an uninstalled dep would only make `npm install` try to fetch it, with no live-path benefit).
- ✅ **CLOSED — Neo4j MCP server** pinned to **`mcp-neo4j-cypher@0.6.0`** (resolved via uvx, working).
  The once-assumed `1.5.3` **never existed on PyPI**; `0.6.0` is the working resolved version. Read-only
  enforced via the `--read-only` CLI flag.
- ✅ **CLOSED — react-force-graph-2d** pinned to **`1.29.1`** (exact, no caret) in `web/package.json`.
- Embedding dim is 384 (seed + index DDL agree); swap if you adopt a real FM.

## Honest scope (say it in the room)

Synthetic, PHI-free, commercial-safe (CC-BY/CC0/public-domain) data. Demonstrates
**capability**, not epidemiological validity. Population-level PV signal only —
deliberately not a patient-specific clinical alert (FDA-device pattern).

## Design review + fixes applied (2026-06-28)

Ran a UX/UI critique (last-3-months research: *trust-as-the-interface*, *motion-as-explanation*,
*progressive disclosure*) plus a six-persona pass (Fraile, Swanson, skeptical data scientist,
regulatory/QA, enterprise architect, design lead). Verdict: architecture sound; the design needed
legibility + provenance-forward fixes before a hostile room.

**Shipped this pass (P0+P1):**
- **P0 contrast** — canvas lifted off pure-black (`#0d1117` → `#14181f`, kills halation); edges
  raised luminance (`#58a6ff` → `#79b8ff`), widened (revealed 2.5px / idle 1.2px); **active hop**
  now a high-luminance `#f0f6ff` ring + 3.5px edge (separates by luminance *and* weight).
- **P0 projector-survival** — header **Canvas: dark/light** toggle (`CANVAS_LIGHT` palette) for
  bright rooms / weak projectors. Labels capped at `#e6edf3`, never pure white.
- **P1 radar redundant encoding** — readiness is now hue **+** ring thickness (thicker = worse)
  **+** on-node numeric badge, so it survives colour-vision deficiency and projection.
- **P1 orientation** — prominent **"Hop X of N"** step indicator on the hero beat.
- **P1 a11y** — `prefers-reduced-motion` honoured: no particle animation, no scripted autoplay
  (presenter drives with Next/Back).
- **P1 legend** — persistent encoding key (node types + readiness scale + edge meaning) in the
  side panel, beat-aware.
- **P2 multimodal-as-evidence** — resolve now shows the 2–3 runner-up concepts it did *not* pick
  with their cosine scores ("similarity, not a lookup table").

**Open (not yet done — design follow-ups):**
- Provenance surfaced as an always-visible panel, not only the click-drawer (persona: regulatory).
- "You-are-here" minimap for graphs that pan off-screen on later hops. *(Deferred — low ROI at this
  graph size; the new auto-fit below removes the immediate need. Reconsider only with Neo4j NVL.)*
- Reasoning-upfront staging: render the deterministic path fully *with narrator off*, then narrate.

See also `../Neo4j_Features_and_Use_Cases.md` (features + use cases reference; LPG-as-serving-tier
positioning vs. the mandated W3C/RDF stack).

## Second pass — bug fix + LLM provider + research (2026-06-28)

**Canvas "right black screen" — FIXED (`web/src/components/GraphCanvas.tsx`).**
The canvas was hardcoded `width=900`, so on a wide monitor the `1fr` grid column left a black
gutter on the right; and with no fit-to-view the sparse multimodal subgraph drifted into a corner
(one node top-left, the rest off-screen). Fix: wrap in a `width:100%` div measured by a
`ResizeObserver` so the canvas fills its column, and call `zoomToFit(400, 60)` on `onEngineStop`
and whenever the data/viewport changes. Typecheck + web build green (1064 modules).

**Narration controls — added (`web/src/beats/ExplanationBeat.tsx`).**
Added **⏸ Pause/▶ Play** (halts scripted auto-advance) and **Skip to answer ⤓** (jump to the final
evidence node). Back / Next / Replay and "Hop X of N" already existed. `/ask` empty state now shows
a one-line "read-only, cites what it touches" hint (`web/src/components/AskPanel.tsx`).
(Over-dense >100-node `/ask` handling is N/A — `/ask` renders text, not a subgraph, in v1.)

**Local Claude Code as LLM provider — NEW (`bff/src/llm/claudeCode.ts`, wired into narrate + ask).**
`LLM_PROVIDER` toggle: `api` (cloud Messages API / Agent SDK, needs `ANTHROPIC_API_KEY`) or
`claude-code` (spawns the local `claude` CLI with `--output-format stream-json`, parses NDJSON,
streams assistant text). With `claude-code`, **auth rides on the local Claude Code login
(subscription) — no raw API key in the BFF**, resolving the account constraint (no raw key /
no-ZDR). `/ask` in this mode passes a generated read-only Neo4j MCP config via `--mcp-config`.
Pattern mirrors a managed-agent CLI executor (verified by
exploration). Fully guarded — any spawn/parse failure drops to the cached/safe fallback. Documented
in `.env.example`. Typecheck green. *Build-time check still open:* confirm the local CLI's
stream-json `assistant` event shape + the MCP tool name on the target machine before the live run.

**Local Claude Code provider — TESTED LIVE END-TO-END (2026-06-28), both surfaces PASS.**
Ran a second BFF on :8788 with `LLM_PROVIDER=claude-code` against the live Neo4j, exercised both
LLM surfaces through the local `claude` CLI (v2.1.175) — `apiKeySource:"none"`, i.e. **subscription
auth, zero API key**:
- `/narrate` → streamed a real, fully grounded narration (anti-PD-1 → myocarditis, PD-1/PDCD1 target,
  T-cell checkpoint pathway, PRR 4.2, openFDA FAERS + PMID), `isFallback:false`. ✅
- `/ask` → the CLI inspected the schema and ran read-only Cypher via the Neo4j MCP, returning the
  correct grounded answer (**6 patient cases**, matching `verify.cypher`), `isFallback:false`. ✅

Three real bugs found and fixed during the test (each was a genuine blocker):
1. **Prompt mangling** — passing a multi-line prompt as a CLI arg under `shell:true` let cmd.exe split
   it; the CLI errored → fallback. Fix: feed the prompt on **stdin** (`claude -p` reads stdin), keep
   argv as bare tokens. (`bff/src/llm/claudeCode.ts`)
2. **Turn budget** — a one-shot narration needs ~1 turn but the `/ask` tool-loop (find tool → schema →
   query → answer) needs more; `--max-turns 2` cut it off mid-loop. Fix: per-call `maxTurns` override,
   `/ask` uses 12. (`claudeCode.ts`, `ask/agent.ts`)
3. **Wrong MCP package version** — `mcp-neo4j-cypher@1.5.3` (assumed in the plan) **does not exist on
   PyPI**; uvx failed to resolve → MCP server `failed` → no tools. Fix: `NEO4J_MCP_VERSION` (default
   `latest`), and pass connection + **`--read-only`** as CLI args (the real flag; `NEO4J_READ_ONLY`
   env was a wrong guess), verified against `uvx mcp-neo4j-cypher --help`. (`config.ts`, `ask/agent.ts`)

This retires two open build-time TODOs (Agent SDK/MCP read-only flag; local-CLI stream-json shape).
Typecheck + web build green after all fixes. Requires `uvx` (from uv) + a logged-in `claude` on PATH.

**Tooling research (GitNexus + alternatives) — conclusion.**
- **GitNexus: not adopted.** A *code*-to-graph engine (Kuzu/WASM, Sigma.js, Tree-sitter) under a
  **PolyForm Non-commercial** license — wrong domain (source code, not biomedical) and wrong license
  for a commercial asset. Borrow only its thesis ("precompute structure, LLM narrates" — already our
  stance) and optionally Leiden community detection.
- **Worth real evaluation:** `neo4j-graphrag-python` (Neo4j-native KG construction + entity
  resolution — complements our vector-resolve step) and **Neo4j NVL** (`@neo4j-nvl/react`) as a
  better-scaling, Neo4j-branded replacement for react-force-graph-2d. Cite **Microsoft GraphRAG** in
  the deck for the explainability/community-summarization narrative only.

## State-of-the-art elevation — Phases 0–5 (2026-06-28)

Six-phase "do all" pass. All live-verified against Docker+Neo4j through the local `claude` CLI
(subscription auth, **no API key**). Final: typecheck clean (shared+bff+web), web build green,
**16/16 tests pass** (5 grounding + 3 groundedness + 4 golden-eval + 4 RDF).

**Phase 0 — live provider switched on + no more silent fallbacks.** Root cause of the demo looking
"offline scripted": the BFF loads `bff/.env` (cwd=bff/), which **did not exist** → defaulted to
`provider=api`/no-key → fallback. Created `bff/.env` (`LLM_PROVIDER=claude-code`). Added: stderr
capture + **discriminated fallback reasons** (`spawn-failed|not-authenticated|no-tools|timeout|
empty-output|ungrounded|api-error`, logged, never silent); `GET /api/diag` preflight; a header
**"Live · Claude Code (no API key)"** pill (`web/src/components/LiveStatusPill.tsx`) with per-check
hover; startup `live-readiness: READY/NOT READY` log. Verified: `/api/diag` `live:true,apiKey:false`;
`/ask`→6 cases; `/narrate`→full grounded narration. **3 more bugs fixed:** idle watchdog (6s) killed
the `/ask` tool-loop mid-answer → per-call `idleTimeoutMs` (45s ask / 20s narrate); CLI cold-start
tripped the 6s narrate hard-cap → 30s for claude-code; missing-binary misclassified → `spawn-failed`.

**Phase 1 — enforced, inspectable reasoning.** Narrator now uses structured output
`{narration, citedNodeIds}`; **any off-path citation is refused** (`validateGrounding`, 5 unit tests
incl. poisoned allow-list). New `citations` SSE event; clickable **HopRail**
(`web/src/components/HopRail.tsx`) shows each hop's predicate, syncs to the canvas, marks "✓ cited";
"✓ grounded in N on-path nodes" badge. Reasoning shown upfront (rail lists all hops; future dim).

**Phase 2 — `/ask` past the chat box.** `claudeCode.ts` parses tool_use/tool_result → new
`step`/`cypher`/`rows` SSE events; AskPanel renders a **"show your work" trace** (the read-only
Cypher + returned rows), a **"✓ grounded in live Cypher"** badge, and a **principled refusal**
(`NOT_IN_GRAPH` → "refused, not guessed"). Verified live incl. the out-of-graph 1998-stock refusal.

**Phase 3 — always-on provenance + eval harness.** Persistent **ProvenanceStrip** (source/ontology/
code/timestamp/license per active hop); `bff/src/llm/verify.ts` groundedness verifier (3 tests);
`bff/src/eval/golden.test.ts` Text2Cypher execution-accuracy golden set (4 checks, runs in CI vs the
live graph — **caught a real bug**: `{skip}` is evaluated at registration so the probe must be
top-level-await, not a `before()` hook, else the eval silently skips).

**Phase 4 — W3C/RDF cameo (no n10s).** neosemantics is NOT installed and the image only auto-loads
APOC, so instead the live hero subgraph **serializes to RDF Turtle on the fly**
(`bff/src/graph/rdf.ts`, `GET /api/rdf`, header **⤓ Export to RDF (W3C)** button) + hand-authored
`data/rdf/hero.ttl` canonical model + existing SHACL cameo. 4 tests pass vs live graph.

**Phase 5 — production doc.** `../Production_Architecture_and_Design.md` — target-state (RDF/SPARQL
source-of-truth + OWL/SHACL reasoner, LLM narrates only, governance spine, on-prem/VPC), weighted
alternatives scorecard, frontend design-system. See also `../State_of_the_Art_Roadmap.md`.

**Polish deferred (low ROI):** ~~`BeatPlaceholder`/native-button token unification~~ — done below.

## "Fix all remaining + richer data" pass (2026-06-29)

Closed every open item in `../DIRECTION_and_Alignment.md` and added all three more-data options at the
"larger realistic ingest" tier. All live-verified against Docker+Neo4j through the local `claude` CLI
(subscription auth, **no API key** — `/api/diag` `live:true, apiKey:false`). Typecheck clean
(shared+bff+web), web build green (1070 modules), **16/16 tests pass**, ETL idempotent.

**Richer dataset (all 3 options).** +37 nodes / +18 patients. (a) PV breadth: kept the myocarditis
hero (3 hops, 6 cases — guardrail) and added a full **VEGFR2 (KDR) → Reactome angiogenesis →
drug-induced hypertension** chain (ramucirumab, real codes, 6 cases) plus breadth signals BTK→atrial
fibrillation (ibrutinib), HER2→LV dysfunction (trastuzumab), and CPI→colitis & CPI→hypothyroidism
reusing `DRUG-CPI`. (b) Modality: 5 `LiteratureAbstract` (real PMIDs) + 4 `ClinicalTrial` (real NCT
IDs), abstracts embedded (384-dim) so they resolve to concepts via the existing index. (c) Ontology:
5 `OntologySlice` nodes (MeSH/MONDO/OAE/Reactome/MedDRA) with `IN_ONTOLOGY` edges carrying real
external codes — makes the "ontology version" provenance real. New kinds in `shared/src/types.ts`;
constraints in `01_schema.cypher`; `hero.ttl`/`shapes.ttl`/canvas colours/Legend updated. Only the 4
noise nodes (+ the pre-existing myocarditis conflict) flag in `/api/risk`; no new false-flags.

**Beat 4 "Grounded Conversation" + `/ask` citations.** New dedicated beat: a multi-turn surface
reusing the entire live `/ask` path (`ConversationBeat`/`ConversationThread`/`MessageCard`), with a
companion `GraphCanvas` whose nodes light up when you hover a citation chip. `/ask` now emits a real
`citations` event — node IDs extracted from the touched Cypher/rows, intersected with the live graph
(grounded by construction), emitted before `done` (`bff/src/ask/agent.ts`). Single-shot `AskPanel`
unchanged in the other beats. **Live-verified in-browser:** asking "what's the safety signal?"
returned a grounded answer enumerating all **6 signals** (incl. the new ones, with real node IDs), a
**3-query show-your-work trace**, a **"✓ grounded in live Cypher"** badge, and **9 citation chips**
resolving real node IDs to labels.

**Reasoning-upfront staging.** `ExplanationBeat` now reveals the full deterministic path with the
narrator off (a brief "Reasoning computed — narrating…" beat) before the `/narrate` stream starts;
skipped under `prefers-reduced-motion`.

**Button tokens.** `.btn/.btn-nav/.btn-control/.btn-chip` added to `tokens.css`; 13 raw buttons
across App/ExplanationBeat/AskPanel/HopRail/ProvenanceDrawer migrated (no visual regression).

**Architecture diagram.** `../Architecture_Animated.svg` — animated target-state architecture (signal
flows along the trust spine; LLM off the critical path; governance audit marches). Validator `[OK]`;
motion proven at multiple timeline frames; reduced-motion safe.

**Version pins (build-time TODOs retired).** react-force-graph-2d → `1.29.1`; `mcp-neo4j-cypher` →
`0.6.0`; Agent SDK deliberately not a dependency (guarded dynamic import). See §build-time above.

**Bug caught in the UI smoke → CAUGHT AND FIXED:** the live `/ask` answer prose rendered **twice**.
Root cause: the local `claude` CLI's `stream-json` surfaces the final assistant prose twice — a
streamed assistant `text` block **and** a consolidated `result`/`success` event sharing one
`message.id`; the parser emitted a `token` for both. Citations, the Cypher trace, and grounding were
all keyed separately and stayed correct; only the prose doubled. **Fix (only `bff/src/llm/claudeCode.ts`):**
emit the answer from a single canonical source — the terminal `result`/`success` event
(`claudeCode.ts:207–210`) — and stop emitting prose from assistant `text` blocks (those now emit only
the Cypher/schema tool-trace, `claudeCode.ts:190–202`). The `result` event fires exactly once per
turn, so the prose can never double even if the CLI repeats an assistant message. **Verified:** live
`/ask` ×2 produced exactly one token each; full-doubling check (`firstHalf === secondHalf`) → false;
16/16 tests pass; `npm run typecheck` clean (shared/bff/web); `/narrate` live and unaffected (it
parses the single accumulated `result` token fine, and the cloud Messages-API path is untouched —
this fix actually hardens `/narrate` too, since double JSON would have broken `extractJson`).
