/**
 * F5 — playbook runner assembles a dossier: ask steps stream a grounded result,
 * the checkpoint step enqueues a (non-blocking) HITL item, and the run ends with a
 * `done` carrying the assembled dossier. Integration-flavoured (drives the real
 * agent), so it is gated on a reachable Neo4j; the scratch HITL queue is per-pid
 * isolated via test-setup.ts.
 *
 * Run: node --import tsx --import ./test-setup.ts --test src/playbooks/runner.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { DossierResult, PlaybookStepKind } from "@rnd/shared";
import { healthcheck, closeDriver } from "../neo4j.js";
import { listPlaybooks, getPlaybook } from "./definitions.js";
import { runPlaybook } from "./runner.js";

let neo4jUp = false;
before(async () => {
  neo4jUp = await healthcheck();
});
after(async () => {
  await closeDriver();
});

test("a playbook is defined with ask + checkpoint + synth steps", () => {
  const pb = listPlaybooks()[0];
  assert.ok(pb, "at least one playbook");
  const kinds = new Set(pb.steps.map((s) => s.kind as PlaybookStepKind));
  assert.ok(kinds.has("ask"));
  assert.ok(kinds.has("checkpoint"));
  assert.ok(kinds.has("synth"));
  assert.ok(getPlaybook(pb.id));
});

test("runPlaybook streams step results and a final dossier with a pending checkpoint", { timeout: 180000 }, async (t) => {
  if (!neo4jUp) {
    t.skip("Neo4j not reachable");
    return;
  }
  const pb = listPlaybooks()[0];
  const events: { type: string; [k: string]: unknown }[] = [];
  await runPlaybook(pb.id, (e) => events.push(e));

  const started = events.filter((e) => e.type === "step-started");
  const resultEvents = events.filter((e) => e.type === "step-result");
  const doneEvent = events.find((e) => e.type === "done") as
    | { type: "done"; dossier: DossierResult }
    | undefined;

  // Every step started and produced a result.
  assert.equal(started.length, pb.steps.length);
  assert.equal(resultEvents.length, pb.steps.length);
  assert.ok(doneEvent?.dossier, "a dossier was assembled");
  assert.equal(doneEvent!.dossier.steps.length, pb.steps.length);

  // The checkpoint step enqueued a pending HITL item (non-blocking review).
  const checkpoint = doneEvent!.dossier.steps.find((s) => s.kind === "checkpoint");
  assert.ok(checkpoint?.pendingItemId, "checkpoint enqueued a pending item id");

  // At least one ask step carried a grounded answer (faithfulness may be present
  // when the live agent answered; in offline fallback it is absent but the answer
  // text still streams — so we assert on the answer, not the score).
  const ask = doneEvent!.dossier.steps.find((s) => s.kind === "ask");
  assert.ok(ask, "an ask step result is present");
  assert.ok(typeof ask!.answer === "string" && ask!.answer.length > 0, "ask step has answer text");
});
