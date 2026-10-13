/**
 * T7 wiring test — drives the AG-UI bridge's sink translation directly with a
 * SCRIPTED event sequence (mirrors `bff/src/dashboards/streaming.test.ts`'s
 * harness: no Neo4j, no real CLI). `aguiBridge`'s third parameter is a
 * test-only DI seam (`askGraphImpl`, defaults to the real `askGraph`) — the
 * fakes below stand in for a live agent run and sink exactly the events a
 * real grounded/refusal run would produce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { StreamEvent, GenerativeTile } from "@rnd/shared";
import { aguiBridge } from "../ask/aguiBridge.js";
import type { askGraph } from "../ask/agent.js";

type AskGraphFn = typeof askGraph;

// --- StreamEvent shape sanity (mirrors streaming.test.ts's first test) -----

test("generative-delta / generative are valid StreamEvents", () => {
  const delta: StreamEvent = {
    type: "generative-delta",
    tile: { id: "t", title: "T", vlSkeleton: { mark: "bar" }, dataset: "cited" },
  };
  assert.equal(delta.type, "generative-delta");
  const final: StreamEvent = {
    type: "generative",
    board: { version: 1, tiles: [], citedNodeIds: [], source: "template" },
    datasets: { cited: [], metrics: [], edges: [] },
    fieldMenu: [],
  };
  assert.equal(final.type, "generative");
});

// --- Fake FastifyRequest/FastifyReply harness -------------------------------

function fakeRunAgentReq(question: string, compose?: string): FastifyRequest {
  return {
    query: compose === undefined ? {} : { compose },
    body: { threadId: "t1", runId: "r1", messages: [{ role: "user", content: question }] },
  } as unknown as FastifyRequest;
}

/** Captures every `ch.send(event)` write as one parsed JSON object (the bridge
 *  writes exactly one `data: {...}\n\n` frame per event, so no line-splitting
 *  is needed). */
function fakeReply(): { reply: FastifyReply; events: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const reply = {
    hijack: () => {},
    raw: {
      writeHead: (_status: number, _headers: Record<string, string>) => {},
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      end: () => {},
    },
  } as unknown as FastifyReply;
  const events = () => chunks.map((c) => JSON.parse(c.replace(/^data: /, "").trim()));
  return { reply, events };
}

const tile1: GenerativeTile = { id: "t1", title: "Tile 1", vlSkeleton: { mark: "bar" }, dataset: "cited" };
const tile2: GenerativeTile = { id: "t2", title: "Tile 2", vlSkeleton: { mark: "point" }, dataset: "cited" };
const datasets = { cited: [{ id: "AE-MYOCARDITIS", label: "Myocarditis" }], edges: [] };
const fieldMenu = [{ name: "label", vlType: "nominal" as const, cardinality: 1 }];

/** Scripts a grounded run that composes generatively — sinks exactly what
 *  agent.ts's `emitGenerative` would (citations, two deltas carrying the
 *  already-bound datasets/fieldMenu, then the final board). */
const groundedGenerativeRun: AskGraphFn = async (_question, sink) => {
  sink({ type: "citations", nodeIds: ["AE-MYOCARDITIS"] });
  sink({ type: "token", text: "Elevated signal, grounded in the cited evidence." });
  sink({ type: "generative-delta", tile: tile1, datasets, fieldMenu });
  sink({ type: "generative-delta", tile: tile2, datasets, fieldMenu });
  sink({
    type: "generative",
    board: { version: 1, tiles: [tile1, tile2], citedNodeIds: ["AE-MYOCARDITIS"], source: "llm" },
    datasets,
    fieldMenu,
  });
  sink({ type: "done", isFallback: false });
};

/** Scripts a refusal — the answer carries the NOT_IN_GRAPH marker, so the
 *  bridge's grounded gate is false and no render_generative may be emitted,
 *  no matter what (a real agent.ts run never even calls emitGenerative here;
 *  this fake proves the BRIDGE's own gate holds independently). */
const refusalRun: AskGraphFn = async (_question, sink) => {
  sink({ type: "token", text: "NOT_IN_GRAPH: no evidence in the graph for that." });
  sink({ type: "done", isFallback: false });
};

test("generative run: one render_generative TOOL_CALL per delta + a final with final:true sharing one runId", async () => {
  const { reply, events } = fakeReply();
  await aguiBridge(fakeRunAgentReq("why myocarditis?", "generative"), reply, groundedGenerativeRun);
  const evs = events();

  const starts = evs.filter((e) => e.type === "TOOL_CALL_START" && e.toolCallName === "render_generative");
  assert.equal(starts.length, 3, "2 deltas + 1 final");
  const ids = new Set(starts.map((s) => s.toolCallId));

  const ends = evs.filter((e) => e.type === "TOOL_CALL_END" && ids.has(e.toolCallId as string));
  assert.equal(ends.length, 3);

  const args = evs
    .filter((e) => e.type === "TOOL_CALL_ARGS" && ids.has(e.toolCallId as string))
    .map((e) => JSON.parse(e.delta as string));
  assert.equal(args.length, 3);

  const runIds = new Set(args.map((a) => a.runId));
  assert.equal(runIds.size, 1, "one shared runId across every delta + the final");
  assert.ok(runIds.values().next().value, "runId is non-empty");

  const deltaArgs = args.filter((a) => a.final !== true);
  const finalArgs = args.filter((a) => a.final === true);
  assert.equal(deltaArgs.length, 2);
  assert.equal(finalArgs.length, 1);

  // Deltas carry the tile + the already-bound datasets/fieldMenu (a tile needs
  // its rows to render), never a board.
  for (const a of deltaArgs) {
    assert.ok(a.tile, "delta args carry a tile");
    assert.deepEqual(a.datasets, datasets);
    assert.deepEqual(a.fieldMenu, fieldMenu);
    assert.equal(a.board, undefined);
  }
  // The final carries the full board + datasets/fieldMenu, never a bare tile.
  assert.equal(finalArgs[0].tile, undefined);
  assert.equal((finalArgs[0].board as { tiles: unknown[] }).tiles.length, 2);
  assert.deepEqual(finalArgs[0].datasets, datasets);
  assert.deepEqual(finalArgs[0].fieldMenu, fieldMenu);

  // A TOOL_CALL_RESULT closes out the final tool call (mirrors render_dashboard).
  const results = evs.filter((e) => e.type === "TOOL_CALL_RESULT" && ids.has(e.toolCallId as string));
  assert.equal(results.length, 1);
});

test("refusal run emits NO render_generative tool call — in generative AND board mode", async () => {
  for (const mode of ["generative", "board"]) {
    const { reply, events } = fakeReply();
    await aguiBridge(fakeRunAgentReq("something not in the graph", mode), reply, refusalRun);
    const rg = events().filter((e) => e.type === "TOOL_CALL_START" && e.toolCallName === "render_generative");
    assert.equal(rg.length, 0, `${mode} mode still draws nothing on a refusal`);
  }
});

test("compose routing: generative → {generative:true, orchestrated:false}; board → both true; else both false", async () => {
  let captured: { generative?: boolean; orchestrated?: boolean } | undefined;
  const capture: AskGraphFn = async (_question, sink, _surface, options) => {
    captured = options;
    sink({ type: "token", text: "ok" });
    sink({ type: "done", isFallback: false });
  };
  const drive = async (compose?: string) => {
    const a = fakeReply();
    await aguiBridge(fakeRunAgentReq("q", compose), a.reply, capture);
    return captured;
  };

  const gen = await drive("generative");
  assert.equal(gen?.generative, true);
  assert.equal(Boolean(gen?.orchestrated), false, "single-pass fast path");

  const board = await drive("board");
  assert.equal(board?.generative, true);
  assert.equal(board?.orchestrated, true, "board mode runs the orchestrator");

  const none = await drive(undefined);
  assert.equal(Boolean(none?.generative), false);
  assert.equal(Boolean(none?.orchestrated), false);

  const dash = await drive("dashboard");
  assert.equal(Boolean(dash?.generative), false);
  assert.equal(Boolean(dash?.orchestrated), false);
});
