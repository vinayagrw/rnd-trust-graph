/**
 * Composer assembly — the grounding guarantees, tested LLM-free.
 *
 * `composeFromModelText` is the pure parse→inject-grounding-root→filter→validate
 * path. These tests prove the model can never widen grounding, that garbage output
 * degrades to the deterministic template, and that structurally-inert output stays
 * inert — without spawning the CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "@rnd/shared";
import { composeFromModelText, type ComposeInput } from "./composer.js";

const input: ComposeInput = {
  question: "why myocarditis?",
  answerText: "The signal for myocarditis is supported by disproportionality metrics.",
  citedNodes: [
    { id: "AE-MYOCARDITIS", kind: "AdverseEvent" as GraphNode["kind"], label: "Myocarditis" },
    { id: "STAT-1", kind: "SignalStat" as GraphNode["kind"], label: "Disproportionality" },
  ],
};

test("injects the real cited set as the grounding root (model cannot set it)", () => {
  const raw = JSON.stringify({
    title: "Signal",
    citedNodeIds: ["FAKE-1", "FAKE-2"], // model tries to set grounding — must be ignored
    widgets: [{ id: "a", kind: "citation-chips" }],
  });
  const spec = composeFromModelText(raw, input);
  assert.deepEqual(spec.citedNodeIds, ["AE-MYOCARDITIS", "STAT-1"]);
  assert.equal(spec.source, "llm");
});

test("drops widget node ids that were not cited (grounding filter)", () => {
  const raw = JSON.stringify({
    widgets: [{ id: "chips", kind: "citation-chips", nodeIds: ["AE-MYOCARDITIS", "AE-NOT-CITED"] }],
  });
  const spec = composeFromModelText(raw, input);
  const chips = spec.widgets.find((w) => w.id === "chips");
  assert.deepEqual(chips?.nodeIds, ["AE-MYOCARDITIS"]);
});

test("falls back to the template on unparseable output", () => {
  const spec = composeFromModelText("not json at all", input);
  assert.equal(spec.source, "template");
  assert.ok(spec.widgets.length > 0);
});

test("falls back to the template when no valid widgets survive", () => {
  const raw = JSON.stringify({ widgets: [{ id: "x", kind: "iframe" }, { id: "y", kind: "metric" }] });
  // "iframe" is unknown; the metric tile has no metric → both dropped → template.
  const spec = composeFromModelText(raw, input);
  assert.equal(spec.source, "template");
});

test("ignores smuggled extra fields on a widget (inertness)", () => {
  const raw = JSON.stringify({
    widgets: [{ id: "chips", kind: "citation-chips", value: "999", imageUrl: "http://evil/x.png" }],
  });
  const spec = composeFromModelText(raw, input);
  const chips = spec.widgets.find((w) => w.id === "chips");
  assert.ok(chips, "widget kept");
  assert.ok(!("value" in (chips as object)), "no smuggled value field");
  assert.ok(!("imageUrl" in (chips as object)), "no smuggled url field");
});

test("tolerates ``` fences around the JSON", () => {
  const raw = "```json\n" + JSON.stringify({ widgets: [{ id: "c", kind: "citation-chips" }] }) + "\n```";
  const spec = composeFromModelText(raw, input);
  assert.equal(spec.source, "llm");
  assert.ok(spec.widgets.some((w) => w.kind === "citation-chips"));
});
