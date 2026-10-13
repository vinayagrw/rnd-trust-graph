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
