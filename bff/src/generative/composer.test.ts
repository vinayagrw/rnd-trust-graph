/**
 * Generative Studio streaming composer — hermetic tests.
 *
 * No Neo4j, no real CLI: both `bind` and `run` (the LLM transport, same shape
 * as `runClaudeCode`) are dependency-injected via the optional third `deps`
 * argument, so `composeGenerativeStreaming(input, onDelta)` keeps its committed
 * two-argument public contract while tests fully control grounding + the model.
 *
 * `bind` is backed by the REAL T4 `bindFromGraph` over an inline fixture graph
 * (not a stub returning canned rows) so these tests also prove the composer
 * wires the pure binder correctly, without touching Neo4j.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GraphPayload, GraphNode, GraphEdge, FieldMenuEntry, GenerativeTile } from "@rnd/shared";
import type { ClaudeCodeRunOpts, ClaudeCodeResult } from "../llm/claudeCode.js";
import { bindFromGraph } from "./bind.js";
import { templateBoard } from "./templates.js";
import { composeGenerativeStreaming, type ComposeGenerativeInput, type ComposeGenerativeDeps } from "./composer.js";

// ---- fixture graph (mirrors bind.test.ts's shape) -------------------------
const nodes: GraphNode[] = [
  { id: "n1", kind: "Drug", label: "Drug A" },
  { id: "n2", kind: "AdverseEvent", label: "AE B" },
  { id: "n3", kind: "AdverseEvent", label: "AE C" },
];
const edges: GraphEdge[] = [
  { id: "e1", source: "n1", target: "n2", kind: "TARGETS" },
  { id: "e2", source: "n2", target: "n3", kind: "SUPPORTED_BY" },
];
const graph: GraphPayload = { nodes, edges };
const citedNodeIds = ["n1", "n2", "n3"];

const input: ComposeGenerativeInput = {
  question: "why myocarditis?",
  answerText: "supported by disproportionality metrics.",
  citedNodeIds,
};

/** The real T4 binder over the fixture graph — hermetic, no Neo4j. */
const realBind = async (ids: string[]) => bindFromGraph(graph, ids);

/** A `bind` stub for the "no fields resolve" grounding test. */
const emptyBind = async (ids: string[]) => ({ datasets: { cited: [], metrics: [], edges: [] }, fieldMenu: [] as FieldMenuEntry[] });

/** Build a fake provider (same call shape as `runClaudeCode`) that feeds a
 *  scripted list of raw-text chunks to `sink` as `token` events, one per call,
 *  then resolves `{ ok: true }`. Multiple scripts == multiple rounds (initial,
 *  then repair). Records every prompt it was called with. */
function scriptedProvider(scripts: string[]) {
  const prompts: string[] = [];
  let calls = 0;
  const run = async (opts: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> => {
    prompts.push(opts.prompt);
    const script = scripts[calls] ?? scripts[scripts.length - 1] ?? "";
    calls++;
    // Simulate token-by-token streaming so the incremental scanner is exercised.
    for (let i = 1; i <= script.length; i += 5) {
      opts.sink({ type: "token", text: script.slice(i - 1, i + 4) });
    }
    return { ok: true };
  };
  return { run, prompts, callCount: () => calls };
}

function tile(title: string, field = "kind"): Record<string, unknown> {
  return {
    title,
    dataset: "cited",
    mark: "bar",
    encoding: { x: { field, type: "nominal" }, y: { aggregate: "count" } },
  };
}

function tilesBuffer(tiles: Record<string, unknown>[]): string {
  return JSON.stringify({ tiles });
}

// ---- 1. prompt content -----------------------------------------------------

test("prompt carries the typed field menu, dataset names, and IR grammar; asks for {tiles:[...]}", async () => {
  const provider = scriptedProvider([tilesBuffer([tile("Cited by kind")])]);
  const deps: ComposeGenerativeDeps = { bind: realBind, run: provider.run };
  await composeGenerativeStreaming(input, () => {}, deps);
  const prompt = provider.prompts[0]!;
  assert.match(prompt, /kind \(nominal, ~2 distinct\)/);
  assert.match(prompt, /label \(nominal, ~3 distinct\)/);
  assert.match(prompt, /degree \(quantitative, ~\d+ distinct\)/);
  assert.match(prompt, /\bcited\b/);
  assert.match(prompt, /\bedges\b/);
  assert.match(prompt, /"tiles"/);
  assert.match(prompt, /mark/i);
  assert.match(prompt, /encoding/i);
});

// ---- 2. streaming: valid -> onDelta, invalid skipped, de-dup, cap 6 --------

test("streams onDelta the instant each valid tile closes, in order", async () => {
  const buf = tilesBuffer([tile("Tile A"), tile("Tile B"), tile("Tile C")]);
  const provider = scriptedProvider([buf]);
  const deltas: GenerativeTile[] = [];
  const result = await composeGenerativeStreaming(input, (t) => deltas.push(t), { bind: realBind, run: provider.run });
  assert.deepEqual(deltas.map((t) => t.title), ["Tile A", "Tile B", "Tile C"]);
  assert.equal(result.board.source, "llm");
  assert.deepEqual(result.board.tiles.map((t) => t.title), ["Tile A", "Tile B", "Tile C"]);
  assert.deepEqual(result.board.citedNodeIds, citedNodeIds);
});

test("an invalid tile (unknown field) is skipped — never emitted", async () => {
  const buf = tilesBuffer([tile("Good"), tile("Bad", "not-a-field")]);
  const provider = scriptedProvider([buf, tilesBuffer([tile("Bad", "degree")])]); // repair fixes it
  const deltas: GenerativeTile[] = [];
  await composeGenerativeStreaming(input, (t) => deltas.push(t), { bind: realBind, run: provider.run });
  // "Bad" with the bogus field must never have been emitted as the invalid one —
  // only the repaired version (dataset field "degree") should ever reach onDelta.
  const badDeltas = deltas.filter((t) => t.title === "Bad");
  assert.equal(badDeltas.length, 1);
  assert.deepEqual((badDeltas[0]!.vlSkeleton.encoding as any).x, { field: "degree", type: "nominal" });
});

test("de-dupes by title — a repeated title is emitted only once", async () => {
  const buf = tilesBuffer([tile("Same"), tile("Same"), tile("Different")]);
  const provider = scriptedProvider([buf]);
  const deltas: GenerativeTile[] = [];
  await composeGenerativeStreaming(input, (t) => deltas.push(t), { bind: realBind, run: provider.run });
  assert.deepEqual(deltas.map((t) => t.title), ["Same", "Different"]);
});

test("caps at 6 tiles even when 8 valid tiles are offered", async () => {
  const many = Array.from({ length: 8 }, (_, i) => tile(`T${i}`));
  const provider = scriptedProvider([tilesBuffer(many)]);
  const deltas: GenerativeTile[] = [];
  const result = await composeGenerativeStreaming(input, (t) => deltas.push(t), { bind: realBind, run: provider.run });
  assert.equal(deltas.length, 6);
  assert.equal(result.board.tiles.length, 6);
});

// ---- 3. repair: exactly one round, re-prompts with zod issues verbatim ----

test("repairs an invalid tile with exactly ONE repair call carrying the zod issues", async () => {
  const initial = tilesBuffer([tile("Keep"), tile("Fix me", "nope-field")]);
  const repaired = tilesBuffer([tile("Fix me", "degree")]);
  const provider = scriptedProvider([initial, repaired]);
  const deltas: GenerativeTile[] = [];
  const result = await composeGenerativeStreaming(input, (t) => deltas.push(t), { bind: realBind, run: provider.run });
  assert.equal(provider.callCount(), 2, "exactly one repair call (two total)");
  assert.match(provider.prompts[1]!, /is not in dataset "cited"/);
  assert.match(provider.prompts[1]!, /Fix me/);
  assert.deepEqual(deltas.map((t) => t.title).sort(), ["Fix me", "Keep"].sort());
  assert.equal(result.board.tiles.length, 2);
  assert.equal(result.board.source, "llm");
});

test("a schema-valid but low-quality tile (bare count) is critic-gated into the repair round", async () => {
  // Passes zod (has a channel) but the deterministic critic flags it as low-info.
  const bad = { title: "Lonely count", dataset: "cited", mark: "bar", encoding: { y: { aggregate: "count" } } };
  const good = tile("Lonely count"); // x:kind + count → passes the critic
  const provider = scriptedProvider([tilesBuffer([bad]), tilesBuffer([good])]);
  const deltas: GenerativeTile[] = [];
  const result = await composeGenerativeStreaming(input, (t) => deltas.push(t), { bind: realBind, run: provider.run });
  assert.equal(provider.callCount(), 2, "the low-quality tile triggered exactly one repair round");
  assert.match(provider.prompts[1]!, /low-information/);
  assert.equal(deltas.length, 1, "only the repaired, good tile is emitted");
  assert.equal(result.board.tiles[0]!.title, "Lonely count");
  assert.ok((result.board.tiles[0]!.appropriateness ?? 0) >= 0.6, "emitted tile carries its appropriateness score");
});

test("no repair call when everything validates the first time", async () => {
  const provider = scriptedProvider([tilesBuffer([tile("Only one")])]);
  await composeGenerativeStreaming(input, () => {}, { bind: realBind, run: provider.run });
  assert.equal(provider.callCount(), 1);
});

test("no repair call when 6 valid tiles already exist, even if one failed", async () => {
  const six = Array.from({ length: 6 }, (_, i) => tile(`Ok${i}`));
  const buf = tilesBuffer([...six, tile("Bad", "nope-field")]);
  const provider = scriptedProvider([buf]);
  const result = await composeGenerativeStreaming(input, () => {}, { bind: realBind, run: provider.run });
  assert.equal(provider.callCount(), 1, "cap already hit -> no repair round attempted");
  assert.equal(result.board.tiles.length, 6);
});

test("repair round is appended and still capped at 6", async () => {
  const five = Array.from({ length: 5 }, (_, i) => tile(`Ok${i}`));
  const initial = tilesBuffer([...five, tile("Bad", "nope-field")]);
  // Repair returns 3 fixed tiles — only 1 more slot is free (5 valid so far, cap 6).
  const repaired = tilesBuffer([tile("Fix1", "degree"), tile("Fix2", "degree"), tile("Fix3", "degree")]);
  const provider = scriptedProvider([initial, repaired]);
  const result = await composeGenerativeStreaming(input, () => {}, { bind: realBind, run: provider.run });
  assert.equal(result.board.tiles.length, 6);
});

// ---- 4. fallback: template on exhaustion / throw / timeout -----------------

test("zero valid tiles after repair -> template board, source:template", async () => {
  const garbage = tilesBuffer([tile("Bad1", "nope"), tile("Bad2", "nope2")]);
  const provider = scriptedProvider([garbage, garbage]); // repair also fails
  const result = await composeGenerativeStreaming(input, () => {}, { bind: realBind, run: provider.run });
  assert.equal(result.board.source, "template");
  const { fieldMenu } = await realBind(citedNodeIds);
  assert.deepEqual(result.board, templateBoard(citedNodeIds, fieldMenu));
  assert.equal(provider.callCount(), 2, "one initial + one repair round, then gives up");
});

test("provider throw (synchronous) -> template, never throws to the caller", async () => {
  const run = async (): Promise<ClaudeCodeResult> => { throw new Error("boom"); };
  const result = await composeGenerativeStreaming(input, () => {}, { bind: realBind, run });
  assert.equal(result.board.source, "template");
});

test("provider rejected promise -> template, never throws to the caller", async () => {
  const run = (): Promise<ClaudeCodeResult> => Promise.reject(new Error("boom"));
  const result = await composeGenerativeStreaming(input, () => {}, { bind: realBind, run });
  assert.equal(result.board.source, "template");
});

test("provider that never resolves is aborted at the timeout -> template", async () => {
  const run = (opts: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> =>
    new Promise((resolve) => {
      opts.signal.addEventListener("abort", () => resolve({ ok: false, reason: "timeout" }));
    });
  const start = Date.now();
  const result = await composeGenerativeStreaming(input, () => {}, { bind: realBind, run, timeoutMs: 30 });
  assert.equal(result.board.source, "template");
  assert.ok(Date.now() - start < 2000, "did not wait for the default 30s timeout");
});

// ---- 5. grounding: bind called ONCE; empty field menu -> immediate template

test("bindDatasets (injected) is called exactly once, even across a repair round", async () => {
  let bindCalls = 0;
  const bind = async (ids: string[]) => { bindCalls++; return realBind(ids); };
  const initial = tilesBuffer([tile("Keep"), tile("Fix me", "nope-field")]);
  const repaired = tilesBuffer([tile("Fix me", "degree")]);
  const provider = scriptedProvider([initial, repaired]);
  await composeGenerativeStreaming(input, () => {}, { bind, run: provider.run });
  assert.equal(bindCalls, 1);
});

test("empty field menu -> immediate template path with empty tiles, LLM never called", async () => {
  let runCalls = 0;
  const run = async (): Promise<ClaudeCodeResult> => { runCalls++; return { ok: true }; };
  const result = await composeGenerativeStreaming(input, () => {}, { bind: emptyBind, run });
  assert.equal(result.board.source, "template");
  assert.deepEqual(result.board.tiles, []);
  assert.equal(runCalls, 0, "the LLM is never invoked when there is nothing to bind");
});
