/**
 * Eval scorecard (F2) ledger tests — record + summary rollup.
 *
 * Each test process gets its OWN scratch ledger (keyed by pid) so concurrent
 * `node --test` workers never share/clobber the real file — mirrors the FinOps
 * ledger test isolation. The env is set BEFORE the module is imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const LEDGER = join(tmpdir(), `rtg-eval-ledger-test-${process.pid}.json`);
process.env.EVAL_LEDGER_PATH = LEDGER;
rmSync(LEDGER, { force: true });
process.on("exit", () => {
  try {
    rmSync(LEDGER, { force: true });
  } catch {
    /* best-effort */
  }
});

const { recordEval, summarizeEval, invalidateEvalCache } = await import("./scorecard.js");

test("recordEval + summarizeEval: averages, null relevancy when judge off", () => {
  invalidateEvalCache();
  rmSync(LEDGER, { force: true });
  invalidateEvalCache();

  recordEval({ surface: "runtime", question: "q1", faithfulness: 1.0, contextRecall: 0.5, answerRelevancy: null, citedCount: 3 });
  recordEval({ surface: "ask", question: "q2", faithfulness: 0.5, contextRecall: 1.0, answerRelevancy: null, citedCount: 2 });

  const s = summarizeEval();
  assert.equal(s.entryCount, 2);
  assert.equal(s.avgFaithfulness, 0.75); // (1.0 + 0.5) / 2
  assert.equal(s.avgContextRecall, 0.75); // (0.5 + 1.0) / 2
  assert.equal(s.avgAnswerRelevancy, null); // no judged entries
  assert.equal(s.recent.length, 2);
  assert.equal(s.recent[0].question, "q2"); // newest-first
});

test("avgAnswerRelevancy averages only judged entries", () => {
  invalidateEvalCache();
  rmSync(LEDGER, { force: true });
  invalidateEvalCache();

  recordEval({ surface: "ask", question: "j1", faithfulness: 1, contextRecall: 1, answerRelevancy: 0.8, citedCount: 1 });
  recordEval({ surface: "ask", question: "j2", faithfulness: 1, contextRecall: 1, answerRelevancy: null, citedCount: 1 });
  recordEval({ surface: "ask", question: "j3", faithfulness: 1, contextRecall: 1, answerRelevancy: 0.6, citedCount: 1 });

  const s = summarizeEval();
  assert.equal(s.avgAnswerRelevancy, 0.7); // (0.8 + 0.6) / 2, the null is excluded
});

test("scores are clamped to 0..1 and question is truncated", () => {
  invalidateEvalCache();
  rmSync(LEDGER, { force: true });
  invalidateEvalCache();

  const long = "x".repeat(500);
  recordEval({ surface: "ask", question: long, faithfulness: 1.7, contextRecall: -0.2, answerRelevancy: null, citedCount: 1 });
  const s = summarizeEval();
  assert.equal(s.recent[0].faithfulness, 1); // clamped high
  assert.equal(s.recent[0].contextRecall, 0); // clamped low
  assert.ok(s.recent[0].question.length <= 160);
});

test("record persists across a cache invalidation (file-backed)", () => {
  invalidateEvalCache();
  const before = summarizeEval().entryCount;
  recordEval({ surface: "ask", question: "persist", faithfulness: 1, contextRecall: 1, answerRelevancy: null, citedCount: 1 });
  invalidateEvalCache(); // force a re-read from disk
  assert.equal(summarizeEval().entryCount, before + 1);
});
