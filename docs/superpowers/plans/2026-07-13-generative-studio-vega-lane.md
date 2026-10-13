# Generative Studio (sandboxed Vega-Lite lane) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Generative Studio beat where the LLM composes Vega-Lite encoding skeletons (never data values), the BFF binds datasets from cited graph nodes and validates against a Zod-v4 allowlist, and the web renders tiles in a locked vega-embed runtime with an exploratory badge and cross-filtering.

**Architecture:** Spec/data split (spec `docs/superpowers/specs/2026-07-13-generative-studio-vega-lane-design.md` — READ IT FIRST, it is binding). New `bff/src/generative/` module + `?compose=generative` branch in the existing agent/bridge; second named Copilot Runtime agent; new `web/src/generative/` surface reusing the run-generation gate pattern from `web/src/dashboards/lineageStore.ts`.

**Tech Stack:** vega 6.2.0 / vega-lite 6.4.3 / vega-embed 7.1.0 (floors CI-asserted), zod v4 (bff) / zod v3 (web), Hono CopilotRuntime + Fastify adapter (existing), node:test.

## Global Constraints

- Classic `DashboardSpec` lane untouched; generative tiles are a SEPARATE `render_generative` tool call — never added to `DashboardWidget`.
- Grounded-only emission: identical gate to dashboards (`grounded && publishedIds.length > 0`); refusal/fallback emits nothing.
- The model NEVER emits a data value; skeletons reference `data: {"name":"cited"}` or `{"name":"edges"}` only.
- Allowlist hard-rejects: `usermeta`, `data.url`/`data.values`, `image` marks, `href` channels, lasso selections, `on`/`events` overrides, ANY expression string (`expr`, string filter predicates), tooltip objects (field refs only), unknown fields (not in the server field menu).
- Locked runtime: `{ ast: true, actions: false, renderer: "canvas" }` + deny-all loader INSTANCE + `delete spec.usermeta` client-side + never attach `vega`/`View`/`VEGA_DEBUG` to `window`.
- Version floors (CI test): vega ≥ 6.2.0, vega-lite ≥ 6.4.3, vega-embed ≥ 7.1.0, vega-functions ≥ 6.1.1, vega-selections ≥ 6.1.2, vega-expression ≥ 6.1.0, vega-interpreter ≥ 2.2.1.
- Read-only compose path (no graph writes); HITL widgets host-chrome only; transport metadata (`runId`, `final`) rides alongside the payload in tool-call args, never inside it.
- web zod v3 STRIPS undeclared keys — every args field the renderer needs must be declared in its z.object.
- NEVER run full `npm test` (hangs). Targeted: `cd bff && node --import tsx --import ./test-setup.ts --test <files>`; `cd web && node --import tsx --test <files>`. Typecheck: `npm run typecheck` at repo root.
- Commit after every task; commit bodies end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Tile cap: 6 per board. Exploratory badge on every tile; no certified badge in this lane.

---

### Task 1: Dependencies + CVE floor test

**Files:**
- Modify: `web/package.json` (deps)
- Test: `bff/src/generative/floors.test.ts` (create dir)

**Interfaces:** Produces node_modules for T9/T11; the floor test guards every later task.

- [ ] **Step 1: Install** — `cd web && npm install vega@^6.2.0 vega-lite@^6.4.3 vega-embed@^7.1.0` (workspace root lockfile updates).
- [ ] **Step 2: Failing floor test** — create `bff/src/generative/floors.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Jan-2026 Vega XSS fixes (CVE-2025-66648, CVE-2025-65110) arrive only via
// transitive resolution — vega 6.2.0's tilde ranges ADMIT the vulnerable
// versions, so a stale lockfile silently keeps them. Assert resolved floors.
const FLOORS: Record<string, string> = {
  vega: "6.2.0",
  "vega-lite": "6.4.3",
  "vega-embed": "7.1.0",
  "vega-functions": "6.1.1",
  "vega-selections": "6.1.2",
  "vega-expression": "6.1.0",
  "vega-interpreter": "2.2.1",
};

function atLeast(v: string, floor: string): boolean {
  const a = v.split(".").map(Number), b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) > (b[i] ?? 0)) return true; if ((a[i] ?? 0) < (b[i] ?? 0)) return false; }
  return true;
}

test("lockfile satisfies the Vega CVE version floors", () => {
  const lock = JSON.parse(readFileSync(join(process.cwd(), "..", "package-lock.json"), "utf8"));
  for (const [pkg, floor] of Object.entries(FLOORS)) {
    const entry = lock.packages?.[`node_modules/${pkg}`];
    assert.ok(entry, `${pkg} missing from lockfile — install the vega trio in web/`);
    assert.ok(atLeast(entry.version, floor), `${pkg}@${entry.version} is below the CVE floor ${floor}`);
  }
});
```

- [ ] **Step 3: Run** — `cd bff && node --import tsx --import ./test-setup.ts --test src/generative/floors.test.ts` → PASS (fails only if install skipped/stale).
- [ ] **Step 4: Commit** — `feat(generative): vega trio dependencies + CVE version-floor guard test`

### Task 2: Shared GenerativeTile type + stream events

**Files:**
- Create: `shared/src/generative.ts`
- Modify: `shared/src/index.ts` (add `export * from "./generative.js";`), `shared/src/types.ts` (StreamEvent union)

**Interfaces:** Produces `GenerativeTile`, `GenerativeBoard`, `GenerativeDatasets`, `FieldMenuEntry` consumed by every later task. Plain TS only — NO zod in shared.

- [ ] **Step 1: Create `shared/src/generative.ts`:**

```ts
/** Generative Vega-Lite lane — plain types (validation lives in bff zod v4).
 *  A tile's vlSkeleton is a CONSTRAINED Vega-Lite fragment: the model never
 *  emits data values; `data` is a named reference the server binds. */
export interface FieldMenuEntry {
  name: string;
  vlType: "quantitative" | "nominal" | "ordinal" | "temporal";
  cardinality: number;
}

/** Rows the server binds from ALREADY-CITED graph nodes/edges. */
export interface GenerativeDatasets {
  cited: Record<string, string | number | boolean | null>[];
  edges: Record<string, string | number | boolean | null>[];
}

export interface GenerativeTile {
  id: string;
  title: string;
  /** Constrained VL fragment (mark/encoding/transform/params/data-name only). */
  vlSkeleton: Record<string, unknown>;
  /** Which named dataset the skeleton references. */
  dataset: "cited" | "edges";
}

export interface GenerativeBoard {
  version: 1;
  tiles: GenerativeTile[];
  citedNodeIds: string[];
  source: "llm" | "template";
}
```

- [ ] **Step 2:** In `shared/src/types.ts` extend the `StreamEvent` union (next to the `dashboard` variants) with:

```ts
  | { type: "generative-delta"; tile: import("./generative.js").GenerativeTile }
  | { type: "generative"; board: import("./generative.js").GenerativeBoard; datasets: import("./generative.js").GenerativeDatasets; fieldMenu: import("./generative.js").FieldMenuEntry[] }
```

(Match the file's existing union style — if it uses top-level imports rather than inline `import()`, add a top-level type import instead.)

- [ ] **Step 3:** `npm run typecheck` at root → clean. Commit — `feat(shared): GenerativeTile/Board/Datasets types + generative stream events`

### Task 3: BFF allowlist schema + IR→VL compiler

**Files:**
- Create: `bff/src/generative/schema.ts`
- Test: `bff/src/generative/schema.test.ts`

**Interfaces:** Produces `tileIRSchema(fieldNames: Set<string>)` (zod v4), `compileTile(ir: TileIR, id: string): GenerativeTile`, `type TileIR`. Consumed by T5/T6.

Design note (stronger than filtering): the model emits a compact **IR** in OUR grammar; the server **compiles** it to the Vega-Lite fragment. Nothing un-modeled can survive into the VL spec — `usermeta`, `expr`, `href`, event overrides are unrepresentable in the output, not merely rejected. (Independently validated by Microsoft Flint, 2026-07.)

- [ ] **Step 1: Failing tests** — `bff/src/generative/schema.test.ts` (mirror the per-pid scratch/import discipline of `bff/src/dashboards/schema.test.ts` if present, else plain node:test):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { tileIRSchema, compileTile } from "./schema.js";

const MENU = new Set(["kind", "label", "degree", "flagged"]);
const ok = {
  title: "AEs by kind", dataset: "cited", mark: "bar",
  encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } },
};

test("accepts a minimal valid IR tile", () => {
  const r = tileIRSchema(MENU).safeParse(ok);
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues));
});

for (const [name, bad] of Object.entries({
  usermeta: { ...ok, usermeta: { embedOptions: { ast: false } } },
  "inline data": { ...ok, data: { values: [{ a: 1 }] } },
  "data url": { ...ok, data: { url: "https://evil.example/x.json" } },
  "image mark": { ...ok, mark: "image" },
  "href channel": { ...ok, encoding: { ...ok.encoding, href: { field: "label" } } },
  "lasso selection": { ...ok, params: [{ name: "sel", select: "lasso" }] },
  "event override": { ...ok, params: [{ name: "sel", select: "point", on: "pointerover" }] },
  "expression filter": { ...ok, transform: [{ filter: "datum.degree > 2" }] },
  "unknown field": { ...ok, encoding: { x: { field: "nope", type: "nominal" } } },
})) {
  test(`rejects ${name}`, () => {
    assert.equal(tileIRSchema(MENU).safeParse(bad).success, false);
  });
}

test("compileTile emits only allowlisted VL keys + named data", () => {
  const ir = tileIRSchema(MENU).parse({
    ...ok,
    transform: [{ filter: { field: "flagged", op: "=", value: true } }],
    params: [{ name: "pick", select: "point" }],
  });
  const tile = compileTile(ir, "t1");
  assert.deepEqual(tile.vlSkeleton.data, { name: "cited" });
  assert.deepEqual(Object.keys(tile.vlSkeleton).sort(),
    ["data", "encoding", "mark", "params", "title", "transform"]);
  assert.deepEqual(tile.vlSkeleton.transform, [{ filter: { field: "flagged", equal: true } }]);
  assert.deepEqual(tile.vlSkeleton.params, [{ name: "pick", select: { type: "point" } }]);
});
```

- [ ] **Step 2: Run to fail**, then implement `bff/src/generative/schema.ts`:

```ts
import { z } from "zod";
import type { GenerativeTile } from "@rnd/shared";

/** Model-facing IR — the model writes THIS grammar, never raw Vega-Lite.
 *  Every object is .strict(): unknown keys (usermeta, on, expr…) fail parse. */
const MARKS = ["bar", "line", "point", "area", "rect", "tick", "text"] as const;
const VL_TYPES = ["quantitative", "nominal", "ordinal", "temporal"] as const;
const AGGREGATES = ["count", "sum", "mean", "min", "max"] as const;
const CHANNELS = ["x", "y", "color", "size", "opacity", "tooltip"] as const;
const OPS = { "=": "equal", "!=": "notEqual", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", in: "oneOf" } as const;

export function tileIRSchema(fieldNames: Set<string>) {
  const fieldRef = z.string().refine((f) => fieldNames.has(f), { message: "field not in the bound field menu" });
  const channelDef = z.object({
    field: fieldRef.optional(),
    type: z.enum(VL_TYPES).optional(),
    aggregate: z.enum(AGGREGATES).optional(),
    bin: z.boolean().optional(),
  }).strict().refine((c) => c.field !== undefined || c.aggregate === "count", { message: "channel needs a field (or aggregate:count)" });
  return z.object({
    title: z.string().max(120),
    dataset: z.enum(["cited", "edges"]),
    mark: z.enum(MARKS),
    encoding: z.object(Object.fromEntries(CHANNELS.map((c) => [c, channelDef.optional()]))).strict()
      .refine((e) => Object.values(e).some(Boolean), { message: "at least one channel" }),
    transform: z.array(z.object({
      filter: z.object({
        field: fieldRef,
        op: z.enum(Object.keys(OPS) as [keyof typeof OPS, ...(keyof typeof OPS)[]]),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])).max(20)]),
      }).strict(),
    }).strict()).max(3).optional(),
    params: z.array(z.object({
      name: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,30}$/),
      select: z.enum(["point", "interval"]),
    }).strict()).max(2).optional(),
  }).strict();
}
export type TileIR = z.infer<ReturnType<typeof tileIRSchema>>;

/** Trusted compiler: IR → constrained VL fragment. The output contains ONLY
 *  keys this function writes — usermeta/expr/href/on are unrepresentable. */
export function compileTile(ir: TileIR, id: string): GenerativeTile {
  const vlSkeleton: Record<string, unknown> = {
    title: ir.title,
    data: { name: ir.dataset },
    mark: ir.mark,
    encoding: Object.fromEntries(Object.entries(ir.encoding).filter(([, v]) => v).map(([ch, def]) => [ch, {
      ...(def!.field ? { field: def!.field } : {}),
      ...(def!.type ? { type: def!.type } : {}),
      ...(def!.aggregate ? { aggregate: def!.aggregate } : {}),
      ...(def!.bin ? { bin: true } : {}),
    }])),
  };
  if (ir.transform?.length) {
    vlSkeleton.transform = ir.transform.map((t) => ({
      filter: { field: t.filter.field, [OPS[t.filter.op]]: t.filter.value },
    }));
  }
  if (ir.params?.length) {
    vlSkeleton.params = ir.params.map((p) => ({ name: p.name, select: { type: p.select } }));
  }
  return { id, title: ir.title, vlSkeleton, dataset: ir.dataset };
}
```

- [ ] **Step 3: Run** — `cd bff && node --import tsx --import ./test-setup.ts --test src/generative/schema.test.ts` → all pass. Commit — `feat(generative): zod-v4 tile IR allowlist + trusted IR→Vega-Lite compiler`

### Task 4: Dataset binding + typed field menu

**Files:**
- Create: `bff/src/generative/bind.ts`
- Test: `bff/src/generative/bind.test.ts`

**Interfaces:** Produces `bindDatasets(citedNodeIds: string[]): Promise<{ datasets: GenerativeDatasets; fieldMenu: FieldMenuEntry[] }>`. Consumes `getFullGraph("all")` from `bff/src/graph/queries.ts` — **CALL it, never modify it** (FAIR canvas byte-identical invariant).

- [ ] **Step 1: Failing test** — inject a fake graph rather than hitting Neo4j: export a pure core `bindFromGraph(g: GraphPayload, citedNodeIds: string[])` and a thin `bindDatasets` that awaits `getFullGraph`. Test `bindFromGraph` with a 4-node/3-edge fixture: cited subset only; `degree` counts only edges among CITED nodes; field menu lists `kind`(nominal)/`label`(nominal)/`degree`(quantitative)/`flagged`(nominal) with correct cardinalities; edges dataset rows carry `source`,`target`,`kind`; empty cited ids → empty rows, empty menu.
- [ ] **Step 2: Implement** `bind.ts`:

```ts
import type { GraphPayload, GenerativeDatasets, FieldMenuEntry } from "@rnd/shared";
import { getFullGraph } from "../graph/queries.js";

/** Bind tabular datasets from ALREADY-CITED nodes only. Deterministic: sorted by id. */
export function bindFromGraph(g: GraphPayload, citedNodeIds: string[]): { datasets: GenerativeDatasets; fieldMenu: FieldMenuEntry[] } {
  const cited = new Set(citedNodeIds);
  const nodes = g.nodes.filter((n) => cited.has(n.id)).sort((a, b) => a.id.localeCompare(b.id));
  const edges = g.edges.filter((e) => cited.has(e.source) && cited.has(e.target));
  const degree = new Map<string, number>();
  for (const e of edges) { degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1); }
  const citedRows = nodes.map((n) => ({
    id: n.id, label: n.label, kind: n.kind,
    degree: degree.get(n.id) ?? 0,
    flagged: Boolean((n as { flagged?: boolean }).flagged ?? false),
  }));
  const edgeRows = edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
  const card = (rows: Record<string, unknown>[], f: string) => new Set(rows.map((r) => String(r[f]))).size;
  const fieldMenu: FieldMenuEntry[] = citedRows.length === 0 ? [] : [
    { name: "kind", vlType: "nominal", cardinality: card(citedRows, "kind") },
    { name: "label", vlType: "nominal", cardinality: card(citedRows, "label") },
    { name: "degree", vlType: "quantitative", cardinality: card(citedRows, "degree") },
    { name: "flagged", vlType: "nominal", cardinality: card(citedRows, "flagged") },
  ];
  return { datasets: { cited: citedRows, edges: edgeRows }, fieldMenu };
}

export async function bindDatasets(citedNodeIds: string[]) {
  return bindFromGraph(await getFullGraph("all"), citedNodeIds);
}
```

  Adjust the row projection if `GraphNode`/`GraphEdge` in `shared/src/types.ts` name these props differently (`kind` and `label` verified present; check the edge's source/target prop names — the FAIR canvas payload uses them via GraphCanvas).
- [ ] **Step 3: Run tests → pass. Commit** — `feat(generative): cited-only dataset binding + typed field menu`

### Task 5: Deterministic template fallback

**Files:**
- Create: `bff/src/generative/templates.ts`
- Test: `bff/src/generative/templates.test.ts`

**Interfaces:** Produces `templateBoard(citedNodeIds: string[], fieldMenu: FieldMenuEntry[]): GenerativeBoard` (source: `"template"`). Consumes `compileTile` (T3). Used by T6 when the model output is invalid/exhausted/timed out.

- [ ] **Step 1: Failing test:** with a non-empty menu, returns 2 tiles — `count by kind` bar and `top degree` bar — each `vlSkeleton.data` named `cited`, ids `tmpl-kind` / `tmpl-degree`; deterministic (two calls deep-equal); empty menu → `{ version: 1, tiles: [], citedNodeIds, source: "template" }`.
- [ ] **Step 2: Implement** by building two `TileIR` literals and passing them through `tileIRSchema(names).parse` + `compileTile` (the fallback obeys the same allowlist — no bypass lane):

```ts
import type { FieldMenuEntry, GenerativeBoard } from "@rnd/shared";
import { tileIRSchema, compileTile } from "./schema.js";

export function templateBoard(citedNodeIds: string[], fieldMenu: FieldMenuEntry[]): GenerativeBoard {
  const names = new Set(fieldMenu.map((f) => f.name));
  if (names.size === 0) return { version: 1, tiles: [], citedNodeIds, source: "template" };
  const schema = tileIRSchema(names);
  const tiles = [
    compileTile(schema.parse({
      title: "Cited evidence by kind", dataset: "cited", mark: "bar",
      encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" }, color: { field: "kind", type: "nominal" } },
    }), "tmpl-kind"),
    compileTile(schema.parse({
      title: "Most connected cited nodes", dataset: "cited", mark: "bar",
      encoding: { x: { field: "degree", type: "quantitative" }, y: { field: "label", type: "nominal" } },
    }), "tmpl-degree"),
  ];
  return { version: 1, tiles, citedNodeIds, source: "template" };
}
```

- [ ] **Step 3: Run → pass. Commit** — `feat(generative): deterministic template fallback board (same allowlist path)`

### Task 6: Streaming composer with repair loop

**Files:**
- Create: `bff/src/generative/composer.ts`
- Test: `bff/src/generative/composer.test.ts`
- Modify (mechanical refactor): extract the brace-balanced scanner `extractCompleteWidgets` body from `bff/src/dashboards/composer.ts:185` into `bff/src/llm/partialJson.ts` as `extractCompleteObjects(buffer: string, arrayKey: string): unknown[]`; re-implement `extractCompleteWidgets` as `extractCompleteObjects(buffer, "widgets")`. Existing dashboards tests must stay green unchanged.

**Interfaces:** Produces `composeGenerativeStreaming(input: { question: string; answerText: string; citedNodeIds: string[] }, onDelta: (tile: GenerativeTile) => void): Promise<{ board: GenerativeBoard; datasets: GenerativeDatasets; fieldMenu: FieldMenuEntry[] }>`. MIRROR the structure of `composeDashboardStreaming` (`bff/src/dashboards/composer.ts:218`) — same provider seam, same token-buffer + scan loop, same never-throws contract.

Behavior (each point is a test):
1. Prompt contains the typed field menu (`name (vlType, ~N distinct)` lines), the two dataset names, and the IR grammar summary; model asked for `{"tiles":[...]}`.
2. Streaming: each object closed in the buffer under `"tiles"` is parsed with `tileIRSchema`; valid → `compileTile` → `onDelta`; invalid → skipped (never emitted), remembered for repair. De-dup by title, cap **6** tiles (matches spec).
3. Repair: after the stream settles, if ≥1 tile failed validation and <6 valid tiles exist, ONE repair call re-prompts with the zod issues verbatim (`repair round 1/1` — a single round; research shows round 1 captures most of the gain); repaired valid tiles append (still capped).
4. Fallback: zero valid tiles after repair (or provider throw/timeout) → `templateBoard(...)`; `source` reflects `"llm"` vs `"template"`.
5. Grounding: `bindDatasets` is called ONCE up front; empty `fieldMenu` (no cited nodes resolve) → immediate template path with empty tiles → caller's grounded gate means this normally never renders.
- [ ] **Steps:** failing tests (fake provider injected the same way `composer.test.ts` fakes the dashboard model — copy that fixture pattern; fake `bindFromGraph` fixture, not Neo4j) → implement → `cd bff && node --import tsx --import ./test-setup.ts --test src/generative/composer.test.ts src/dashboards/streaming.test.ts` (both green — the refactor must not break dashboards) → commit `feat(generative): streaming IR composer with single-round repair + template fallback`

### Task 7: Wire the lane — agent, bridge, runtime agent registration

**Files:**
- Modify: `bff/src/ask/agent.ts` (compose hook ~L308-333 + the grounded-branch call at ~L474), `bff/src/ask/aguiBridge.ts` (sink cases + `compose` query param), `bff/src/ask/copilotRuntime.ts` (second named agent)
- Test: `bff/src/generative/wiring.test.ts`

**Interfaces:** Consumes T6's `composeGenerativeStreaming`. Produces: `render_generative` AG-UI tool calls whose args are `{ tile, datasets, fieldMenu, runId, final?, board? }`.

- [ ] **Step 1:** `aguiBridge.ts` — parse `compose` from the request query (`req.query` in the Fastify handler; the same handler that receives RunAgentInput) and pass `generative: compose === "generative"` into the agent invocation options.
- [ ] **Step 2:** `agent.ts` — in the grounded compose hook, branch: `generative ? composeGenerativeStreaming(...)  → sink({type:"generative-delta", tile}) per delta + final sink({type:"generative", board, datasets, fieldMenu}) : existing dashboard path`. The refusal/fallback gate stays IDENTICAL (compose runs only where the dashboard compose runs today).
- [ ] **Step 3:** `aguiBridge.ts` sink switch — add `generative-delta` and `generative` cases emitting a self-contained `render_generative` TOOL_CALL (START/ARGS/END) per event, byte-patterned on the `dashboard-delta` / `dashboard` cases INCLUDING the per-run `dashboardRunId` stamping (`runId` on every args, `final: true` on the final; reuse one `randomUUID()` per run — mirror commit d064402's pattern). The final's args carry `board`, `datasets`, `fieldMenu`; deltas carry `tile`, `datasets`, `fieldMenu` (datasets ride every call so a mid-stream tile can render immediately).
- [ ] **Step 4:** `copilotRuntime.ts` — register the second agent:

```ts
runtime = new CopilotRuntime({
  agents: {
    default: new HttpAgent({ url: aguiUrl }),
    generative: new HttpAgent({ url: `${aguiUrl}?compose=generative` }),
  },
});
```

- [ ] **Step 5:** `wiring.test.ts` — drive the bridge sink with a scripted event sequence (mirror `bff/src/dashboards/streaming.test.ts`'s harness): asserts one `render_generative` TOOL_CALL per delta + a final with `final:true` and a shared `runId`; asserts NOTHING is emitted on a refusal run. Run it + `src/ask/refusal.test.ts`.
- [ ] **Step 6:** Commit — `feat(generative): compose=generative lane through agent/bridge + second runtime agent`

### Task 8: Web generative store (run-gated tiles) + cross-filter store

**Files:**
- Create: `web/src/generative/generativeStore.ts`, `web/src/generative/filterStore.ts`
- Test: `web/src/generative/generativeStore.test.ts`

**Interfaces:** Produces `applyTile(tile, datasets, fieldMenu, meta?: {runId?: string; final?: boolean})`, `currentBoard(): { tiles: GenerativeTile[]; datasets: GenerativeDatasets | null }`, `subscribe(fn)`, `resetGenerative()`; `filterStore`: `setSelection(ids: string[] | null)`, `getSelection()`, `subscribeFilter(fn)`.

- [ ] **Step 1: Failing tests** — port the SHAPE of `web/src/dashboards/lineageStore.runs.test.ts` (this store is single-surface, tiles-by-id, in-memory only — no sessionStorage): same-run deltas accumulate (update-by-id); byte-identical re-apply = cache hit, no notify; NEW runId rolls back to the committed tile set (failed-run partials vanish); retired runId dropped; **final-that-is-a-cache-hit still commits** (port the c8f24d7 regression test); no-meta calls merge legacy-style; filterStore notifies on set, `null` clears.
- [ ] **Step 2: Implement** `generativeStore.ts` by transcribing the gate skeleton from `web/src/dashboards/lineageStore.ts` (steps 1–5 in `applyIncoming`, incl. the cache-hit `final` commit and bounded `seenRuns`/`applied`) with: state `{ tiles: Map<string,GenerativeTile>, committed: Map<string,GenerativeTile>, datasets, fieldMenu, runId, seenRuns, applied }`; merge = `tiles.set(tile.id, tile)` (cap 6 — ignore beyond); sig = `JSON.stringify(tile)`. `filterStore.ts` is ~15 lines (value + Set of listeners).
- [ ] **Step 3:** `cd web && node --import tsx --test src/generative/generativeStore.test.ts` → pass. Commit — `feat(web): run-gated generative tile store + cross-filter store`

### Task 9: VegaTile — locked runtime renderer

**Files:**
- Create: `web/src/generative/VegaTile.tsx`
- Test: `web/src/generative/vegaLockdown.test.ts`
- Modify: `web/vite.config.ts` (`build.rollupOptions.output.manualChunks = { vega: ["vega", "vega-lite", "vega-embed"] }` — merge into existing config shape)

**Interfaces:** Produces `<VegaTile tile datasets onSelect={(ids: string[] | null) => void} />`. Produces `LOCKED_EMBED_OPTIONS` + `denyAllLoader` as named exports so the lockdown test asserts them directly.

- [ ] **Step 1: Failing lockdown test** (pure, no DOM):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { LOCKED_EMBED_OPTIONS, denyAllLoader, prepareSpec } from "./VegaTile.js";

test("embed options are the locked-runtime set", () => {
  assert.equal(LOCKED_EMBED_OPTIONS.ast, true);
  assert.equal(LOCKED_EMBED_OPTIONS.actions, false);
  assert.equal(LOCKED_EMBED_OPTIONS.renderer, "canvas");
  assert.equal(LOCKED_EMBED_OPTIONS.loader, denyAllLoader);
});

test("deny-all loader rejects every operation", async () => {
  for (const op of ["load", "http", "file"] as const) {
    await assert.rejects(() => (denyAllLoader as Record<string, (u: string) => Promise<string>>)[op]("https://x"), /blocked/);
  }
  assert.equal(denyAllLoader.sanitize && (await denyAllLoader.sanitize("https://x", {}).catch(() => null)), null);
});

test("prepareSpec strips usermeta and injects ONLY the named dataset", () => {
  const out = prepareSpec(
    { vlSkeleton: { data: { name: "cited" }, mark: "bar", usermeta: { embedOptions: { ast: false } } }, dataset: "cited", id: "t", title: "t" },
    { cited: [{ id: "n1" }], edges: [] },
  );
  assert.equal("usermeta" in out, false);
  assert.deepEqual(out.datasets, { cited: [{ id: "n1" }] });
});
```

- [ ] **Step 2: Implement** `VegaTile.tsx` — named exports `denyAllLoader` (`{ load/http/file: async () => { throw new Error("blocked: external loading is disabled"); }, sanitize: async () => { throw new Error("blocked"); } }`), `LOCKED_EMBED_OPTIONS = { ast: true, actions: false, renderer: "canvas", loader: denyAllLoader } as const`, and pure `prepareSpec(tile, datasets)` → `{ ...vlSkeleton-without-usermeta, datasets: { [tile.dataset]: rows } }` (belt-and-suspenders: the compiler already can't emit usermeta). Component: `useEffect` → `const { default: embed } = await import("vega-embed")` (lazy chunk) → `const result = await embed(el, spec, LOCKED_EMBED_OPTIONS)`; for each compiled `params` name, `result.view.addSignalListener(name + "_store"-free API: use result.view.addSignalListener(p.name, handler)` mapping the selection store's datum rows to their `id` values → `onSelect(ids.length ? ids : null)`; cleanup `result.finalize()`. Never assign `window.vega`/`window.VEGA_DEBUG`. Tile chrome: title + amber `exploratory` badge (reuse `.badge` styling conventions from `DashboardCanvas`).
- [ ] **Step 3:** run lockdown test → pass; `npm run typecheck`. Commit — `feat(web): VegaTile locked vega-embed runtime (ast/canvas/deny-all loader/usermeta strip) + lazy vega chunk`

### Task 10: render_generative renderer + chat registration

**Files:**
- Create: `web/src/generative/generativeRenderer.tsx`
- Modify: `web/src/beats/CopilotChatBeat.tsx` (register renderer in the `renderToolCalls` array; add optional prop `agentId?: string` and pass it to the CopilotKit chat/agent binding — VERIFY the exact prop against the installed `@copilotkit` v2 `.d.ts` (`useAgent({ agentId })` / chat `agentId` prop) before writing; the existing `agent` object comes from `useAgent` near `CopilotChatBeat.tsx:848`'s `<BeatStarters agent={agent} />`)
- Test: `web/src/generative/generativeRenderer.test.ts` (args schema unit)

**Interfaces:** Consumes T8 store. The renderer follows `dashboardRenderer.tsx`'s EXACT shape: zod-v3 args object — **declare every key or v3 strips it**:

```ts
const args = z.object({
  tile: z.any().optional(),
  board: z.any().optional(),
  datasets: z.any().optional(),
  fieldMenu: z.any().optional(),
  runId: z.string().optional(),
  final: z.boolean().optional(),
});
```

- [ ] Renderer `render:` calls `applyTile(tile, datasets, fieldMenu, { runId, final })` per delta (and each `board.tiles` entry on the final), then returns the chip (`→ opened in canvas · N tiles`) — chip-only, the canvas subscribes to the store (mirror `renderChipOnly` in `dashboardRenderer`). Args-schema test: parsing a payload with `runId`/`final` PRESERVES them (regression for the v3-strip gotcha).
- [ ] Register in `renderToolCalls` (name: `render_generative`) unconditionally — the tool call only ever arrives on the generative agent's thread.
- [ ] Run renderer test + typecheck. Commit — `feat(web): render_generative chip renderer + agentId binding seam in CopilotChatBeat`

### Task 11: GenerativeStudio beat + App wiring + FiltersPopover

**Files:**
- Create: `web/src/generative/GenerativeStudio.tsx`, `web/src/components/FiltersPopover.tsx`
- Modify: `web/src/App.tsx` (add `"generative"` beat — ALL 4 layout guards that mention `"studio"`: fullHeight, grid-cols, right-aside, AskDock; nav entry `✨ Generative Studio`), the current `FiltersRail` render site (wrap in the popover)

**Interfaces:** Consumes T8/T9/T10.

- [ ] `GenerativeStudio.tsx` — transcribe `DashboardStudio.tsx`'s split-view skeleton: left `<CopilotChatBeat agentId="generative" dashboardTarget="pane" …/>`; right pane subscribes to `generativeStore` + `filterStore` and renders a responsive tile grid of `<VegaTile tile datasets={filteredDatasets} onSelect={setSelection}/>` where `filteredDatasets` subsets `cited` rows to the selection (null = all) — cross-filter v1 re-embeds on selection change; a header line shows `exploratory · not certified` + tile count + a `🛡 how this is safe` popover (one paragraph: spec/data split); selecting exactly one id also calls the existing `onNodeClick` with that node (bridge to chat context pills / graph focus).
- [ ] `FiltersPopover.tsx` — move the existing `FiltersRail` content into a popover anchored to a `⚙ Filters` button (mirror the ToolsMenu popover pattern from `web/src/components/ToolsMenu.tsx`); the always-open rail render site now renders the button. Keyboard: Esc closes; click-outside closes.
- [ ] Empty-state starters (3 prompts, e.g. "Chart the cited evidence for the myocarditis signal — pick the best marks yourself.") mirroring `DashboardStudio`'s `STARTERS`.
- [ ] Typecheck + existing web tests still green. Commit — `feat(web): Generative Studio beat (split view, cross-filtered VegaTiles) + FiltersRail→popover`

### Task 12: Full gate + live render-proof

**Files:** none new (fixes only if the proof fails).

- [ ] `npm run typecheck` (3 ws) → clean.
- [ ] Targeted suites, ALL green: `cd bff && node --import tsx --import ./test-setup.ts --test src/generative/floors.test.ts src/generative/schema.test.ts src/generative/bind.test.ts src/generative/templates.test.ts src/generative/composer.test.ts src/generative/wiring.test.ts src/dashboards/streaming.test.ts src/ask/refusal.test.ts` and `cd web && node --import tsx --test src/generative/generativeStore.test.ts src/generative/vegaLockdown.test.ts src/generative/generativeRenderer.test.ts src/dashboards/lineageStore.test.ts src/dashboards/lineageStore.persist.test.ts src/dashboards/lineageStore.runs.test.ts`. NEVER full `npm test`.
- [ ] Live proof on :5173 (BFF on :8787 — if a restart is needed, confirm ownership first; config changes need a REAL restart, tsx watch does not reload config): open Generative Studio → grounded starter → tiles stream into the right pane (≥1 `render_generative` delta before the final in the SSE), exploratory badges render, clicking a bar narrows sibling tiles + sets a chat context pill, FiltersPopover opens/closes, zero console errors, FinOps ledger shows the run `estimated:false`. Off-graph question → refusal card, canvas untouched.
- [ ] Update `.superpowers/sdd/progress.md` with per-task commits. Commit any proof-driven fixes — `fix(generative): <what the live proof caught>`.

## Self-review (writing-plans checklist)

- Spec coverage: every spec §3 allowlist row has a schema test (T3); §4 seams → T7/T10/T11; §5 threat table → T3/T9 tests + floors (T1); §6 gates → T12. Cross-filter animation intentionally deferred (spec flags it build-time; v1 re-embeds).
- Placeholders: none — every code step has literal code or an exact mirror-target (`file:line`/symbol) that exists (verified this session: `extractCompleteWidgets` at composer.ts:185, compose hook agent.ts:308-333/474, `getFullGraph` queries.ts:85, agent binding near CopilotChatBeat.tsx:848).
- Type consistency: `GenerativeTile/Board/Datasets/FieldMenuEntry` (T2) are the only cross-task types; `tileIRSchema/compileTile` (T3) consumed in T5/T6; store API (T8) consumed in T10/T11.
