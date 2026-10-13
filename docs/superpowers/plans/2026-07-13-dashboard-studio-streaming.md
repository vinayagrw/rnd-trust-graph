# Implementation Plan — Dashboard Studio + Genuine Token-Streaming

*rnd-trust-graph · R&D/PV Trust Graph · 2026-07-13*
*Executes the approved spec `docs/superpowers/specs/2026-07-13-dashboard-studio-streaming-design.md`.*

---

## Goal

Ship three things in one cycle over the untouched grounded `/ask` pipeline: (1) a first-class **Dashboard Studio** beat — split view, grounded chat left, a persistent live `DashboardCanvas` right; (2) **genuine free-text token-streaming** of the dashboard composer so tiles paint *as the model types them* (parse-and-heal over the existing F7 merge engine), opt-in on the local Claude Code CLI via `--include-partial-messages`; (3) a **stream-error / NOT_IN_GRAPH UX fix** (resumable "still composing" + a branded honest-refusal card). Plus bugfixes **B1** (duplicate React keys) and **C5/B2** (working-board loss on reload).

## Architecture

- **BFF (`bff/`, Node + tsx + Fastify):** `claudeCode.ts` spawns the local `claude` CLI and parses newline-delimited `stream-json`. The composer (`dashboards/composer.ts`) is a *plain-text JSON completion* (NO tool call), run by `agent.ts` `emitDashboard` after the answer settles; `aguiBridge.ts` translates sink events into AG-UI SSE (`render_dashboard` tool call). Grounding root is composer-owned and Zod-validated (`dashboards/schema.ts`) before emit.
- **Shared (`shared/`, plain TS, NO zod):** `types.ts` `StreamEvent` union + `dashboard.ts` DashboardSpec/`mergeDashboard` (append-by-widget-id — *streaming is just repeated merge*).
- **Web (`web/`, React + Vite + CopilotKit v2):** `dashboardRenderer.tsx` calls `lineageStore.applyIncoming` → `DashboardCanvas.tsx`. `CopilotChatBeat.tsx` registers `renderToolCalls` on the provider; `App.tsx` owns the beat nav.

## Tech Stack

TypeScript across three workspaces (`shared` consumed as raw TS by both). BFF: `node:test` runner via `node --import tsx --import ./test-setup.ts --test`. Zod v4 (BFF) / Zod v3 (web tool-call args). React 18, CopilotKit `@copilotkit/react-core/v2`, `@ag-ui/core@0.0.42`. LLM via local `claude` CLI (`LLM_PROVIDER=claude-code`, subscription auth).

## Global Constraints (trust invariants — bind EVERY task, verbatim from spec §3 + CLAUDE.md)

- **Spec stays structurally inert** — no new field can carry a value/URL/HTML/Mermaid; streaming emits the *same* widget shape, just earlier.
- **Grounding root is composer-owned and re-filtered on every partial** — a streamed partial can never reference an un-cited node.
- **Compose/agent path stays read-only** — no graph writes; all writes remain via `hitl/ops.ts` (safety via `safety/ops.ts`).
- **HITL/approval widgets stay host-chrome** — never spec-expressible, even mid-stream.
- **FAIR canvas byte-identical** — `graph/queries.ts` keeps `WHERE NOT n:Safety`; untouched.
- **New store event / StreamEvent variant is additive** — no new overlay `ChangeOp` (so no `store.ts rebuildOverlay` replay needed).
- **3-workspace zod split:** authoritative runtime schema is BFF Zod v4 (`dashboards/schema.ts`); web re-declares a light Zod v3 arg schema at the tool-call boundary; `@rnd/shared` carries plain types only, NO zod.
- **Test gate before "done":** `npm run typecheck` (3 workspaces) → **targeted** BFF tests (`node --import tsx --import ./test-setup.ts --test src/<path>.test.ts` — full `npm test` HANGS on CLI eval tests) → live render-proof on `:5173` (`estimated:false` in the FinOps ledger is the definitive live-vs-cached proof).

---

## File Structure

### Created

| File | One responsibility |
|---|---|
| `web/src/dashboards/DashboardStudio.tsx` | The Studio split-view container: reuses `CopilotChatBeat` (`dashboardTarget:"pane"`) left, a subscribed persistent `DashboardCanvas` right, empty-state starters. |
| `web/src/dashboards/studioPaneStore.ts` (optional — see T6) | *Only if* per-surface keying is done by a second store instance rather than a `surface` param. Default plan keeps ONE store keyed by surface, so this is NOT created. |
| `bff/src/dashboards/streaming.test.ts` | Pure parse-and-heal tests (half-widget → no emit; un-cited id filtered per partial; grounding root on every delta; final == buffered-parse-once). |
| `bff/src/llm/claudeCode.test.ts` | `streamPartial` unit tests over the extracted pure line-handler (incremental tokens, no double prose, finops once). |
| `web/src/dashboards/lineageStore.test.ts` (node/jsdom-free pure test — see T6) | Per-surface isolation + `subscribe` notify. |

### Modified

| File | Change |
|---|---|
| `shared/src/types.ts` | Add `{type:"dashboard-delta"; spec: DashboardSpec}` to the `StreamEvent` union (L826-855). |
| `bff/src/llm/claudeCode.ts` | Add `streamPartial?: boolean` to `ClaudeCodeRunOpts`; add `--include-partial-messages`; extract the per-line handler into a pure exported `handleCliLine`; emit `text_delta` as tokens + suppress terminal `result` prose when streaming (finops still once). |
| `bff/src/dashboards/composer.ts` | Extract `filterWidget`; add `extractCompleteWidgets` (incremental parser) + `composeDashboardStreaming(input, onDelta)`. |
| `bff/src/ask/agent.ts` | `emitDashboard` calls the streaming composer, forwarding `{type:"dashboard-delta"}` per widget; final `{type:"dashboard"}` unchanged. |
| `bff/src/ask/aguiBridge.ts` | Add a `dashboard-delta` sink case → incremental `render_dashboard` TOOL_CALL (START/ARGS/END) per delta. |
| `bff/src/config.ts` | (Optional) confirm/raise `ask.idleTimeoutMs` doc + no code change unless watchdog too tight (T11). |
| `web/src/dashboards/lineageStore.ts` | Per-surface keying (`"studio"\|"conversation"`) + `subscribe(listener)`/notify. |
| `web/src/dashboards/dashboardRenderer.tsx` | Thread a `surface` through `applyIncoming`; accept `dashboardTarget`. |
| `web/src/dashboards/DashboardCanvas.tsx` | `aria-live="polite"` streaming announce; already merges via `changedIds` (streaming reuse). |
| `web/src/beats/CopilotChatBeat.tsx` | `dashboardTarget:"inline"\|"pane"` prop; in `"pane"` mode push to lineage + drop a "→ opened in canvas" chip; B1 key fix. |
| `web/src/App.tsx` | `"studio"` beat: `Beat` union (L42), `BEAT_LABELS` (L101), nav loop (L500), command palette (L346), render branch (L575+), `<DashboardStudio>`. |
| `web/src/components/RefusalCard.tsx` (created) + wired in `CopilotChatBeat` | Branded NOT_IN_GRAPH refusal card with in-graph suggestions (T11). |

---

## Tasks

> Each task: write a failing test → run it (RED) → minimal impl (real code shown) → run it (GREEN) → commit. BFF test command (targeted, full suite HANGS):
> `cd bff && node --import tsx --import ./test-setup.ts --test src/<path>.test.ts`
> Typecheck (all 3 ws, from repo root): `npm run typecheck`.

---

### T1 — Shared `dashboard-delta` StreamEvent variant

**Files:**
- Modify: `shared/src/types.ts` (union at L826-855, add variant after the `dashboard` variant at L854)
- Test: `bff/src/dashboards/streaming.test.ts` (a compile-time usage assertion; the real behavioural tests land in T3)

**Interfaces:**
- Produces: `type StreamEvent |= { type: "dashboard-delta"; spec: DashboardSpec }`

**Steps:**

1. **(RED)** In a new `bff/src/dashboards/streaming.test.ts`, add a stub that references the type so `npm run typecheck` fails until the variant exists:
   ```ts
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import type { StreamEvent } from "@rnd/shared";

   test("dashboard-delta is a valid StreamEvent", () => {
     const ev: StreamEvent = {
       type: "dashboard-delta",
       spec: { version: 1, title: "t", widgets: [{ id: "w", kind: "citation-chips" }], citedNodeIds: ["X"], source: "llm" },
     };
     assert.equal(ev.type, "dashboard-delta");
   });
   ```
2. **(RED)** Run `npm run typecheck` → fails (`dashboard-delta` not assignable).
3. **(GREEN)** In `shared/src/types.ts`, insert after L854 (`| { type: "dashboard"; spec: DashboardSpec; certified?: string[] }`):
   ```ts
   // Genuine token-streaming: one INCREMENTAL dashboard fragment emitted the
   // moment a widget closes during composition (parse-and-heal). Carries the
   // SAME inert widget shape as `dashboard`, just earlier and one/few widgets at
   // a time; the composer re-injects + re-filters the grounding root on every
   // partial, so a delta can never reference an un-cited node. The final
   // `dashboard` event still fires for idempotent reconciliation.
   | { type: "dashboard-delta"; spec: DashboardSpec }
   ```
4. **(GREEN)** Run `npm run typecheck` → passes.
5. **Commit:** `feat(shared): add dashboard-delta StreamEvent variant for token-streaming`.

---

### T2 — `claudeCode.ts` `streamPartial` + partial-message token emit

The CLI wrapper today emits the WHOLE completion as ONE `token` from the terminal `result` (L221-223). Add opt-in streaming: `--include-partial-messages` surfaces `stream_event` → `content_block_delta` → `text_delta`; emit each as a `token`; when streaming, consume the terminal `result` ONLY for FinOps (not as prose) so nothing doubles. Extract the per-line logic into a pure, unit-testable `handleCliLine` (the current inline stdout handler cannot be tested without a real spawn).

**Files:**
- Modify: `bff/src/llm/claudeCode.ts` — `ClaudeCodeRunOpts` (L49-74, add `streamPartial`), spawn `args` (L96-111, add flag), extract L188-268 loop body into `handleCliLine`
- Test: `bff/src/llm/claudeCode.test.ts`

**Interfaces:**
- Consumes: `ClaudeCodeRunOpts { …, streamPartial?: boolean }`
- Produces:
  ```ts
  interface CliLineState { produced: boolean; pendingCypher: Set<string>; }
  export function handleCliLine(
    evt: any,
    opts: { sink: Sink; streamPartial?: boolean; emitTrace?: boolean; finopsSurface?: FinOpsSurface; model: string },
    state: CliLineState,
  ): void
  ```

**Steps:**

1. **(RED)** Create `bff/src/llm/claudeCode.test.ts`:
   ```ts
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import { handleCliLine, type CliLineState } from "./claudeCode.js";

   function drive(events: any[], streamPartial: boolean) {
     const tokens: string[] = [];
     const state: CliLineState = { produced: false, pendingCypher: new Set() };
     const sink = (e: { type: string; [k: string]: unknown }) => {
       if (e.type === "token" && typeof e.text === "string") tokens.push(e.text);
     };
     for (const evt of events)
       handleCliLine(evt, { sink, streamPartial, model: "claude-opus-4-8" }, state);
     return { tokens, state };
   }

   const partials = [
     { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "{\"wid" } } },
     { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "gets\":[]}" } } },
   ];
   const terminal = { type: "result", subtype: "success", result: "{\"widgets\":[]}", usage: { input_tokens: 10, output_tokens: 5 } };

   test("streamPartial: text_delta events stream incrementally", () => {
     const { tokens } = drive([...partials, terminal], true);
     assert.deepEqual(tokens, ["{\"wid", "gets\":[]}"]);
   });

   test("streamPartial: terminal result is NOT re-emitted as prose (no double)", () => {
     const { tokens } = drive([...partials, terminal], true);
     assert.ok(!tokens.includes("{\"widgets\":[]}"), "terminal result must not double the prose");
   });

   test("non-streaming: terminal result emits once (back-compat)", () => {
     const { tokens } = drive([terminal], false);
     assert.deepEqual(tokens, ["{\"widgets\":[]}"]);
   });

   test("streamPartial marks produced when a delta arrives", () => {
     const { state } = drive(partials, true);
     assert.equal(state.produced, true);
   });
   ```
2. **(RED)** Run `cd bff && node --import tsx --import ./test-setup.ts --test src/llm/claudeCode.test.ts` → fails (`handleCliLine` not exported).
3. **(GREEN)** In `claudeCode.ts`, add to `ClaudeCodeRunOpts` (after L73):
   ```ts
   /** Opt-in genuine token-streaming (composer only). Adds --include-partial-messages
    *  so the CLI surfaces content_block_delta/text_delta; each text_delta is emitted
    *  as a `token`, and the terminal `result` is consumed for FinOps ONLY (not prose)
    *  so the answer never doubles. Off (default) preserves the emit-once behaviour. */
   streamPartial?: boolean;
   ```
4. **(GREEN)** Add the flag in the `args` array (after L105, before the mcp block):
   ```ts
   if (opts.streamPartial) {
     args.push("--include-partial-messages");
   }
   ```
5. **(GREEN)** Add the extracted pure handler + its state type near the top (after `type Sink`, L22). Move the FinOps block verbatim from L227-252:
   ```ts
   export interface CliLineState {
     produced: boolean;
     pendingCypher: Set<string>;
   }

   /** Handle ONE parsed stdout JSON event. Pure w.r.t. I/O (no spawn/timers) so it
    *  is unit-testable. Emits assistant text as `token`s and, on the terminal
    *  `result`, records FinOps once. */
   export function handleCliLine(
     evt: any,
     opts: { sink: Sink; streamPartial?: boolean; emitTrace?: boolean; finopsSurface?: FinOpsSurface; model: string },
     state: CliLineState,
   ): void {
     const { sink, streamPartial, emitTrace, finopsSurface, model } = opts;

     // STREAMING: raw Anthropic delta events wrapped by the CLI as `stream_event`.
     // Emit each text_delta as a token the instant it arrives.
     if (streamPartial && evt?.type === "stream_event") {
       const inner = evt.event;
       if (inner?.type === "content_block_delta" && inner?.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
         state.produced = true;
         sink({ type: "token", text: inner.delta.text });
       }
       return;
     }

     // Tool trace (schema/cypher) — unchanged, only when emitTrace is on.
     if (emitTrace && evt?.type === "assistant" && Array.isArray(evt?.message?.content)) {
       for (const block of evt.message.content) {
         if (block?.type === "tool_use") {
           const name: string = block.name ?? "";
           if (name.endsWith("read_neo4j_cypher") && block.input?.query) {
             if (block.id) state.pendingCypher.add(block.id);
             sink({ type: "cypher", query: String(block.input.query) });
           } else if (name.endsWith("get_neo4j_schema")) {
             sink({ type: "step", label: "Inspected the live graph schema" });
           }
         }
       }
     }

     if (evt?.type === "result" && evt?.subtype === "success" && typeof evt?.result === "string" && evt.result) {
       state.produced = true;
       // In streaming mode the prose already arrived via text_delta — DO NOT
       // re-emit it here (that is the double the emit-once design avoided).
       if (!streamPartial) sink({ type: "token", text: evt.result });
       if (finopsSurface) {
         try {
           const u = evt.usage ?? {};
           const inputTokens =
             Number(u.input_tokens ?? 0) +
             Number(u.cache_read_input_tokens ?? 0) +
             Number(u.cache_creation_input_tokens ?? 0);
           const outputTokens = Number(u.output_tokens ?? 0);
           const costUsd = typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : undefined;
           record({ surface: finopsSurface, model, inputTokens, outputTokens, costUsd, estimated: false });
         } catch {
           /* instrumentation must never break the response path */
         }
       }
     }

     if (emitTrace && evt?.type === "user" && Array.isArray(evt?.message?.content)) {
       for (const block of evt.message.content) {
         if (block?.type === "tool_result" && state.pendingCypher.has(block.tool_use_id)) {
           state.pendingCypher.delete(block.tool_use_id);
           const txt = Array.isArray(block.content)
             ? block.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("")
             : "";
           if (txt) sink({ type: "rows", preview: txt.slice(0, 600) });
         }
       }
     }
   }
   ```
6. **(GREEN)** Rewrite the `child.stdout.on("data")` body (L183-270) to delegate. Replace the per-line `for` loop interior (L188-269) with:
   ```ts
   const state: CliLineState = { produced, pendingCypher };
   for (const line of lines) {
     const trimmed = line.trim();
     if (!trimmed) continue;
     let evt: any;
     try { evt = JSON.parse(trimmed); } catch { continue; }
     handleCliLine(
       evt,
       { sink, streamPartial: opts.streamPartial, emitTrace, finopsSurface: opts.finopsSurface, model },
       state,
     );
   }
   produced = state.produced;
   ```
   (Hoist `const pendingCypher = new Set<string>();` — already declared at L91 — and read `produced` back out after each chunk. Delete the now-inlined FinOps + trace blocks.)
7. **(GREEN)** Run the T2 test file → all pass.
8. **(GREEN)** Run `cd bff && node --import tsx --import ./test-setup.ts --test src/llm/verify.test.ts` (a sibling llm test) to confirm no regression in the module, then `npm run typecheck`.
9. **Commit:** `feat(bff): opt-in streamPartial token-streaming in the claude CLI wrapper`.

> **Build-time verify (note in PR):** confirm the CLI's partial-message envelope is `{type:"stream_event", event:{type:"content_block_delta", delta:{type:"text_delta", text}}}` against the installed `claude` version (`echo '{}' | claude -p --include-partial-messages --output-format stream-json --verbose`). If the envelope differs, `handleCliLine`'s first branch is the single place to adjust.

---

### T3 — Composer incremental parse-and-heal (pure, LLM-free)

Extract the widget grounding-filter from `assembleSpec` into a reusable `filterWidget` (so the incremental path re-filters IDENTICALLY — the invariant "grounding root re-filtered per partial"). Add `extractCompleteWidgets` (parse only widgets whose `{…}` has closed in the growing buffer) and `composeDashboardStreaming`.

**Files:**
- Modify: `bff/src/dashboards/composer.ts` (`assembleSpec` L157-209 → factor `filterWidget`; add exports)
- Test: `bff/src/dashboards/streaming.test.ts` (extend T1's file)

**Interfaces:**
- Produces:
  ```ts
  export function filterWidget(w: unknown, citedSet: Set<string>): DashboardWidget | null
  export function extractCompleteWidgets(buffer: string): unknown[]   // only fully-closed widget objects
  export function composeDashboardStreaming(
    input: ComposeInput,
    onDelta: (spec: DashboardSpec) => void,
  ): Promise<DashboardSpec>   // returns the final reconciled spec; calls onDelta per NEW widget
  ```

**Steps:**

1. **(RED)** Add to `streaming.test.ts`:
   ```ts
   import { extractCompleteWidgets, filterWidget, composeFromModelText, type ComposeInput } from "./composer.js";
   import type { GraphNode } from "@rnd/shared";

   const input: ComposeInput = {
     question: "why myocarditis?",
     answerText: "supported by disproportionality metrics.",
     citedNodes: [
       { id: "AE-MYOCARDITIS", kind: "AdverseEvent" as GraphNode["kind"], label: "Myocarditis" },
       { id: "STAT-1", kind: "SignalStat" as GraphNode["kind"], label: "Disproportionality" },
     ],
   };
   const cited = new Set(input.citedNodes.map((n) => n.id));

   test("a half-typed widget yields NO complete widget", () => {
     const buf = '{"title":"S","widgets":[{"id":"a","kind":"citation-chips"},{"id":"b","kind":"evi';
     const done = extractCompleteWidgets(buf);
     assert.equal(done.length, 1);
     assert.equal((done[0] as any).id, "a");
   });

   test("filterWidget drops an un-cited node id (per-partial grounding)", () => {
     const w = filterWidget({ id: "c", kind: "citation-chips", nodeIds: ["AE-MYOCARDITIS", "AE-NOPE"] }, cited);
     assert.deepEqual(w?.nodeIds, ["AE-MYOCARDITIS"]);
   });

   test("filterWidget rejects an unknown kind", () => {
     assert.equal(filterWidget({ id: "x", kind: "iframe" }, cited), null);
   });

   test("streaming reconciliation equals buffered-parse-once (idempotent)", () => {
     const full = JSON.stringify({
       title: "Signal", widgets: [
         { id: "chips", kind: "citation-chips", nodeIds: ["AE-MYOCARDITIS"] },
         { id: "stat", kind: "stat-chart", nodeIds: ["STAT-1"] },
       ],
     });
     // Simulate progressive buffers → the union of emitted deltas' widgets must
     // equal the single-shot parse's widgets (order + ids).
     const emitted: string[] = [];
     const seen = new Set<string>();
     for (let i = 20; i <= full.length; i += 7) {
       for (const w of extractCompleteWidgets(full.slice(0, i))) {
         const fw = filterWidget(w, cited);
         if (fw && !seen.has(fw.id)) { seen.add(fw.id); emitted.push(fw.id); }
       }
     }
     const once = composeFromModelText(full, input);
     assert.deepEqual(emitted, once.widgets.map((w) => w.id));
   });
   ```
2. **(RED)** Run the streaming test file → fails (`extractCompleteWidgets`/`filterWidget` not exported).
3. **(GREEN)** In `composer.ts`, extract the widget filter (replace the L167-195 loop body's per-widget logic with a call). Add:
   ```ts
   /** Filter ONE candidate widget to the inert, grounded contract: known kind,
    *  nodeIds ⊆ cited set, metric only on a metric tile. Returns the clean widget
    *  or null. This is the SINGLE grounding filter — the full assemble and the
    *  streaming path both call it, so a partial can never widen grounding. */
   export function filterWidget(w: unknown, citedSet: Set<string>): DashboardWidget | null {
     if (!w || typeof w !== "object") return null;
     const kind = (w as { kind?: unknown }).kind;
     if (typeof kind !== "string" || !KNOWN_KINDS.has(kind as DashboardWidget["kind"])) return null;
     const widget: DashboardWidget = { id: safeId((w as { id?: unknown }).id), kind: kind as DashboardWidget["kind"] };
     const title = (w as { title?: unknown }).title;
     if (typeof title === "string" && title.trim()) widget.title = title.slice(0, 120);
     const nodeIds = (w as { nodeIds?: unknown }).nodeIds;
     if (Array.isArray(nodeIds)) {
       const filtered = nodeIds.filter((id): id is string => typeof id === "string" && citedSet.has(id));
       if (filtered.length) widget.nodeIds = filtered.slice(0, 64);
     }
     const metric = (w as { metric?: unknown }).metric;
     if (widget.kind === "metric") {
       if (metric === "faithfulness" || metric === "cited-count" || metric === "coverage") widget.metric = metric;
       else return null;
     }
     const span = (w as { span?: unknown }).span;
     if (span === 1 || span === 2) widget.span = span;
     return widget;
   }
   ```
   Then rewrite the `assembleSpec` loop (L166-195) to:
   ```ts
   const widgets: DashboardWidget[] = [];
   for (const w of modelWidgets) {
     const fw = filterWidget(w, citedSet);
     if (fw) widgets.push(fw);
     if (widgets.length >= 8) break;
   }
   ```
4. **(GREEN)** Add the incremental scanner (a brace-balanced object walker scoped to the `widgets` array):
   ```ts
   /** Recover every FULLY-CLOSED widget object from a growing `widgets:[…]` buffer.
    *  A widget whose closing brace has not yet arrived is never returned (draw-
    *  nothing preserved). Tolerates a leading `{ "title": …, "widgets": [` prefix
    *  and trailing partial content. */
   export function extractCompleteWidgets(buffer: string): unknown[] {
     const cleaned = buffer.replace(/```(?:json)?/gi, "");
     const key = cleaned.indexOf('"widgets"');
     if (key === -1) return [];
     const arrStart = cleaned.indexOf("[", key);
     if (arrStart === -1) return [];
     const out: unknown[] = [];
     let depth = 0, objStart = -1, inStr = false, esc = false;
     for (let i = arrStart + 1; i < cleaned.length; i++) {
       const c = cleaned[i];
       if (inStr) {
         if (esc) esc = false;
         else if (c === "\\") esc = true;
         else if (c === '"') inStr = false;
         continue;
       }
       if (c === '"') { inStr = true; continue; }
       if (c === "{") { if (depth === 0) objStart = i; depth++; }
       else if (c === "}") {
         depth--;
         if (depth === 0 && objStart !== -1) {
           try { out.push(JSON.parse(cleaned.slice(objStart, i + 1))); } catch { /* malformed — skip */ }
           objStart = -1;
         }
       } else if (c === "]" && depth === 0) break; // widgets array closed
     }
     return out;
   }
   ```
5. **(GREEN)** Add the streaming driver (mirrors `runComposerLlm` but with `streamPartial` + per-widget `onDelta`):
   ```ts
   /** Compose a dashboard with GENUINE token-streaming: emits `onDelta` with a
    *  one-widget partial spec the instant each widget closes, then returns the final
    *  reconciled spec (idempotent — the caller's lineage store de-dupes by id). On
    *  no-cites / live-off / any failure, returns the template and emits NO delta. */
   export async function composeDashboardStreaming(
     input: ComposeInput,
     onDelta: (spec: DashboardSpec) => void,
   ): Promise<DashboardSpec> {
     const templateOf = () =>
       templateDashboard({ question: input.question, citedNodes: input.citedNodes, strategy: input.strategy });
     if (input.citedNodes.length === 0 || !liveModeAvailable()) return templateOf();

     const citedSet = new Set(input.citedNodes.map((n) => n.id));
     const groundingRoot = input.citedNodes.map((n) => n.id);
     const emittedIds = new Set<string>();
     const controller = new AbortController();
     const hardStop = setTimeout(() => controller.abort(), COMPOSE_TIMEOUT_MS);
     (hardStop as unknown as { unref?: () => void }).unref?.();
     let buffer = "";
     const flush = () => {
       for (const raw of extractCompleteWidgets(buffer)) {
         const fw = filterWidget(raw, citedSet);
         if (!fw || emittedIds.has(fw.id)) continue;
         emittedIds.add(fw.id);
         // Grounding root re-injected on EVERY partial — composer-owned, never the model's.
         onDelta({ version: 1, title: "Evidence dashboard", intent: input.question.slice(0, 400), widgets: [fw], citedNodeIds: groundingRoot, source: "llm" });
       }
     };
     try {
       const res = await runClaudeCode({
         prompt: buildComposerPrompt(input),
         sink: (event) => {
           if (event.type === "token" && typeof event.text === "string") { buffer += event.text; flush(); }
         },
         signal: controller.signal,
         allowedTools: undefined,
         maxTurns: 1,
         idleTimeoutMs: COMPOSE_TIMEOUT_MS,
         emitToolTrace: false,
         streamPartial: true,
         model: config.narrator.model,
         finopsSurface: "dashboard",
       });
       clearTimeout(hardStop);
       // Final reconciliation from the whole buffer (idempotent; same validate+template net).
       return res.ok && buffer.trim() ? composeFromModelText(buffer, input) : templateOf();
     } catch {
       clearTimeout(hardStop);
       return templateOf();
     }
   }
   ```
   (`buildComposerPrompt` is already module-private; `runClaudeCode`, `liveModeAvailable`, `config`, `templateDashboard` are already imported.)
6. **(GREEN)** Run the streaming test file → all pass.
7. **(GREEN)** Run the existing `cd bff && node --import tsx --import ./test-setup.ts --test src/dashboards/composer.test.ts` (proves the `assembleSpec` refactor kept the old grounding guarantees) → pass. `npm run typecheck`.
8. **Commit:** `feat(bff): incremental parse-and-heal dashboard streaming composer`.

---

### T4 — `agent.ts` wires the streaming composer

`emitDashboard` (L316-342) currently `await composeDashboard(...)` then emits one `dashboard`. Switch to `composeDashboardStreaming`, forwarding a `dashboard-delta` per widget, then emit the final `dashboard` (with certification) exactly as today.

**Files:**
- Modify: `bff/src/ask/agent.ts` (`emitDashboard` L316-342; import at L30)
- Test: reuse `bff/src/dashboards/streaming.test.ts` (agent is thin; the composer is covered in T3). Add a focused test asserting the *ordering contract* via a fake sink if a pure helper is extractable; otherwise assert manually in the live render-proof (T13). Minimal test below.

**Interfaces:**
- Consumes: `composeDashboardStreaming(input, onDelta)`
- Produces (sink): `{type:"dashboard-delta", spec}` (0..N) then `{type:"dashboard", spec, certified}` (1)

**Steps:**

1. **(GREEN, no new RED — behaviour tested at T3/T13)** Change the import at L30:
   ```ts
   import { composeDashboard, composeDashboardStreaming } from "../dashboards/composer.js";
   ```
2. **(GREEN)** Replace the compose+emit in `emitDashboard` (L333-338):
   ```ts
   const spec = await composeDashboardStreaming(
     { question, answerText, citedNodes, strategy },
     (partial) => sink({ type: "dashboard-delta", spec: partial }),
   );
   // Feature 8: certify over the REAL cited nodes (trusted), never the inert spec.
   const { certified } = certifySpec(spec, citedNodes);
   sink({ type: "dashboard", spec, certified });
   ```
   `composeDashboard` stays imported for any non-streaming caller (snapshots.ts uses it headless — unchanged).
3. **(GREEN)** Confirm `snapshots.ts` still imports `composeDashboard` (grep): `cd bff && node --import tsx --import ./test-setup.ts --test src/dashboards/snapshots.test.ts` → pass (headless recompose path untouched).
4. **(GREEN)** `npm run typecheck`.
5. **Commit:** `feat(bff): stream dashboard-delta events from the ask agent`.

---

### T5 — `aguiBridge.ts` `dashboard-delta` → incremental `render_dashboard`

Add a sink `case "dashboard-delta"` that emits a self-contained `render_dashboard` tool call (START/ARGS/END) carrying the one-widget partial spec. The frontend's `applyIncoming` merges by widget id → progressive paint. The existing end-of-run `render_dashboard` (L382-446) stays as the final reconciled emit (idempotent via the lineage signature).

**Files:**
- Modify: `bff/src/ask/aguiBridge.ts` (add case near the `dashboard` case at L258-263)
- Test: none new (protocol emit; covered by live render-proof T13). Structural correctness guarded by typecheck.

**Interfaces:**
- Consumes (sink): `{type:"dashboard-delta", spec: DashboardSpec}`
- Produces (SSE): `TOOL_CALL_START{render_dashboard}` → `TOOL_CALL_ARGS{delta: JSON.stringify({spec})}` → `TOOL_CALL_END`

**Steps:**

1. **(GREEN)** Add the case inside the `askGraph` sink switch, immediately before `case "dashboard":` (L258):
   ```ts
   case "dashboard-delta": {
     // Genuine streaming: paint each widget the instant it closes. Emit a
     // self-contained render_dashboard tool call carrying the one-widget partial;
     // the frontend merges it by widget id (F7) so tiles appear progressively.
     // The spec is already inert + grounding-filtered by the composer. A refusal
     // never reaches here (compose only runs on a grounded, cited answer).
     const s = (event as { spec?: unknown }).spec;
     if (s) {
       const id = randomUUID();
       ch.send({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: "render_dashboard", parentMessageId: messageId });
       ch.send({ type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify({ spec: s }) });
       ch.send({ type: "TOOL_CALL_END", toolCallId: id });
     }
     return;
   }
   ```
2. **(GREEN)** Delete the now-stale single-delta concession comment at L388-390 (replace with): `// The final render_dashboard reconciles the full spec + certification/audit; streaming deltas above already painted each tile as it closed.`
3. **(GREEN)** `npm run typecheck`.
4. **Commit:** `feat(bff): emit incremental render_dashboard tool calls for streaming deltas`.

---

### T6 — `lineageStore` subscribe + per-surface keying

`lineageStore.ts` is a module singleton (L23-25). Key `current`/`lastIncomingSig`/`lastResult` by a `surface` id so Studio and Conversation don't bleed; add `subscribe(listener)` + notify on `applyIncoming`/`resetLineage`.

**Files:**
- Modify: `web/src/dashboards/lineageStore.ts`
- Test: `web/src/dashboards/lineageStore.test.ts`

**Interfaces:**
- Consumes: `applyIncoming(spec, surface?: DashboardSurface)`, `resetLineage(surface?: DashboardSurface)`
- Produces: `subscribe(surface: DashboardSurface, listener: () => void): () => void`; `type DashboardSurface = "studio" | "conversation"`

**Steps:**

1. **(RED)** Create `web/src/dashboards/lineageStore.test.ts` (pure; runnable via the web test runner — mirror an existing web test's command; if none, run `cd web && node --import tsx --test src/dashboards/lineageStore.test.ts`):
   ```ts
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import { applyIncoming, resetLineage, subscribe } from "./lineageStore.js";
   import type { DashboardSpec } from "@rnd/shared";

   const spec = (id: string, node: string): DashboardSpec => ({
     version: 1, title: "t", widgets: [{ id, kind: "citation-chips", nodeIds: [node] }], citedNodeIds: [node], source: "llm",
   });

   test("studio and conversation lineages are isolated", () => {
     resetLineage("studio"); resetLineage("conversation");
     applyIncoming(spec("a", "N1"), "studio");
     const conv = applyIncoming(spec("b", "N2"), "conversation");
     assert.deepEqual(conv.spec.widgets.map((w) => w.id), ["b"]); // no "a" bleed
   });

   test("subscribe fires on merge", () => {
     resetLineage("studio");
     let hits = 0;
     const off = subscribe("studio", () => { hits++; });
     applyIncoming(spec("a", "N1"), "studio");
     off();
     applyIncoming(spec("c", "N1"), "studio");
     assert.equal(hits, 1);
   });
   ```
2. **(RED)** Run the test → fails (`subscribe` undefined / no surface param).
3. **(GREEN)** Rewrite `lineageStore.ts` to hold per-surface state + listeners:
   ```ts
   import { mergeDashboard, type DashboardSpec, type MergedDashboard } from "@rnd/shared";

   export type DashboardSurface = "studio" | "conversation";

   interface SurfaceState { current: DashboardSpec | null; lastIncomingSig: string | null; lastResult: MergedDashboard | null; }
   const states: Record<DashboardSurface, SurfaceState> = {
     studio: { current: null, lastIncomingSig: null, lastResult: null },
     conversation: { current: null, lastIncomingSig: null, lastResult: null },
   };
   const listeners: Record<DashboardSurface, Set<() => void>> = { studio: new Set(), conversation: new Set() };

   function signature(spec: DashboardSpec): string { return JSON.stringify(spec); }
   function continues(prev: DashboardSpec, next: DashboardSpec): boolean {
     const prevWidgetIds = new Set(prev.widgets.map((w) => w.id));
     if (next.widgets.some((w) => prevWidgetIds.has(w.id))) return true;
     const prevCited = new Set(prev.citedNodeIds);
     return next.citedNodeIds.some((id) => prevCited.has(id));
   }
   function notify(surface: DashboardSurface) { for (const l of listeners[surface]) l(); }

   export function subscribe(surface: DashboardSurface, listener: () => void): () => void {
     listeners[surface].add(listener);
     return () => listeners[surface].delete(listener);
   }

   export function applyIncoming(spec: DashboardSpec, surface: DashboardSurface = "conversation"): MergedDashboard {
     const st = states[surface];
     const sig = signature(spec);
     if (sig === st.lastIncomingSig && st.lastResult) return st.lastResult;
     const base = st.current && continues(st.current, spec) ? st.current : null;
     const result = mergeDashboard(base, spec);
     st.current = result.spec; st.lastIncomingSig = sig; st.lastResult = result;
     notify(surface);
     return result;
   }

   export function resetLineage(surface: DashboardSurface = "conversation"): void {
     states[surface] = { current: null, lastIncomingSig: null, lastResult: null };
     notify(surface);
   }

   /** Read the current merged spec for a surface (Studio pane pulls this on notify). */
   export function currentSpec(surface: DashboardSurface): DashboardSpec | null { return states[surface].current; }
   ```
4. **(RED→GREEN)** `dashboardRenderer.tsx` calls `applyIncoming(spec)` with no surface → still compiles (defaults to `"conversation"`). T7 threads the surface through.
5. **(GREEN)** Run the test → pass. `npm run typecheck`.
6. **Commit:** `feat(web): per-surface lineage keying + subscribe in the dashboard store`.

---

### T7 — `dashboardRenderer` / `DashboardCanvas` streaming merge + `dashboardTarget`

Thread a `surface` into the renderer so Studio merges into the `"studio"` lineage; add an `aria-live` streaming announce to the canvas (C7 a11y). The canvas already re-paints per merge (`changedIds`) — streaming is *repeated merge*, so no new render path.

**Files:**
- Modify: `web/src/dashboards/dashboardRenderer.tsx` (add `surface` opt; pass to `applyIncoming`)
- Modify: `web/src/dashboards/DashboardCanvas.tsx` (wrap grid in `aria-live="polite"`; announce tile count)
- Test: none new (visual/merge behaviour covered by T6 store test + T13 render-proof)

**Interfaces:**
- Consumes: `dashboardRenderer(graph, { …, surface?: DashboardSurface })`
- Produces: `applyIncoming(spec, surface)`

**Steps:**

1. **(GREEN)** In `dashboardRenderer.tsx`, extend `opts` (L26-31) with `surface?: import("./lineageStore.js").DashboardSurface` and change L52:
   ```ts
   const { spec: merged, changedIds } = applyIncoming(spec, opts?.surface);
   ```
2. **(GREEN)** In `DashboardCanvas.tsx`, add an `aria-live` region above the widget grid (before L245's grid `<div>`), announcing composed tiles (respect `useMotion` for the *pulse*, but the announce is always polite text):
   ```tsx
   <div aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
     {spec.widgets.length} tile{spec.widgets.length === 1 ? "" : "s"} composed
   </div>
   ```
3. **(GREEN)** `npm run typecheck`.
4. **Commit:** `feat(web): thread surface through the dashboard renderer + a11y streaming announce`.

---

### T8 — `CopilotChatBeat` `dashboardTarget` prop + B1 duplicate-key fix

Add `dashboardTarget:"inline"|"pane"` (default `"inline"` — Conversation beat unchanged). In `"pane"` mode the `dashboardRenderer` pushes to the `"studio"` lineage and returns a compact "→ opened in canvas" chip instead of a full board. Fix **B1**: the duplicate React keys `<uuid>-custom-before`/`-custom-after` come from CopilotKit wrapping a tool-call renderer that returns an UN-keyed fragment/array; the fix is to give every renderer's top-level returned element a stable, unique `key`-safe single root (no sibling arrays) so CopilotKit's `-custom-before/-after` wrapper keys don't collide across repeated tool-call ids.

**Files:**
- Modify: `web/src/beats/CopilotChatBeat.tsx` (Props L61-80; `renderToolCalls` L130-140; the `dashboardRenderer` registration L135)
- Test: `web/src/beats/CopilotChatBeat.keys.test.tsx` (a jsdom render asserting no duplicate-key `console.error`) — if the web runner lacks jsdom, fall back to a focused assertion that each renderer returns a single rooted element (unit test of the renderer functions).

**Interfaces:**
- Consumes: `Props { …, dashboardTarget?: "inline" | "pane" }`
- Produces: in `"pane"`, `dashboardRenderer(graph, { …, surface: "studio", renderChipOnly: true })`

**Steps:**

1. **(RED)** Add `web/src/beats/CopilotChatBeat.keys.test.tsx` — the minimal, runner-appropriate check. If jsdom is available:
   ```tsx
   import { test } from "node:test";
   import assert from "node:assert/strict";
   // Render two `render_evidence` tool calls with the SAME shape and assert React
   // logs no "Encountered two children with the same key" error.
   // (Setup: jsdom + react-dom/server renderToStaticMarkup of the renderer output twice.)
   ```
   If jsdom is NOT wired in `web`, instead unit-test that each renderer returns a single element (never a bare array), which is the structural cause:
   ```ts
   test("dashboardRenderer render returns a single rooted element", () => {
     const r = dashboardRenderer({ nodes: [], edges: [] });
     const el = r.render({ args: { spec: { version: 1, title: "t", widgets: [{ id: "w", kind: "citation-chips" }], citedNodeIds: ["X"], source: "llm" } } } as any);
     assert.ok(el && typeof el === "object" && !Array.isArray(el));
   });
   ```
2. **(RED)** Run → identify whether the current renderers ever return `<>…</>` fragments with sibling arrays (evidenceRenderer L1326-1350 returns a fragment with a mapped list — inspect for missing keys). The B1 culprit: `GroundedDiagrams` or the evidence fragment children rendered inside CopilotKit's `custom-before/after` slots reuse the tool-call id as key across re-renders. Fix by ensuring each renderer's returned root carries no unkeyed sibling list at the top level.
3. **(GREEN)** Add `dashboardTarget` to `Props`:
   ```ts
   /** Where a composed board renders: "inline" (Conversation beat, full board in
    *  the transcript — default, unchanged) or "pane" (Studio — pushed to the
    *  "studio" lineage + a compact "opened in canvas" chip inline instead). */
   dashboardTarget?: "inline" | "pane";
   ```
   Destructure it in both `CopilotChatBeat` (L108) and pass down to `CopilotSurface`.
4. **(GREEN)** In the `renderToolCalls` memo (L130-140), branch the dashboard renderer:
   ```ts
   dashboardTarget === "pane"
     ? dashboardRenderer(graph, { surface: "studio", renderChipOnly: true, onAsk })
     : dashboardRenderer(graph, { onFocusNode: onNodeClick, onAsk, onSave: onSaveDashboard }),
   ```
   Add `dashboardTarget` to the memo deps.
5. **(GREEN)** In `dashboardRenderer.tsx`, when `opts.renderChipOnly`, still call `applyIncoming(spec, "studio")` (so the pane updates via subscribe) but return a compact chip instead of `<DashboardCanvas>`:
   ```ts
   if (opts?.renderChipOnly) {
     applyIncoming(spec, opts.surface ?? "studio");
     return (
       <div style={{ fontSize: 12, color: "var(--frame-text-muted)", border: "1px solid var(--frame-border)", borderRadius: 6, padding: "4px 10px", margin: "4px 0" }}>
         → opened in canvas · {spec.widgets.length} tile{spec.widgets.length === 1 ? "" : "s"}
       </div>
     );
   }
   ```
6. **(GREEN)** Fix B1: ensure `evidenceRenderer` (and any renderer returning a fragment with a mapped list) wraps its children in a single keyed container. Change the `render_evidence` return (L1326) so the fragment root is a single `<div>` (already is) and any internal `.map` has stable keys (verify `GroundedDiagrams` internals already key by `n.id`, L163/279 — they do). The remaining collision is CopilotKit reusing the *tool-call id* for `-custom-before/-after`; guarantee uniqueness by making each renderer idempotent w.r.t. its args (no state that re-mounts with the same id). Concretely: confirm no renderer returns `[a, b]` arrays; the T8 test locks this.
7. **(GREEN)** Run the key test → pass. `npm run typecheck`.
8. **Commit:** `fix(web): dashboardTarget prop + eliminate duplicate tool-call render keys (B1)`.

> **Build-time verify:** reproduce B1 live first (open Beat 4, ask the myocarditis question, watch the console for "two children with the same key `…-custom-before`"). If the key originates strictly inside CopilotKit's message-render (not our renderers), the fix is to pass a stable unique `key` via the renderer's outermost element and file the upstream note; the test then asserts our renderers each return one rooted element.

---

### T9 — `DashboardStudio.tsx` split-view component

**Files:**
- Create: `web/src/dashboards/DashboardStudio.tsx`
- Test: none new (composition; covered by T13 render-proof)

**Interfaces:**
- Consumes: `{ graph: GraphPayload; lightCanvas?: boolean; onNodeClick: (n: GraphNode) => void; onEdgeClick?: (e: GraphEdge) => void; onOpenHitl?: () => void; refreshKey?: number }`
- Produces: a two-pane flex: left `<CopilotChatBeat dashboardTarget="pane" …>`, right a `StudioPane` subscribing to the `"studio"` lineage.

**Steps:**

1. **(GREEN)** Create the component:
   ```tsx
   import { useEffect, useState } from "react";
   import type { GraphPayload, GraphNode, GraphEdge, DashboardSpec } from "@rnd/shared";
   import { CopilotChatBeat } from "../beats/CopilotChatBeat.js";
   import { DashboardCanvas } from "./DashboardCanvas.js";
   import { subscribe, currentSpec, resetLineage } from "./lineageStore.js";

   interface Props {
     graph: GraphPayload; lightCanvas?: boolean;
     onNodeClick: (n: GraphNode) => void; onEdgeClick?: (e: GraphEdge) => void;
     onOpenHitl?: () => void; refreshKey?: number;
   }
   const STARTERS = [
     "Build a live dashboard for the checkpoint-inhibitor myocarditis safety signal — disproportionality, mechanism, and supporting evidence.",
     "Compose a dashboard of the evidence and provenance behind the myocarditis signal.",
     "Dashboard: what is known, missing, and conflicting for the myocarditis signal, with the relational subgraph.",
   ];

   export function DashboardStudio({ graph, lightCanvas, onNodeClick, onEdgeClick, onOpenHitl, refreshKey }: Props) {
     const [spec, setSpec] = useState<DashboardSpec | null>(() => currentSpec("studio"));
     useEffect(() => {
       const off = subscribe("studio", () => setSpec(currentSpec("studio")));
       return off;
     }, []);
     // Fresh Studio session starts clean (Save is the durable path; C5 rehydration in T12).
     useEffect(() => () => resetLineage("studio"), []);

     return (
       <div style={{ display: "flex", gap: 14, height: "100%", minHeight: 0 }}>
         <div style={{ flex: "0 0 38%", minWidth: 0, display: "flex", flexDirection: "column" }}>
           <CopilotChatBeat graph={graph} lightCanvas={lightCanvas} dashboardTarget="pane" onNodeClick={onNodeClick} onEdgeClick={onEdgeClick} onOpenHitl={onOpenHitl} refreshKey={refreshKey} />
         </div>
         <div style={{ flex: 1, minWidth: 0, overflowY: "auto", border: "1px solid var(--frame-border)", borderRadius: "var(--radius)", padding: 12, background: "var(--frame-surface)" }}>
           {spec ? (
             <DashboardCanvas spec={spec} graph={graph} onFocusNode={onNodeClick} />
           ) : (
             <div style={{ color: "var(--frame-text-muted)", fontSize: 13 }}>
               <div style={{ fontWeight: 600, marginBottom: 8 }}>✨ Ask to compose your first board.</div>
               <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                 {STARTERS.map((s) => (<div key={s} style={{ fontSize: 12, opacity: 0.8 }}>· {s}</div>))}
               </div>
             </div>
           )}
         </div>
       </div>
     );
   }
   ```
   (Studio starters are display-only prompts; the actual submit happens through `CopilotChatBeat`'s own `BeatStarters`/`DASHBOARD_STARTERS`, unchanged.)
2. **(GREEN)** `npm run typecheck`.
3. **Commit:** `feat(web): DashboardStudio split-view component`.

---

### T10 — `App.tsx` `studio` beat wiring

**Files:**
- Modify: `web/src/App.tsx` — `Beat` union (L42), `BEAT_LABELS` (L101-107), nav loop array (L346 + L500), render branch (L575), import
- Test: none new (nav; covered by T13)

**Interfaces:**
- Produces: a new `"studio"` beat rendering `<DashboardStudio>`.

**Steps:**

1. **(GREEN)** Import at L36-area: `import { DashboardStudio } from "./dashboards/DashboardStudio.js";`
2. **(GREEN)** Extend the union (L42):
   ```ts
   type Beat = "radar" | "safety" | "explanation" | "multimodal" | "conversation" | "studio";
   ```
3. **(GREEN)** Add the label (L101-107):
   ```ts
   studio: "✨ Dashboard Studio",
   ```
4. **(GREEN)** Add `"studio"` to BOTH beat-order arrays — the command-palette `goto` list (L346) and the nav loop (L500):
   ```ts
   (["radar", "safety", "explanation", "multimodal", "conversation", "studio"] as Beat[])
   ```
5. **(GREEN)** Treat Studio like the full-height conversation surface (L370):
   ```ts
   const fullHeight = beat === "conversation" || beat === "studio";
   ```
   And the two `beat === "conversation"` layout conditionals at L534 and L590 → `(beat === "conversation" || beat === "studio")` so Studio gets the 1-column full-width layout and no right aside/AskDock. Also L716 (`beat !== "conversation"` AskDock guard) → also exclude `"studio"`.
6. **(GREEN)** Add the render branch after the conversation branch (L585):
   ```tsx
   {beat === "studio" && (
     <DashboardStudio
       graph={displayGraph}
       lightCanvas={lightCanvas}
       onNodeClick={onNodeClick}
       onEdgeClick={onEdgeClick}
       onOpenHitl={openHitl}
       refreshKey={graphVersion}
     />
   )}
   ```
7. **(GREEN)** `npm run typecheck`.
8. **Commit:** `feat(web): add the Dashboard Studio beat to the app shell`.

---

### T11 — Stream-error resumable UX + NOT_IN_GRAPH refusal card

Two scary labels, two fixes. (a) A mid-stream SSE drop → a *resumable* "Still composing… — Retry" state (never a red error). (b) The honest `NOT_IN_GRAPH:` refusal → a branded refusal card with 2-3 in-graph suggestions.

**Files:**
- Create: `web/src/components/RefusalCard.tsx`
- Modify: `web/src/beats/CopilotChatBeat.tsx` (detect the marker in assistant prose; render the card + a Retry affordance)
- Modify (optional): `bff/src/config.ts` — confirm `ask.idleTimeoutMs` (L110, 45s) is generous; no code change unless the watchdog is demonstrably tight
- Test: `bff/src/ask/refusal.test.ts` (pure: a `NOT_IN_GRAPH:` answer yields the refusal path, not an error, with ≥1 suggestion) — assert against the marker-detection helper.

**Interfaces:**
- Consumes: assistant prose containing `getConfig().notInGraphMarker`
- Produces: `<RefusalCard suggestions={string[]} />`; a resumable retry that re-submits the same question via `askGrounded`.

**Steps:**

1. **(RED)** Create `bff/src/ask/refusal.test.ts` asserting a small exported helper `isRefusal(text, marker)` + `refusalSuggestions()` (curated, in-graph). If the marker logic already lives inline in the bridge (`isRefusal` closure L132), extract a pure `export function containsRefusal(text: string, marker: string): boolean` in `agent.ts` or a new `ask/refusal.ts`:
   ```ts
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import { containsRefusal, refusalSuggestions } from "./refusal.js";
   test("detects the NOT_IN_GRAPH marker", () => {
     assert.equal(containsRefusal("NOT_IN_GRAPH: no data on X", "NOT_IN_GRAPH:"), true);
     assert.equal(containsRefusal("The signal is 4.2.", "NOT_IN_GRAPH:"), false);
   });
   test("offers at least one in-graph suggestion", () => {
     assert.ok(refusalSuggestions().length >= 1);
   });
   ```
2. **(RED)** Run → fails (`ask/refusal.ts` missing).
3. **(GREEN)** Create `bff/src/ask/refusal.ts`:
   ```ts
   export function containsRefusal(text: string, marker: string): boolean {
     return typeof text === "string" && text.includes(marker);
   }
   /** Curated in-graph questions offered when the graph can't answer — always a next action. */
   export function refusalSuggestions(): string[] {
     return [
       "What is the safety signal for the checkpoint inhibitor?",
       "How does the checkpoint inhibitor cause myocarditis?",
       "What evidence supports the myocarditis signal?",
     ];
   }
   ```
4. **(GREEN)** Create `web/src/components/RefusalCard.tsx`:
   ```tsx
   export function RefusalCard({ suggestions, onAsk }: { suggestions: string[]; onAsk: (q: string) => void }) {
     return (
       <div data-testid="refusal-card" style={{ border: "1px solid var(--frame-border)", borderLeft: "3px solid rgba(88,166,255,.9)", borderRadius: 6, padding: "10px 12px", margin: "6px 0", background: "rgba(88,166,255,.06)" }}>
         <div style={{ fontSize: 12.5, fontWeight: 600 }}>I answer only from the grounded graph — that isn't in it yet.</div>
         <div style={{ fontSize: 12, color: "var(--frame-text-muted)", margin: "4px 0 8px" }}>Try one of these grounded questions:</div>
         <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
           {suggestions.map((s) => (
             <button key={s} type="button" onClick={() => onAsk(s)} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--frame-border)", background: "rgba(88,166,255,.10)", color: "var(--frame-text)", cursor: "pointer" }}>{s}</button>
           ))}
         </div>
       </div>
     );
   }
   ```
5. **(GREEN)** In `CopilotChatBeat.tsx`, render the card when the last assistant message contains the marker (read from `agent.messages`), passing `askGrounded`. For the resumable drop: on `agent.subscribe`'s `onRunError`/`RUN_ERROR` (bridge L487), set a `stalled` state and show a "Still composing… the local model is slow — **Retry**" chip that re-submits the last user question via `askGrounded` — never a red error toast. (Wire in the existing `agent.subscribe` block at L560-571.)
6. **(GREEN)** Run `cd bff && node --import tsx --import ./test-setup.ts --test src/ask/refusal.test.ts` → pass. `npm run typecheck`.
7. **Commit:** `feat: branded NOT_IN_GRAPH refusal card + resumable stream-drop retry`.

---

### T12 — Working-board sessionStorage persistence (C5 / B2)

A tab reload drops an unsaved streaming Studio board. Persist the `"studio"` lineage to `sessionStorage` on each merge; rehydrate on mount. Save (F10) stays the durable path.

**Files:**
- Modify: `web/src/dashboards/lineageStore.ts` (persist/rehydrate the `"studio"` surface)
- Modify: `web/src/dashboards/DashboardStudio.tsx` (rehydrate initial state)
- Test: `web/src/dashboards/lineageStore.persist.test.ts` (stub `sessionStorage`; assert round-trip)

**Interfaces:**
- Produces: `rehydrate(surface): void`; persist inside `applyIncoming` for `"studio"`.

**Steps:**

1. **(RED)** Create `web/src/dashboards/lineageStore.persist.test.ts` with a `globalThis.sessionStorage` polyfill (Map-backed), apply a studio board, call `rehydrate("studio")` after resetting in-memory state, assert `currentSpec("studio")` returns the board.
2. **(RED)** Run → fails (no persistence).
3. **(GREEN)** In `lineageStore.ts`, after a successful `"studio"` merge in `applyIncoming`, write `sessionStorage.setItem("rtg.studio.board", JSON.stringify(result.spec))` (guarded try/catch — private mode). Add:
   ```ts
   const STUDIO_KEY = "rtg.studio.board";
   export function rehydrate(surface: DashboardSurface): void {
     if (surface !== "studio") return;
     try {
       const raw = sessionStorage.getItem(STUDIO_KEY);
       if (!raw) return;
       const spec = JSON.parse(raw) as DashboardSpec;
       states.studio = { current: spec, lastIncomingSig: null, lastResult: null };
       notify("studio");
     } catch { /* best-effort */ }
   }
   ```
   Clear the key in `resetLineage("studio")`.
4. **(GREEN)** In `DashboardStudio.tsx` mount effect, call `rehydrate("studio")` BEFORE the `resetLineage` cleanup registration — i.e. rehydrate on mount, reset only on unmount. (Adjust the two effects so a reload restores, an intentional beat-leave clears.)
5. **(GREEN)** Run the persist test → pass. `npm run typecheck`.
6. **Commit:** `feat(web): persist the Studio working board to sessionStorage (C5)`.

> **B2 note:** confirm the mid-run "full reload" is dev-only Vite HMR (edit a file mid-compose → HMR reload). If reproducible in a production build, C5's rehydration covers it; document the finding in the PR.

---

### T13 — Full gate + live render-proof

**Files:** none (verification only)

**Steps:**

1. `npm run typecheck` (all 3 workspaces) → clean.
2. Targeted BFF tests (never full `npm test` — it HANGS):
   ```
   cd bff && node --import tsx --import ./test-setup.ts --test src/dashboards/streaming.test.ts src/dashboards/composer.test.ts src/dashboards/merge.test.ts src/llm/claudeCode.test.ts src/ask/refusal.test.ts
   ```
   → all pass.
3. Web tests: `cd web && node --import tsx --test src/dashboards/lineageStore.test.ts src/dashboards/lineageStore.persist.test.ts` (+ the T8 key test) → pass.
4. **Live render-proof on `:5173`** (BFF on `:8787` launched via `npm run dev:bff` from a shell with `~/.local/bin` on PATH; `bff/.env` sets `LLM_PROVIDER=claude-code`):
   - Open **✨ Dashboard Studio**. Confirm the empty state.
   - Submit a myocarditis dashboard starter. **Watch tiles paint PROGRESSIVELY** in the right pane (not one buffered board).
   - Confirm a certified ✓ badge appears and 💾 Save works.
   - Confirm the Conversation beat's inline board still renders and **does NOT** show the Studio board (C2 isolation).
   - `curl "http://localhost:8787/api/finops/ledger?limit=3"` → a `"surface":"dashboard"` entry with `"estimated":false` (the definitive live proof).
   - Ask an off-graph question → the **branded refusal card** (not an error), with suggestions.
   - Reload the Studio tab mid-board → the working board **rehydrates** from sessionStorage.
   - Console: **no** "two children with the same key" warning after a chat turn (B1).
5. **Commit:** `test: full gate + live render-proof for Studio + streaming`.

---

## Spec-coverage gaps I could NOT fully resolve (need the executing engineer's on-machine verification)

- **CLI partial-message envelope shape (T2).** The exact JSON the installed `claude` emits under `--include-partial-messages` (`stream_event` wrapping `content_block_delta`/`text_delta`) is written to the documented Anthropic streaming shape but is NOT verified against the local binary in this repo — no fixture exists. `handleCliLine`'s first branch is the single adjustment point. Must be confirmed live (T2 build-time note).
- **B1 root cause (T8).** The duplicate keys `<uuid>-custom-before`/`-custom-after` do NOT appear in our source (grep found none) — they are generated INSIDE CopilotKit's message-render wrapper. The plan's fix (each renderer returns a single rooted element; reproduce live first) is the best structural mitigation, but if the collision originates purely in CopilotKit internals it may require an upstream key or a version bump rather than a change in our renderers. Flagged for live reproduction.
- **Web test runner (T6/T8/T12).** The `web` workspace's exact test invocation is assumed to mirror BFF (`node --import tsx --test`); if `web` has no configured runner or jsdom, the T8 duplicate-key assertion degrades to the structural "single rooted element" unit test (still meaningful) and the render-proof (T13) becomes the authoritative B1 check. Confirm the web runner on-machine.
- **C4 catalog-drift guard (spec §4).** The spec calls for a unit test asserting shared kinds === composer `KNOWN_KINDS` === Zod enum. It is INTENTIONALLY out of scope this cycle (spec defers the A2UI catalog handshake) and is NOT a task here; add it opportunistically if touching `schema.ts`.
- **`config.ts` watchdog (T11a).** Whether `ask.idleTimeoutMs` (45s) actually needs raising depends on live local-CLI latency, which can't be measured from source. The plan keeps it a no-op unless the watchdog demonstrably races a slow compose; verify during T13.
