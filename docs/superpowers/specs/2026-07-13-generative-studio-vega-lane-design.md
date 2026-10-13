# Generative Studio — sandboxed Vega-Lite lane (design spec)

Date: 2026-07-13. Status: approved direction (user picked "Sandboxed generative lane", separate beat).
Research basis: three verified 2026-07-13 briefs (Vega security/versions, LLM→VL reliability, alternatives
sanity-check); Vega-Lite confirmed over ECharts/Plotly/Observable Plot. The interactivity-SOTA strand did
not complete — cross-filter mechanics below use documented Vega APIs; animation polish is verify-at-build.

## 1. What this is

A new **Generative Studio** beat: split view — grounded chat on the left, a live generative canvas on the
right. Unlike Dashboard Studio (7 fixed widget kinds, structurally inert spec), the LLM here composes
**charts it designs itself** — but only as **Vega-Lite encoding skeletons**. The model never emits a data
value; every tile's data is bound **server-side from already-cited graph nodes**. This lifts the
"fixed charts" ceiling without opening the trust boundary.

**The core trade, stated honestly:** generative tiles are **exploratory** — badged as such, never
"certified". Schema validity is enforceable (allowlist + repair); *semantic* correctness is not
(benchmarks: 20–35% first-shot wrong-aggregate/filter errors pass every validator). The grounding story
(server-bound values, cited-only fields, badge + audit sidecar) is the differentiator, not a validity claim.

## 2. Invariants (unchanged, binding)

- **Classic `DashboardSpec` untouched.** Generative tiles are a SEPARATE payload and tool call
  (`render_generative`) — never added to the `DashboardWidget` union; the certified lane stays as-is.
- **Grounded-only emission**: same gate as dashboards (`grounded && publishedIds.length > 0`); a
  refusal/fallback draws nothing. No new answer path — chat still flows through askGrounded.
- **Read-only compose path**: no graph writes anywhere in this lane (writes stay in `hitl/ops.ts` /
  `safety/ops.ts`).
- **HITL/approval UI is host-chrome only** — nothing in a generative spec can render an Approve dialog.
- **Transport metadata rides ALONGSIDE the spec** in tool-call args (`runId`, `final`, audit), never inside it.
- FAIR canvas byte-identical; full `npm test` never run (hangs) — targeted subsets only.

## 3. Trust model — spec/data split

```
LLM emits            server binds              client renders
─────────────        ─────────────────         ──────────────────────────
mark + encoding      datasets from cited       vega-embed, locked runtime
(field→channel),     nodes/edges ONLY:         (ast interpreter, deny-all
selections (min),    {"cited": [...rows],      loader, canvas, actions off,
"data":{"name":      "edges": [...rows]}       usermeta stripped)
 "cited"}            + typed field menu
```

1. **Model output** — a `GenerativeTile`: `{ id, title, vlSkeleton }` where `vlSkeleton` is a Vega-Lite
   fragment: `mark`, `encoding` (field→channel), optional `transform` (filter/aggregate from an allowlisted
   subset), optional `params` (selections), and `data: {"name": "cited"}` (or `"edges"`). Nothing else.
2. **BFF validation** — Zod v4 allowlist (`bff/src/generative/schema.ts`). REJECTS (hard):
   - `usermeta` anywhere (vega-embed deep-merges spec usermeta OVER host options — a spec could re-enable
     eval by flipping `ast: false`; verified in vega-embed 7.1.0 source),
   - `data.url` / `data.values` / any inline data; datasets are named-reference only,
   - marks: only `bar | line | point | area | rect | tick | text-with-field-ref`; NO `image`,
   - channels: positional/color/size/opacity/tooltip-as-field-refs; NO `href`; tooltip must be plain field
     refs (an object with `image` becomes a raw `<img>` that bypasses the vega loader — exfil channel),
   - selections: `point` / `interval` only; NO lasso (CVE-bearing), NO `on`/`events` overrides,
   - NO expression strings anywhere (`expr`, `datum`-string filters, signal refs) — filters are a typed
     `{field, op, value}` grammar the server compiles, never free-text VL predicate strings,
   - fields must resolve against the server's field menu (cited-data columns), else repair/reject.
3. **Server binding** (`bff/src/generative/bind.ts`) — deterministic: cited nodes → `cited` rows
   (id, label, kind, degree, group, flagged, reviewed…), cited edges → `edges` rows. Produces the
   **typed field menu** `{name, vlType, cardinality}` used in BOTH the composer prompt and validation.
4. **Client runtime** (`web/src/generative/VegaTile.tsx`) — lazy `import('vega-embed')`; options:
   `{ ast: true, actions: false, renderer: 'canvas', loader: denyAllLoader /* instance: load/sanitize/http/file all reject */, tooltip: default-sanitized }`;
   `delete spec.usermeta` again client-side (defense in depth); `result.finalize()` on unmount; never
   attach `vega`/`View`/`VEGA_DEBUG` to `window`. Data injected via the embed spec's `datasets` map,
   server-provided — the skeleton only names it.

### Version floors (CI-asserted, not just package.json)

`vega ≥ 6.2.0`, `vega-lite ^6.4.3`, `vega-embed ^7.1.0` — AND transitive floors `vega-functions ≥ 6.1.1`,
`vega-selections ≥ 6.1.2`, `vega-expression ≥ 6.1.0`, `vega-interpreter ≥ 2.2.1`. The Jan-2026 XSS fixes
(CVE-2025-66648, CVE-2025-65110) arrive only via transitive resolution — vega 6.2.0's tilde ranges ADMIT
the vulnerable versions, so a stale lockfile keeps them silently. A tiny BFF test reads the web lockfile
and asserts the resolved floors. `npm audit` on install: 0 vulnerabilities (verified 2026-07-13).

Bundle: ~277 KB gz for the trio — kept out of the entry chunk (`manualChunks: { vega: [...] }` +
`React.lazy` tile), loaded on first Generative Studio render only.

## 4. Architecture — seams (all verified in source)

- **Transport**: `copilotRuntime.ts` registers a SECOND named agent:
  `generative: new HttpAgent({ url: aguiUrl + "?compose=generative" })`. The Generative Studio chat binds
  agent id `generative`; classic surfaces keep `default`. One BFF, one bridge, no second answer path.
- **Bridge** (`aguiBridge.ts`): reads `compose=generative`; the sink gains `generative-delta` /
  `generative` cases emitting a self-contained `render_generative` tool call per tile
  (START/ARGS/END, byte-pattern of the dashboard cases) with `{ tile, datasets, fieldMenu, runId, final,
  audit }` in args — reusing the **run-generation gate** that just landed (runId/final semantics identical).
- **Composer** (`bff/src/generative/composer.ts`): invoked on the grounded branch of `agent.ts` when
  `compose=generative` (instead of the dashboard composer). Prompt = question + answer summary + **typed
  field menu with cardinality** (the single highest-leverage reliability lever per 2026 research) + strict
  instructions (skeleton-only, named data, allowlist summary). Streaming: reuses the brace-balanced
  parse-and-heal scanner at **tile granularity** — a tile is forwarded only when its JSON closes AND passes
  the allowlist AND its fields resolve. Repair: ≤2 rounds, validator errors fed back verbatim; deterministic
  pre-fixes first (type coercions, aggregate defaults). Cap: 6 tiles. Then a final reconcile (`final: true`).
- **Fallback** (`bff/src/generative/templates.ts`): deterministic Vega-Lite templates (bar-by-kind,
  degree-distribution, flagged-vs-reviewed) from the same bound datasets when the model output is invalid /
  repairs exhausted / timeout — the canvas never renders nothing on a grounded answer, and never ungrounded.
- **Web store** (`web/src/generative/generativeStore.ts`): same run-gate pattern as lineageStore
  (committed/rollback, seenRuns, sig cache) — tiles accumulate per surface `"generative"`, retired-run
  re-renders dropped. Renderer declares `runId`/`final` in its zod-v3 args schema (v3 strips undeclared keys).
- **Beat** (`web/src/generative/GenerativeStudio.tsx` + `App.tsx` `"generative"`): split view mirroring
  DashboardStudio (all 4 layout guards); left `CopilotChatBeat` bound to the `generative` agent with a
  chip-mode renderer ("→ opened in canvas"); right a subscribed canvas of VegaTiles with badges.
- **Cross-filter**: allowlisted `params` (point/interval) → `result.view.addSignalListener` → a shared
  filter store keyed by the selected datum ids → sibling tiles re-render with the subset (client-side
  filter of the server-bound rows — no new data path) → same ids bridge to the existing `focusIds` /
  `onNodeClick` pattern so the graph canvas and chat context pills participate. (Animation polish —
  `view.change` changesets vs re-embed — decided at build time; the strand covering SOTA patterns didn't
  complete.)
- **Trust UX**: every tile carries an **"exploratory" badge** + an audit sidecar line (model, run id,
  cited-node count, faithfulness link). No certified badge in v1. A "🛡 how this is safe" popover explains
  the spec/data split in one paragraph.
- **FiltersPopover** (bundled UX ask): the always-open graph Filters rail becomes an on-demand popover
  (`FiltersPopover.tsx` wrapping the existing `FiltersRail` content; trigger button in the canvas header),
  reclaiming canvas width on all beats that show it.

## 5. Failure modes (red-team, from verified research)

| Threat | Answer |
|---|---|
| Spec flips off the safe interpreter via `usermeta.embedOptions` | Zod hard-reject + client `delete spec.usermeta` (two layers) |
| Data exfil via `data.url`, image marks, `href`, tooltip `image` | All four rejected in the allowlist; deny-all loader instance; canvas renderer; CSP later |
| XSS via selections machinery (CVE-2025-65110 class) | Floor `vega-selections ≥ 6.1.2` CI-asserted; lasso denied; point/interval only |
| Expression-string gadget chains (CVE-2025-59840 class) | No expr strings pass validation; `ast: true`; no vega globals on `window` |
| Stale lockfile reintroduces patched CVEs | Lockfile floor test in CI |
| Semantically wrong chart (20–35% first-shot per VisEval) | Field menu prompting + ≤2 repair rounds + literal-vs-bound-values check + **exploratory badge** (honest residual) |
| Model emits inline values anyway | Rejected; repair round says "reference data by name only"; fallback templates if unrepaired |
| Prompt-injected node labels steering the composer | Labels enter only as DATA rows, never as prompt instructions; field menu is server-derived names/types |

Deferred (named, not silent): iframe sandbox (Kibana-parity posture chosen: locked loader + patched floor
+ no globals; iframe would break the cross-filter/askRef bridges — revisit if a new CVE class demands it);
Draco-style mark-choice scoring; A2UI envelope adapter; saving/publishing generative boards (classic lane
keeps Save; exploratory tiles are session-scoped in v1).

## 6. Testing & gates

- **BFF targeted** (`bff/src/generative/*.test.ts`): allowlist rejects each threat-table row
  (usermeta/url/values/image/href/lasso/expr/on-events/unknown-field); bind determinism; field-menu shape;
  composer repair loop (invalid→repaired, exhausted→template); grounding gate (refusal/fallback → nothing);
  tile cap; streaming healer forwards only closed+valid tiles.
- **Web targeted**: generativeStore run-gate (reuse the lineage suite shape incl. final-cache-hit commit);
  renderer args schema declares runId/final; filter-store subset logic; VegaTile lockdown options
  (unit-assert the embed options object; no window.vega after mount).
- **Gate**: `npm run typecheck` (3 ws) → targeted suites → live render-proof on :5173 (grounded ask in the
  Generative Studio → tiles stream in, exploratory badges, cross-filter click narrows siblings + sets
  focusIds, FinOps ledger `estimated:false`) → zero console errors. Full `npm test` never.
