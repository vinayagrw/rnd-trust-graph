/**
 * Board orchestrator — hermetic tests. Real `bindFromGraph` over a fixture graph; a
 * content-addressed fake `run` (routes by prompt marker, so it is robust to the
 * worker pool's non-deterministic ordering). No Neo4j, no real CLI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GraphPayload, GraphNode, GraphEdge, BoardPlan, GenerativeTile } from "@rnd/shared";
import type { ClaudeCodeRunOpts, ClaudeCodeResult } from "../llm/claudeCode.js";
import { bindFromGraph } from "./bind.js";
import { composeBoardOrchestrated, chooseByFitnessThenFreshness, type ComposeBoardDeps } from "./orchestrator.js";
import type { ComposeGenerativeInput } from "./composer.js";

const nodes: GraphNode[] = [
  { id: "n1", kind: "Drug", label: "Drug A" },
  { id: "n2", kind: "AdverseEvent", label: "AE B" },
  { id: "n3", kind: "AdverseEvent", label: "AE C" },
];
const edges: GraphEdge[] = [{ id: "e1", source: "n1", target: "n2", kind: "TARGETS" }];
const graph: GraphPayload = { nodes, edges };
const input: ComposeGenerativeInput = { question: "why afib?", answerText: "supported by metrics.", citedNodeIds: ["n1", "n2", "n3"] };
const realBind = async (ids: string[]) => bindFromGraph(graph, ids);

const goodTile = { title: "By kind", dataset: "cited", mark: "bar", encoding: { x: { field: "kind", type: "nominal" }, y: { aggregate: "count" } } };
const stream = (o: ClaudeCodeRunOpts, s: string) => { for (let i = 1; i <= s.length; i += 7) o.sink({ type: "token", text: s.slice(i - 1, i + 6) }); };

/** A content-addressed provider: plan prompts get the plan, reflexion prompts get a
 *  tile, worker prompts get a tile (or garbage if the slot intent matches `badIntent`). */
function provider(opts: { plan: BoardPlan; badIntent?: string }) {
  const prompts: string[] = [];
  const run = async (o: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> => {
    prompts.push(o.prompt);
    let script = "";
    if (o.prompt.includes("You PLAN a dashboard")) script = JSON.stringify({ plan: [opts.plan] });
    else if (o.prompt.includes("reflexion round")) script = JSON.stringify({ tiles: [goodTile] });
    else if (o.prompt.includes("compose ONE chart tile")) {
      script = opts.badIntent && o.prompt.includes(opts.badIntent) ? "not json" : JSON.stringify({ tiles: [goodTile] });
    }
    stream(o, script);
    return { ok: true };
  };
  return { run, prompts, count: (needle: string) => prompts.filter((p) => p.includes(needle)).length };
}

const KPI_PLAN: BoardPlan = {
  archetype: "kpi-grid",
  filterFields: ["kind"],
  slots: [
    { role: "kpi", dataset: "cited", intent: "count of cited nodes" },
    { role: "detail", dataset: "cited", intent: "distribution by kind" },
    { role: "detail", dataset: "cited", intent: "another view" },
  ],
};

test("streams every tile and returns a board with host-owned layout, filters, score and plan", async () => {
  const p = provider({ plan: KPI_PLAN });
  const deltas: GenerativeTile[] = [];
  const { board } = await composeBoardOrchestrated(input, (t) => deltas.push(t), { bind: realBind, run: p.run } as ComposeBoardDeps);
  assert.equal(deltas.length, 3, "1 KPI + 2 chart tiles all streamed");
  assert.equal(board.layout, "kpi-grid");
  assert.equal(board.plan?.archetype, "kpi-grid");
  assert.ok(typeof board.boardScore === "number");
  assert.ok(typeof board.boardRationale === "string" && board.boardRationale.length > 0);
  assert.ok(board.filters?.some((f) => f.field === "kind"), "the requested kind filter is derived");
  assert.equal(board.tiles.filter((t) => t.role === "kpi").length, 1, "the KPI slot rendered as a KPI card");
  assert.ok(board.tiles.every((t) => t.span === 1 || t.span === 2), "every tile has a host-assigned span");
  // Candidate-and-rank audit (the "best board" hook the UI surfaces) — every CHART tile
  // records the winning candidate's score; KPI cards are host-made and carry none.
  const chartTiles = board.tiles.filter((t) => t.role !== "kpi");
  assert.ok(chartTiles.length > 0 && chartTiles.every((t) => typeof t.candidateScore === "number"), "each chart tile records its winning candidate score");
});

test("a failed chart slot triggers EXACTLY ONE reflexion round that fills it", async () => {
  const plan: BoardPlan = {
    archetype: "analytic-grid",
    filterFields: [],
    slots: [
      { role: "detail", dataset: "cited", intent: "good chart alpha" },
      { role: "detail", dataset: "cited", intent: "bad chart beta" },
    ],
  };
  const p = provider({ plan, badIntent: "bad chart beta" });
  const deltas: GenerativeTile[] = [];
  const { board } = await composeBoardOrchestrated(input, (t) => deltas.push(t), { bind: realBind, run: p.run });
  assert.equal(p.count("reflexion round"), 1, "exactly one reflexion call — never a loop");
  assert.equal(board.tiles.length, 2, "the failed slot was filled by reflexion");
});

test("every worker prompt carries the field menu and its slot intent", async () => {
  const plan: BoardPlan = {
    archetype: "analytic-grid",
    filterFields: [],
    slots: [{ role: "detail", dataset: "cited", intent: "distribution by kind" }],
  };
  const p = provider({ plan });
  await composeBoardOrchestrated(input, () => {}, { bind: realBind, run: p.run });
  const workerPrompt = p.prompts.find((pr) => pr.includes("compose ONE chart tile"))!;
  assert.match(workerPrompt, /distribution by kind/);
  assert.match(workerPrompt, /kind \(nominal/);
});

test("the worker prompt teaches a chart cookbook so richer encodings are reachable (donut/heatmap/grouped/stacked)", async () => {
  const plan: BoardPlan = { archetype: "analytic-grid", filterFields: [], slots: [{ role: "detail", dataset: "cited", intent: "distribution by kind" }] };
  const p = provider({ plan });
  await composeBoardOrchestrated(input, () => {}, { bind: realBind, run: p.run });
  const workerPrompt = p.prompts.find((pr) => pr.includes("compose ONE chart tile"))!;
  for (const recipe of [/Donut/i, /Heatmap/i, /Grouped bars/i, /Stacked bars/i, /Small multiples/i]) {
    assert.match(workerPrompt, recipe, `worker prompt should teach ${recipe}`);
  }
});

test("a never-resolving worker is aborted at the timeout and the board still returns", async () => {
  const plan: BoardPlan = { archetype: "analytic-grid", filterFields: [], slots: [{ role: "detail", dataset: "cited", intent: "hang" }] };
  const run = async (o: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> => {
    if (o.prompt.includes("You PLAN a dashboard")) { stream(o, JSON.stringify({ plan: [plan] })); return { ok: true }; }
    // worker + reflexion both hang until aborted
    return new Promise((resolve) => o.signal.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" })));
  };
  const start = Date.now();
  const { board } = await composeBoardOrchestrated(input, () => {}, { bind: realBind, run, timeoutMs: 30, budgetMs: 500 });
  assert.ok(board.layout, "a board (template fallback) is still returned");
  assert.ok(Date.now() - start < 3000, "did not hang on the never-resolving worker");
});

test("avoidArchetype rotates the board to a DIFFERENT layout ('more dashboards' of the same evidence)", async () => {
  // The planner insists on kpi-grid; asking to avoid kpi-grid must yield a different archetype.
  const p = provider({ plan: KPI_PLAN });
  const { board } = await composeBoardOrchestrated(input, () => {}, {
    bind: realBind,
    run: p.run,
    avoidArchetype: "kpi-grid",
  } as ComposeBoardDeps);
  assert.notEqual(board.layout, "kpi-grid", "the avoided archetype is rotated away from");
  assert.match(p.prompts.find((pr) => pr.includes("You PLAN a dashboard"))!, /ANOTHER dashboard/, "the planner was nudged for a fresh perspective");
});

/** A synthetic candidate carrying just the mark the selector reads. */
const cand = (mark: string, score: number) => ({ tile: { vlSkeleton: { mark } } as unknown as GenerativeTile, score });

test("diversity is a TIEBREAKER, not an override — a meaningfully better repeated mark still wins", () => {
  // 'bar' already on the board; the fresh 'point' fits far worse (0.60 vs 0.90).
  // Fitness must win: the repeated bar is chosen despite being a repeat.
  const used = new Set(["bar"]);
  const chosen = chooseByFitnessThenFreshness([cand("bar", 0.9), cand("point", 0.6)], used);
  assert.equal(chosen.tile.vlSkeleton.mark, "bar", "the far better-fitting chart wins even though its mark repeats");
});

test("diversity breaks a near-tie — an equally-good fresh mark is preferred over a repeat", () => {
  // Within DIVERSITY_EPSILON (0.90 vs 0.88): freshness decides, so the unused 'point' wins.
  const used = new Set(["bar"]);
  const chosen = chooseByFitnessThenFreshness([cand("bar", 0.9), cand("point", 0.88)], used);
  assert.equal(chosen.tile.vlSkeleton.mark, "point", "a near-tie prefers the visually distinct mark");
});

test("a throwing planner falls back to the default plan and still composes a board", async () => {
  const run = async (o: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> => {
    if (o.prompt.includes("You PLAN a dashboard")) throw new Error("planner boom");
    stream(o, JSON.stringify({ tiles: [goodTile] }));
    return { ok: true };
  };
  const { board } = await composeBoardOrchestrated(input, () => {}, { bind: realBind, run });
  assert.equal(board.layout, "analytic-grid", "defaultPlan's archetype");
  assert.ok(board.tiles.length >= 1);
  assert.ok(board.plan);
});
