# Generative Dashboards — Gap Analysis + Last-Month SOTA Implementation Plan

**Companion to `Dynamic_AI_Driven_Dashboards_Design.md` · pharmaceutical R&D · R&D / PV Trust Graph**
*Date: 2026-07-13 · Window reviewed: 2026-06-12 → 2026-07-13*

> **How to read this document.** Claims are tagged. **[FACT]** = verified in this repository (file + line cited). **[SOTA]** = external development, date-stamped with a confidence flag; vendor self-reported numbers are excluded. **[PROPOSAL]** = recommended, not built. This is a design/gap deliverable — **no code was changed and the app was not run** to produce it.

---

## 0. TL;DR

1. **The design doc is now stale on Phase 3.** Its §5/§9 say Features 9–10 are "Not built." **They are built and wired** — snapshots, schedules, save/publish CRUD, and a Send→Review governance wrap all exist in code. The design doc predates the Phase-3 landing (per the project memory index). This gap-analysis corrects the record.
2. **The one true build gap the doc names is real and unchanged: Feature 4 is cosmetic CSS reveal, not token-level streaming.** Confirmed at three code sites.
3. **The decisive new technical finding (not in the doc): true spec-JSON streaming is NOT reachable via the local Claude Code CLI subscription path.** The CLI can stream free-text tokens and can *constrain* output with `--json-schema`, but it does **not** stream partial JSON for schema-constrained output — Anthropic closed that request as *not planned* on 2025-12-27. Fine-grained tool streaming and `output_config.format` structured outputs are **raw Messages API** features. So the Feature-4 fix only lands on the `LLM_PROVIDER=api` path.
4. Every §7 upgrade (#1–#5) is **not started**; the flat-widget-list *shape* partially anticipates A2UI. Details and file evidence below.

---

## 1. Method & evidence base

Grounded against the shipped code, not the doc's self-description:

| Layer | File | Verified |
|-------|------|----------|
| Contract | `shared/src/dashboard.ts` | Plain-TS spec + `mergeDashboard` + F8/F9/F10 types [FACT] |
| Validator | `bff/src/dashboards/schema.ts` | Zod v4 `.strict()` + grounding super-refine [FACT] |
| Composer | `bff/src/dashboards/composer.ts` | LLM-primary, plain-text completion, regex JSON extract [FACT] |
| Fallback | `bff/src/dashboards/template.ts` | Deterministic safety net [FACT] |
| Certification | `bff/src/dashboards/verified.ts` | Curated `VERIFIED_QUERIES` [FACT] |
| Snapshots (F9) | `bff/src/dashboards/snapshots.ts` | Schedule + snapshot store [FACT] |
| Save/publish (F10) | `bff/src/dashboards/store.ts` | Saved-board CRUD store [FACT] |
| Snapshot executor | `bff/src/playbooks/scheduler.ts` `composeSnapshot` (L129) | Headless recompose via unchanged composer [FACT] |
| Emit seam | `bff/src/ask/aguiBridge.ts` (L382–446) | `render_dashboard` tool call (one delta) [FACT] |
| HTTP surface | `bff/src/server.ts` (L782–893) | `/api/dashboards` CRUD, `/review`, `/schedules`, `/run-now` [FACT] |
| CLI provider | `bff/src/llm/claudeCode.ts` | `claude -p --output-format stream-json` wrapper [FACT] |
| Renderer | `web/src/dashboards/dashboardRenderer.tsx` | Whole-spec render + lineage merge [FACT] |
| Canvas | `web/src/dashboards/DashboardCanvas.tsx` | CSS stagger reveal, brush, badges, Save [FACT] |
| Registry | `web/src/dashboards/registry.tsx` | Kind→primitive map, in-memory `subset()` brush [FACT] |
| Lineage | `web/src/dashboards/lineageStore.ts` | Single-lineage merge store [FACT] |

---

## 2. Job A — Gap analysis

### 2.1 The headline correction: Phase 3 is built (doc says it is not)

The design doc §5 ("Not built [FACT] — Phase 3") and §9 ("Not built — Phase 3") are **out of date**. Both features are present and HTTP-wired:

- **Feature 9 — scheduled snapshots + delta briefs. [FACT, BUILT]**
  `bff/src/dashboards/snapshots.ts` is a full file-backed store mirroring `playbooks/routines.ts`: `DashboardSchedule` upsert (one per key), bounded `DashboardSnapshot` history (`MAX_SNAPSHOTS=60`), Zod-validated on read/write, `snapshotBrief()` delta line. The headless executor is `scheduler.ts` `composeSnapshot` (L129) — it resolves cited nodes from the live graph, enforces a grounding gate ("no cited node resolves ⇒ do NOT compose", L150–165), calls the **unchanged** `composeDashboard`, and diffs against `getLatestSnapshot` via `mergeDashboard`. The ticker fires it on cadence (L240). Routes: `GET /api/dashboards/schedules`, `PUT/DELETE /api/dashboards/schedules/:key`, `POST …/run-now`, `GET /api/dashboards/snapshots` (`server.ts` L850–893).
- **Feature 10 — publish / save / share + governance. [FACT, BUILT]**
  `bff/src/dashboards/store.ts` persists `SavedDashboard` (inert spec + trusted audit only), **re-validating the spec with the full grounding schema on write** (`savedRecordSchema.spec: dashboardSpecSchema`, L55) so a saved board stays inert+grounded. CRUD at `server.ts` L792–826 (`GET/POST/DELETE /api/dashboards`). The Send→Review wrap is `POST /api/dashboards/review` (L827). The canvas exposes a `💾 Save` button (`DashboardCanvas.tsx` L141–168) that publishes the on-screen spec+audit.

**Consequence for the client story:** the "per-answer artifact → durable, governed asset" narrative the doc lists as *future* is actually *shippable today*. The deliverable's roadmap should be re-sequenced accordingly (§4).

### 2.2 Feature 4 (progressive/streaming) — the one real, still-open gap. [FACT]

Confirmed cosmetic-only at three sites:

1. **Emit is one delta.** `aguiBridge.ts` sends the entire validated spec in a single `TOOL_CALL_ARGS` (L431–437); the inline comment concedes it: *"the args carry the whole validated spec in one delta … per-widget byte-streaming is deferred; the frontend reveals widgets progressively via staggered entry."* (L388–390).
2. **The composer's own LLM call is not internally streamed either.** `composer.ts` accumulates `token` events into a string (L107) and parses the finished text. But the CLI provider only ever emits ONE `token` event carrying the whole final answer — see `claudeCode.ts` L221–223: the token is emitted from the terminal `result`/`success` event, and the streamed assistant text blocks are *deliberately not* forwarded (to avoid the CLI's double-emit). So there is no incremental text to stream even before the AG-UI seam.
3. **The reveal is pure CSS.** `DashboardCanvas.tsx` animates each tile with `rnd-dash-in` on a `i * 60ms` stagger (L268–273), gated by `useMotion()`. Tiles do not paint as the model types; they animate in after the whole spec arrives.

**This gap is unchanged since the doc was written, and §3 below shows *why* it cannot be closed on the CLI path.**

### 2.3 §7 recommended upgrades — status against code

| # | §7 upgrade | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Align spec shape to A2UI + advertise the tile catalogue | **Partial (shape only) / Not started (handshake)** [FACT] | Flat widget list already matches A2UI's `{component,…props}` shape (`dashboard.ts` `DashboardWidget`). But the kind list is **hard-duplicated in 3 places** — `composer.ts` `KNOWN_KINDS` (L34–42), the prompt's literal kind list (L140), and the Zod enum `widgetKind` (`schema.ts` L25–33) — kept in sync only by tests/typecheck (the doc's own C6 drift risk). No catalogue is advertised to the composer; no JSON-Pointer binding exists. |
| 2 | Structured outputs + fine-grained streaming | **Not started** [FACT] | Composer is a plain text completion — `allowedTools: undefined, maxTurns: 1` (`composer.ts` L111–112), JSON recovered by `extractJsonObject` regex (L213–223) then Zod-validated with a template fallback. No `output_config.format`, no `--json-schema`, no streaming tool path anywhere. |
| 3 | Incremental parse-and-heal + JSON-Pointer binding | **Not started** [FACT] | `dashboardRenderer.tsx` renders `args.spec` whole (L48–52); no partial-JSON parser, no pointer resolution. |
| 4 | cosmos.gl v3 big-graph tile | **Not started** [FACT] | `evidence-subgraph` maps to the SVG `EvidenceSubgraph` primitive (`registry.tsx` L93–94, importing `GroundedDiagrams`). No node-count threshold, no GPU path. |
| 5 | Mosaic / DuckDB-WASM cross-filter at scale | **Not started** [FACT] | F5 brush is an in-memory `Set` filter in `subset()` (`registry.tsx` L51–63) over `focusIds` in `DashboardCanvas` state (L92). No DuckDB, no Mosaic Selections. |

### 2.4 §6 SOTA items — adoption status in code

| §6 SOTA item | Adopted in repo? | Evidence |
|--------------|------------------|----------|
| A2UI flat shape | **Partially** — shape yes, catalog/pointer no [FACT] | `DashboardWidget` is flat; no handshake (§2.3 #1). |
| Structured outputs | **No** [FACT] | §2.3 #2. |
| Fine-grained tool streaming | **No** [FACT] | §2.2, §2.3 #2. |
| Parse-and-heal streaming | **No** [FACT] | §2.3 #3. |
| cosmos.gl v3 | **No** [FACT] | §2.3 #4. |
| Mosaic / DuckDB-WASM | **No** [FACT] | §2.3 #5. |
| "Citation grounding" (auditable provenance) | **Yes** [FACT] | Certified badges + `DashboardAudit` (`verified.ts`, `aguiBridge.ts` L397–418, `DashboardCanvas.tsx` L174–203); trust-split invariants in `CLAUDE.md`. |
| `streamUI` paused | **N/A — correctly avoided** [FACT] | The build rides the existing AG-UI `render_dashboard` channel; no RSC-streamed UI. |

### 2.5 Other gaps between design-intent and shipped code

- **Catalog drift is latent, not structural. [FACT]** The 3-way kind duplication (§2.3 #1) is caught only by tests + typecheck, exactly the doc's C6 concern; nothing *structurally* prevents a composer/renderer divergence.
- **Composer model is the narrator model, not a fast tier. [FACT]** `composer.ts` L115 uses `config.narrator.model`; the "Haiku-class fast composer" (doc C5) is unwired. On the CLI path a second `narrator.model` compose after every answer is the 10–25 s cost the doc's C1 flags.
- **Audit `model`/`estimated` come from a *heuristic* ledger scan. [FACT]** `aguiBridge.ts` L410 picks `recentEntries(50).find(e => e.surface === "dashboard")` — the most recent dashboard-surface FinOps entry, not a hard correlation to *this* compose call. Under concurrency the audit could attribute the wrong call's token proof. Low-severity, but not a guaranteed 1:1 binding.
- **`verifiedQueryIds` is reconstructed from widget *kind*, not the original match. [FACT]** `aguiBridge.ts` L405 rebuilds the query id via a `kind→id` map rather than carrying `certifySpec`'s actual `verifiedQueryIds`. Because `VERIFIED_QUERIES` currently has one entry per kind this is lossless today, but it will silently mis-map if two verified queries ever share a widget kind.
- **`stat-chart` certification is kind-only. [FACT]** `vq-signal-disproportionality` requires a `SignalStat` node but not that `prr`/`ror` attrs actually resolve; the renderer separately draws nothing when they're absent (`registry.tsx` L95–100), so a tile can be "✓ Certified" yet render empty. Cosmetic mismatch, worth a note for reviewer training (doc C3 residual risk).

---

## 3. Job B — Last-month SOTA refresh (2026-06-12 → 2026-07-13)

Corrections and extensions to the design doc's §6. Primary sources preferred; vendor marketing excluded.

### 3.1 Anthropic structured outputs — GA, and the exact API shape

**[SOTA, confidence: high, as of 2026-07-13]** Structured Outputs are **GA** on the Claude API across current models (incl. Opus 4.8, Sonnet 5/4.6, Haiku 4.5). The GA parameter is **`output_config.format`** carrying a JSON Schema — **no beta header**. A prior beta used `output_format` + header `structured-outputs-2025-11-13`; that older `output_format` is deprecated (the direct API still tolerates it temporarily; **Amazon Bedrock already rejects it**). No recursive schemas.
→ **Doc correction:** the design doc §7 #2 already names `output_config.format` — that is now confirmed correct; add the header-vs-GA nuance and the Bedrock-rejects-deprecated caveat so the build never emits the stale `output_format`.
Sources: platform.claude.com structured-outputs; vercel/ai #12298; Helicone #5639.

### 3.2 Fine-grained tool streaming — still beta-gated, now per-tool

**[SOTA, confidence: high, as of 2026-07-13]** Fine-grained tool streaming lets tool-call arguments stream **without buffering or JSON validation** — so a partial stream can be invalid JSON (parse-and-heal is mandatory; if `max_tokens` hits mid-parameter the stream ends incomplete). Activation is the beta header **`fine-grained-tool-streaming-2025-05-14`**, now supplemented by a **per-tool `eager_input_streaming` field** that replaces the blanket header (explicit `false` keeps buffered streaming). Supported on Claude 4-class models (Opus 4, Sonnet 4.5, Haiku 4.5, …).
→ **Doc correction:** the doc labels this "→ GA." That is **too strong** — it remains **beta-header / per-tool-field**, not headerless GA. Downgrade the doc's confidence claim and record the `eager_input_streaming` field as the forward-looking form.
Sources: platform.claude.com fine-grained-tool-streaming; @mc_anthropic (X) launch thread; pi-mono #3575 (proxy regressions on the field).

### 3.3 THE decisive question — is streaming reachable on the local Claude Code CLI?

**[SOTA + FACT, confidence: high, as of 2026-07-13] Definitive answer: NO — true spec-JSON streaming is only reachable via the raw Messages API path (`LLM_PROVIDER=api`), not the local `claude -p` subscription path.** Three sub-findings:

1. **The CLI *can* stream free-text tokens** with `--output-format stream-json --verbose --include-partial-messages` (emits `content_block_delta` events). **[SOTA]** But this repo's wrapper does **not** pass `--include-partial-messages` and, by design, forwards only the terminal `result` as a single token (`claudeCode.ts` L98–105 args; L221–223 emit) **[FACT]** — so even plain text is collapsed to one delta today.
2. **The CLI *does* support constrained structured output via `--json-schema`** (result lands in `result.structured_output`). **[SOTA]** This is the CLI's analogue of structured outputs and is reachable on the subscription path — it would kill the malformed-spec class.
3. **But the CLI does NOT stream partial JSON for `--json-schema` output.** The schema-constrained JSON appears **only in the final `result.structured_output`**, never as incremental `input_json_delta` deltas. This was filed as claude-code issue #15511 (2025-12-27) and **closed as *not planned*.** **[SOTA, confidence: high]**
4. **`output_config.format` (structured outputs) and `eager_input_streaming` / the fine-grained-streaming beta header are Messages-API request parameters — the `claude` CLI exposes neither.** **[SOTA]**

**Net:** the Feature-4 fix (tiles painting as the spec streams) is a **Messages-API-only** capability. On the local CLI subscription path the best achievable is (a) constrain with `--json-schema` (no streaming) and (b) stream the *narrative* text with `--include-partial-messages`. The design doc §7 #2 conflates the two paths by implying fine-grained streaming closes the gap generally — **it does not on the CLI.** This is the single most important correction for the build.
Sources: code.claude.com/docs headless; claude-code #15511 (closed, not planned); backgroundclaude.com stream-json; ClaudeLog output-format.

### 3.4 A2UI — v0.9.1 production, v1.0 = Candidate (dated)

**[SOTA, confidence: high]** A2UI v1.0 is a **release Candidate as of 2026-06-08**; **v0.9.1 remains the production line**, with a published v0.9.1→v1.0 evolution guide. Core: a **stream of JSON messages** with **progressive rendering** (renderer builds/updates the UI per message), **catalog IDs conventionally formatted as URIs but not required to be resolvable** (client+server agree on well-known catalog IDs), and **JSON-Pointer (RFC 6901) data binding** separating UI structure from application state.
→ **Doc status:** the doc's §6 row ("v0.9.1 production; v1.0 = RC") is **accurate**; add the 2026-06-08 Candidate date and the "catalogId need not be resolvable" nuance so we don't over-engineer a network-resolvable catalogue.
Sources: a2ui.org/specification/v1.0-a2ui; InfoQ 2026-07 A2UI genUI; a2ui.org/roadmap.

### 3.5 GPU graph + cross-filter libs — dated

**[SOTA, confidence: high]** **cosmos.gl v3** (OpenJS) migrated its renderer to **luma.gl / WebGL 2** (mobile/tablet support, better GPU utilisation) — confirming the doc's "WebGL 2, not WebGPU" correction. **deck.gl v9** rides luma.gl v9 which *begins* WebGPU support, but **deck.gl's WebGPU path is explicitly not production-ready.** DuckDB-WASM + SQL remains the large-dataset engine (Cosmograph uses exactly this pairing).
**[SOTA, confidence: high]** Concrete **parse-and-heal JS libraries** exist for §7 #3: **`best-effort-json-parser`** (npm) and **`promplate/partial-json-parser-js`** (configurable which types may be incomplete). These are the rendering-half dependency for API-path streaming.
→ **Doc status:** §6 cosmos.gl/Mosaic rows accurate; **extend** with the named partial-JSON libs and the deck.gl-WebGPU-not-prod caveat.
Sources: openjsf.org cosmos-gl-v3; openjsf.org deckgl-v9; deck.gl WebGPU docs; npm best-effort-json-parser; github promplate/partial-json-parser-js.

---

## 4. Ranked, file-level implementation plan

Each item: what changes · files · trust-invariant risk · degrade path. Invariants (from `CLAUDE.md`): spec structurally inert; grounding-root owned by trusted code; compose path read-only; HITL host-chrome only; FAIR canvas byte-identical.

### Plan 1 (do first) — Schema-constrain the composer on BOTH transports
**Why first.** Highest ROI, lowest risk, and reachable on the *subscription* path — it kills the malformed-spec/`extractJsonObject`-regex class the doc's C5 flags, and is the prerequisite for Plan 2. Structured outputs guarantee *shape*, not *grounding*, so it composes cleanly with the existing trust model.
**What changes.**
- API path (`LLM_PROVIDER=api`): pass the `DashboardSpec` JSON-Schema as `output_config.format` (headerless GA; **flat list only — no recursion**).
- CLI path: pass `--json-schema <spec-schema>` and read `result.structured_output` instead of regex-scraping prose.
**Files.** `bff/src/dashboards/composer.ts` (schema plumb-through, drop the regex path to a fallback), `bff/src/llm/claudeCode.ts` (add `--json-schema` arg + surface `result.structured_output`), a new `bff/src/dashboards/specSchema.json` (or derive from Zod).
**Invariant risk.** Low. **Keep the grounding-root injection and `validateSpec` exactly as-is** (`composer.ts` L200–208) — structured outputs cannot be trusted to ground; Zod stays the source of truth.
**Degrade path.** On any schema-unsupported provider/version, fall back to today's regex-extract + template — unchanged behaviour.

### Plan 2 — True token streaming of the spec — **API path only**
**Why.** The honest Feature-4 fix. §3.3 proves it is unreachable on the CLI, so scope it explicitly to `LLM_PROVIDER=api` and market it as the "fast, live-painting" tier (the doc already names the API path as the latency lever).
**What changes.**
- Compose via the Messages API tool path with **`eager_input_streaming: true`** (or the `fine-grained-tool-streaming-2025-05-14` header); stream `input_json_delta` fragments.
- Emit incremental `TOOL_CALL_ARGS` deltas from the bridge instead of one delta (`aguiBridge.ts` L431).
- Front-end consumes deltas with a **parse-and-heal** parser (`best-effort-json-parser`), rendering only *complete, grounded* widgets and healing on the next chunk.
**Files.** new `bff/src/llm/messagesApi.ts` (streaming compose for the API provider), `bff/src/dashboards/composer.ts` (streaming branch), `bff/src/ask/aguiBridge.ts` (per-widget arg deltas), `web/src/dashboards/dashboardRenderer.tsx` (partial parse), `web/src/dashboards/DashboardCanvas.tsx` (render-complete-only, keep draw-nothing).
**Invariant risk.** Medium — **a partial spec must never paint an ungrounded intermediate.** Mitigate: resolve every id against the live graph before paint (reuse `resolveCited`), keep the draw-nothing discipline for un-resolvable ids, and never render a widget until its object is structurally complete. Fine-grained streams carry **no JSON-validity guarantee**, so the heal step is mandatory, not optional.
**Degrade path.** CLI/subscription path and any non-API provider keep today's whole-spec emit + CSS stagger reveal (Plan 1's `--json-schema` still constrains them). Feature 4 becomes "streamed on API, revealed on CLI" — an honest, documented split.

### Plan 3 — A2UI catalog handshake to kill the 3-way drift (doc C6)
**Why.** Removes the latent catalog-drift gap (§2.5) *structurally* rather than by test, and future-proofs the contract against A2UI v1.0 without coupling to its wire format (still Candidate as of 2026-06-08).
**What changes.** Single-source the widget catalogue: derive `composer.ts` `KNOWN_KINDS`, the prompt's kind list, and the Zod enum from **one** shared catalogue object; advertise that list into the composer prompt (and, later, an A2UI catalog message with a non-resolvable well-known `catalogId`). Align field names toward `{component, props}` while **keeping the Zod schema as the source of truth.**
**Files.** `shared/src/dashboard.ts` (export the catalogue), `bff/src/dashboards/schema.ts` (enum from catalogue), `bff/src/dashboards/composer.ts` (prompt fed from catalogue), `web/src/dashboards/registry.tsx` (advertise its renderable kinds).
**Invariant risk.** Low. Inert-value contract untouched; adopt A2UI *shape*, not transport.
**Degrade path.** If A2UI v1.0 ships a breaking wire change, the shared catalogue + Zod schema remain internal and stable; only an optional adapter would change.

### Deferred (named, not dropped)
- **Plan 4 — cosmos.gl v3 `evidence-subgraph-large` path** above a node-count threshold (WebGL 2 / luma.gl); keep SVG force-graph for small certified graphs (legibility + certification favour SVG at small N). Risk: bundle size, WebGL context mgmt. Pull only when union subgraphs degrade.
- **Plan 5 — Mosaic Selections over a DuckDB-WASM table** materialised *from* the grounded rows behind the existing brush API; small-data stays on `subset()`. Grounding preserved (table built from cited rows, never fetched independently).
- **Fast-tier composer** — route the second compose to a Haiku-class model to cut the C1/C5 cost; `composer.ts` L115 currently uses `narrator.model`.
- **Audit binding hardening** — carry `certifySpec`'s real `verifiedQueryIds` and correlate the FinOps entry to *this* compose call rather than the heuristic `recentEntries(50).find(...)` scan (§2.5).

**Recommended sequence.** Plan 1 (both paths, immediate, low-risk) → Plan 3 (structural drift fix) → Plan 2 (API-path streaming, the marquee UX win) → Plans 4/5 as data size demands. Phase 3 (F9/F10) is **already shippable** — surface it in the demo narrative now rather than as "future."

---

## 5. Source ledger

Repository (all [FACT], line-cited inline):
`shared/src/dashboard.ts`, `bff/src/dashboards/{composer,schema,template,verified,snapshots,store}.ts`, `bff/src/playbooks/scheduler.ts`, `bff/src/ask/aguiBridge.ts`, `bff/src/server.ts`, `bff/src/llm/claudeCode.ts`, `web/src/dashboards/{dashboardRenderer,DashboardCanvas,registry,lineageStore}.{tsx,ts}`, `rnd-trust-graph/CLAUDE.md`.

External [SOTA] (accessed 2026-07-13):
- Structured outputs GA / `output_config.format`: https://platform.claude.com/docs/en/build-with-claude/structured-outputs · https://github.com/vercel/ai/issues/12298 · https://github.com/Helicone/helicone/issues/5639 (confidence: high)
- Fine-grained tool streaming (beta header + `eager_input_streaming`): https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming · https://x.com/mc_anthropic/status/1932973816608604523 · https://github.com/badlogic/pi-mono/issues/3575 (confidence: high)
- Claude Code CLI streaming / `--json-schema` / partial-JSON gap: https://code.claude.com/docs/en/headless · https://github.com/anthropics/claude-code/issues/15511 (closed, not planned, 2025-12-27) · https://backgroundclaude.com/blog/stream-json · https://claudelog.com/faqs/what-is-output-format-in-claude-code/ (confidence: high)
- A2UI v1.0 Candidate (2026-06-08) / v0.9.1 production: https://a2ui.org/specification/v1.0-a2ui/ · https://www.infoq.com/news/2026/07/google-a2ui-genui/ · https://a2ui.org/roadmap/ (confidence: high)
- cosmos.gl v3 (WebGL 2/luma.gl) · deck.gl v9 WebGPU-not-prod: https://openjsf.org/blog/cosmos-gl-v3 · https://openjsf.org/blog/deckgl-v9 · https://deck.gl/docs/developer-guide/webgpu (confidence: high)
- Parse-and-heal libs: https://www.npmjs.com/package/best-effort-json-parser · https://github.com/promplate/partial-json-parser-js (confidence: high)

*No code was modified and the application was not run in producing this analysis.*
