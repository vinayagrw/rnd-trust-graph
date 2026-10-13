# Phase 2 — Copilot Runtime adoption: research + de-risk findings

**Status:** research complete; smallest end-to-end Runtime→grounded path **proven with a real spike** (no LLM key). **Verdict: GO.** No version bump of `react-core` / `react-ui` / `@ag-ui/client` is required.

**Goal recap.** Replace the self-managed-agent dev path (`agents__unsafe_dev_only={{ default: new HttpAgent({url:"/api/agui"}) }}`) with the full Copilot **Runtime** to unlock native threads/persistence, suggestions, `useAgentContext` (readable), HITL, and sidebar/popup — **while keeping 100% server-side grounding**: answers come only from the untouched `askGraph` via the untouched `/api/agui` bridge, the Runtime carries **no API key**, and refusals still draw nothing.

---

## TL;DR — the 4 crux answers (definitive)

1. **Version compatibility — COMPATIBLE, no bump.** The v2 client we already have (`@copilotkit/react-core@2.0.0-next.1`) is built on `@copilotkitnext/{core,react}@0.0.33`. The matching server is **`@copilotkit/runtime@2.0.0-next.1`** (identical version string to our react pins), imported from its **`./v2`** subpath. That package depends on `@copilotkit/shared@2.0.0-next.1` (matches ours) and bundles `@copilotkitnext/runtime@0.0.33` (same family the spike ran). It requires `@ag-ui/client ^0.0.42` / `@ag-ui/core ^0.0.42` — **satisfied by our locked `0.0.42`**, so the fragile `@ag-ui/client@0.0.42` Message-type lock is NOT disturbed. The classic npm `latest` (runtime `1.61.x`, react `1.x`) is the **wrong, incompatible line** — do not install it.

2. **No-LLM-key delegation — native and trivial.** The v2 runtime is constructed as `new CopilotRuntime({ agents })` — **no `serviceAdapter`, no model, no key**. `agents` is a `Record<string, AbstractAgent>`. We register **`{ default: new HttpAgent({ url: "<BFF>/api/agui" }) }}`** — i.e. point the Runtime's agent straight at our **untouched grounded bridge**. The Runtime becomes a pure AG-UI proxy: client → Runtime `/agent/default/run` → our `HttpAgent` → `/api/agui` → `askGraph`. No independent answer path, no key. (`openai` is only an *optional peer/dep* for the v1 GraphQL path and transcription; the `/v2` AG-UI-agent path never touches it.) **Proven by spike (below).**

3. **Persistence — Runtime owns the run/thread seam; we back it, not replace our store.** The Runtime delegates thread lifecycle to an `AgentRunner` (default `InMemoryAgentRunner`) exposing `run / connect(threadId) / isRunning / stop`, plus a `/agent/:id/connect` route for resume. Message *history* still lives where the agent/transport keeps it; our **file-backed `threadStore.ts` survives essentially unchanged** as the durable record. Migration is additive: keep `/api/threads*`, drive snapshot-on-`onRunFinalized` exactly as today. Optionally later, implement a thin `AgentRunner` subclass backed by `threadStore` so `connect` rehydrates server-side. **The trust-boundary comment in `threadStore.ts` stays literally true** — it records what the grounded bridge produced; it never grounds anything.

4. **HITL — present as `useHumanInTheLoop`, supersedes `renderAndWait`.** v2 ships `useHumanInTheLoop(tool)` (+ a `humanInTheLoop` provider prop). The tool's `render` receives `status` and a `respond(result)` callback in the `Executing` state — this **is** the approve/reject/escalate gate. It is wired by emitting a HITL **tool call** for `routedToHuman` 🟩 conclusions; nothing about it weakens grounding (the underlying answer still came from `askGraph`). `useCopilotReadable` is replaced by **`useAgentContext({description, value})`**; `useCopilotChatSuggestions` is replaced by **`useConfigureSuggestions` / `useSuggestions`** (static or dynamic). All exist in the installed `0.0.33`.

**Single biggest risk to grounding:** **dynamic suggestions**. `DynamicSuggestionsConfig` generates pills *via a provider agent* (`providerAgentId`) — if that resolves to a model-backed agent, it is a *second, ungrounded generation path*. **Mitigation: use `StaticSuggestionsConfig` only** (curated pills, zero LLM), OR point `providerAgentId` at a grounded/templated agent. This must be an explicit gate in 2b. (Secondary risk: a future `@copilotkit/runtime` patch silently bumping its `@ag-ui/client` floor past `0.0.42`; pin exactly and verify the Message type on upgrade.)

---

## Evidence base (read against installed code, not memory)

- `web/package.json`: `@copilotkit/react-core` & `react-ui` pinned `2.0.0-next.1`; `@ag-ui/client` `0.0.42`; React `18.3`.
- Installed `node_modules/@copilotkit/react-core@2.0.0-next.1` → depends on `@copilotkitnext/core@0.0.33` + `@copilotkitnext/react@0.0.33`. Its `./v2` export re-exports `@copilotkitnext/*`.
- `@copilotkitnext/react@0.0.33` `dist/index.d.ts` exports (all present): `CopilotKitProvider` (props include **both** `runtimeUrl?` and `agents__unsafe_dev_only?`), `CopilotChat`, `CopilotSidebar`, `CopilotPopup`, `useAgent`, `useFrontendTool`, **`useHumanInTheLoop`**, **`useAgentContext`**, **`useConfigureSuggestions`** / **`useSuggestions`**, `useRenderToolCall`, `defineToolCallRenderer`.
- `@copilotkitnext/core@0.0.33`: `CopilotKitCoreConfig.runtimeUrl`; class `ProxiedCopilotRuntimeAgent extends HttpAgent` (the client proxies each remote agent run through `runtimeUrl`); `AgentRegistry` fetches remote agents from the runtime `/info`.
- `@copilotkit/runtime@2.0.0-next.1`: exposes `./v2`; deps include `@copilotkitnext/runtime@0.0.33`, `@copilotkit/shared@2.0.0-next.1`, `@ag-ui/client ^0.0.42`.
- npm deprecation notice on `@copilotkitnext/runtime`: *"Moved into @copilotkit/runtime. Import from '@copilotkit/runtime/v2'."* → confirms the production import path.
- v2 runtime `CopilotRuntimeOptions` (from packed `0.0.34-alpha.0` dist, same API as `0.0.33`): `{ agents: Record<string, AbstractAgent>; runner?: AgentRunner; transcriptionService?; before/afterRequestMiddleware? }` — **no model/adapter/key field**. Endpoints from `createCopilotEndpoint`: `GET /info`, `POST /agent/:agentId/run`, `POST /agent/:agentId/connect`, `POST /agent/:agentId/stop/:threadId`. Express adapter: `createCopilotEndpointExpress`.

---

## The spike (real, passing — `…/scratchpad/copilot-runtime-spike/`)

Builds a real v2 `CopilotRuntime({ agents: { default: <AG-UI agent> } })` with **no adapter / no key**, mounts it via `createCopilotEndpoint`, then drives it exactly as the v2 client does (GET `/info`, POST `/agent/default/run` with a `RunAgentInput`). The agent emits a grounded-style sequence incl. the `STATE_SNAPSHOT {citedNodeIds,isFallback}` our canvas reads. Real output:

```
[/info] status: 200
[/info] body: {"version":"0.0.34-alpha.0","agents":{"default":{"name":"default",...,"className":"GroundedEchoAgent"}},"audioFileTranscriptionEnabled":false}
[/run] status: 200 content-type: text/event-stream
[/run] event types: RUN_STARTED -> TEXT_MESSAGE_START -> TEXT_MESSAGE_CONTENT -> TEXT_MESSAGE_CONTENT -> TEXT_MESSAGE_END -> STATE_SNAPSHOT -> RUN_FINISHED
[/run] grounding snapshot: {"citedNodeIds":["AE-MYOCARDITIS","DRUG-CPI"],"isFallback":false}

SPIKE RESULT: PASS
```

The spike used `@copilotkitnext/runtime@0.0.34-alpha.0` because it packs cleanly standalone; production uses `@copilotkit/runtime@2.0.0-next.1` `/v2` (same API surface, same `@copilotkitnext/runtime@0.0.33` family, same version string as our react pins). In production the agent is a real `HttpAgent({url:"/api/agui"})` over the untouched bridge — the spike replaces only that one hop with a hand-emitted equivalent, leaving the Runtime-proxy claim fully exercised.

---

## Recommended adoption architecture

```
Browser (web/)                         BFF (bff/) — UNTOUCHED grounding core
┌─────────────────────────────┐        ┌──────────────────────────────────────────┐
│ CopilotKitProvider           │        │ Copilot Runtime (NEW, NO KEY)              │
│   runtimeUrl="/api/copilotkit"│  ───▶  │  createCopilotEndpoint({ runtime })        │
│   humanInTheLoop=[review]    │  /info │   new CopilotRuntime({                      │
│   renderToolCalls=[cypher,   │  /agent/│     agents:{ default:                       │
│                    evidence] │   :id/  │       new HttpAgent({url:"<self>/api/agui"})│
│   useConfigureSuggestions()  │   run   │     }                                       │
│   useAgentContext()          │ ◀────  │   })   ── proxies AG-UI events, no LLM ──┐ │
│   CopilotChat / Sidebar      │  SSE   │                                          │ │
└─────────────────────────────┘        │  POST /api/agui  (aguiBridge — UNTOUCHED)│ │
                                        │     askGraph (UNTOUCHED) ── Neo4j MCP RO ◀┘ │
                                        │  /api/threads*  (threadStore — UNCHANGED)  │
                                        └──────────────────────────────────────────┘
```

Key points:
- **One new server surface** (`/api/copilotkit`, the Runtime). `/api/agui`, `askGraph`, the Neo4j MCP, and `threadStore` are **untouched**.
- The Runtime's agent is an `HttpAgent` whose URL is **our own bridge** → the grounded answer path is unchanged; the Runtime is a transparent proxy that *adds* native UX (threads, suggestions, HITL, readable, sidebar/popup).
- Provider flips from `agents__unsafe_dev_only` to **`runtimeUrl`** — the only required client change to leave dev mode.
- **No new LLM key anywhere.** `LLM_PROVIDER=claude-code` stays; Neo4j MCP stays read-only.

### Mounting on the BFF
The Runtime ships a hono handler (`createCopilotEndpoint`) and an Express router (`createCopilotEndpointExpress`). The BFF is **Fastify**. Two clean options: (a) mount the hono app via `@hono/node-server` / `hono/fastify` adapter under `/api/copilotkit`; (b) run the Runtime as a tiny sidecar handler and proxy `/api/copilotkit/*` to it. Pick (a) if the adapter is stable; this is the one integration spike for 2a.

---

## Slice decomposition (2a / 2b / 2c)

### 2a — Runtime stand-up + grounded delegation (the load-bearing slice)
- Add `@copilotkit/runtime@2.0.0-next.1` to **bff** deps; import from `/v2`.
- Mount `createCopilotEndpoint({ runtime: new CopilotRuntime({ agents:{ default: new HttpAgent({url: <self>/api/agui}) } }), basePath:"/api/copilotkit" })` on Fastify.
- Flip the provider from `agents__unsafe_dev_only` → `runtimeUrl="/api/copilotkit"`. Keep `renderToolCalls` (`read_neo4j_cypher`, `render_evidence`) and the `useAgent()` state subscription verbatim.
- **Risks:** Fastify↔hono mount friction; `/info` agent-id must be `default` to match `CopilotChat`. **Gate:** the existing Beat-4 e2e (ask → grounded answer + cypher trace + cited-node highlight) passes **and** a refusal ("NOT_IN_GRAPH:") still draws nothing — *through the Runtime*. Confirm **no** `OPENAI_API_KEY`/model is set on the Runtime.

### 2b — Native UX: suggestions + readable + sidebar/popup
- `useConfigureSuggestions` with **static** pills (grounding gate: no model-backed provider agent — see top risk). `useAgentContext` to expose the current graph slice as readable context.
- Optionally swap `CopilotChat` for `CopilotSidebar`/`CopilotPopup`.
- **Risk:** dynamic suggestions opening an ungrounded path. **Gate:** suggestions are static or grounded-agent-sourced; verified no second LLM call fires (network trace shows only `/api/copilotkit/agent/default/run`).

### 2c — HITL on human-review routing + persistence consolidation
- `useHumanInTheLoop({ name:"review_conclusion", render })` rendering approve/reject/escalate, wired to Phase-1c `routedToHuman` 🟩 conclusions; gate the call **strictly** on `routedToHuman` (mirror the existing HITL invariant).
- Persistence: keep `threadStore` + snapshot-on-`onRunFinalized` first (lowest risk); optionally add an `AgentRunner` subclass backed by `threadStore` for server-side `connect`/resume.
- **Risk:** HITL firing on non-routed conclusions; persistence double-owning history. **Gate:** HITL appears **only** for `routedToHuman` turns; reload restores chat + chips; `threadStore` remains the single durable record and still never touches Neo4j.

---

## Verification gates (apply at every slice)
1. Grounded answer + read-only Cypher "show your work" + cited-node highlight all still work **through the Runtime**.
2. A `NOT_IN_GRAPH:` refusal draws **nothing** (no `render_evidence`, empty highlight) — `validateGrounding`/off-path-citation refusal intact.
3. The Runtime process has **no** LLM API key and **no** model/serviceAdapter; only network egress for answers is BFF→`/api/agui`→Neo4j MCP (read-only).
4. `@ag-ui/client` stays `0.0.42`; `react-core`/`react-ui` stay `2.0.0-next.1` (no forced bump).

## Buy-before-build note
Everything required is already shipped in the installed `@copilotkitnext@0.0.33` family and the matching `@copilotkit/runtime@2.0.0-next.1` `/v2`. **No bespoke runtime, persistence, or HITL machinery to build** — only wiring. The one genuinely new server surface is the Runtime mount in 2a.
