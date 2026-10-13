/**
 * FinOps ledger unit tests — cost calc + record/summary rollup.
 *
 * Each test process gets its OWN scratch ledger file (keyed by pid) so concurrent
 * `node --test` workers + a live dev server never share/clobber the real file —
 * mirrors the admin-config isolation in test-setup.ts. The env is set BEFORE the
 * ledger module is imported (dynamic import below) so it reads the scratch path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const LEDGER = join(tmpdir(), `rtg-finops-ledger-${process.pid}.json`);
process.env.FINOPS_LEDGER_PATH = LEDGER;
rmSync(LEDGER, { force: true });
process.on("exit", () => {
  try {
    rmSync(LEDGER, { force: true });
  } catch {
    /* best-effort */
  }
});

const { computeCost, estimateTokens, record, summarize, invalidateLedgerCache } =
  await import("./ledger.js");

test("computeCost: USD = tokens/1e6 * perMTok, summed input+output", () => {
  const price = { inputPerMTok: 5, outputPerMTok: 25 };
  // 1,000,000 input @ $5 + 200,000 output @ $25 = 5 + 5 = $10
  assert.equal(computeCost(1_000_000, 200_000, price), 10);
  // zero tokens → zero cost
  assert.equal(computeCost(0, 0, price), 0);
  // rounds to 6dp, no float noise
  assert.equal(computeCost(1, 1, { inputPerMTok: 1, outputPerMTok: 1 }), 0.000002);
});

test("estimateTokens: ~4 chars/token, never negative", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2); // ceil(5/4)
  assert.equal(estimateTokens(undefined as unknown as string), 0);
});

test("record + summarize: totals, per-surface/per-model rollup, budget flags", () => {
  invalidateLedgerCache();
  rmSync(LEDGER, { force: true });
  invalidateLedgerCache();

  record({ surface: "narrate", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500 });
  record({ surface: "ask", model: "claude-opus-4-8", inputTokens: 2000, outputTokens: 1000 });
  record({
    surface: "ask",
    model: "claude-haiku-4-5-20251001",
    inputTokens: 4000,
    outputTokens: 2000,
    estimated: true,
  });

  const s = summarize();
  assert.equal(s.entryCount, 3);
  assert.equal(s.totalInputTokens, 7000);
  assert.equal(s.totalOutputTokens, 3500);
  assert.equal(s.totalTokens, 10_500);

  // per-surface: "ask" has two entries, "narrate" one
  const ask = s.bySurface.find((r) => r.key === "ask");
  const narrate = s.bySurface.find((r) => r.key === "narrate");
  assert.ok(ask && narrate);
  assert.equal(ask!.count, 2);
  assert.equal(narrate!.count, 1);

  // per-model: two distinct models recorded
  assert.equal(s.byModel.length, 2);

  // budget block is well-formed and consistent
  assert.ok(s.budget.budgetUsd >= 0);
  assert.equal(typeof s.budget.pctUsed, "number");
  assert.equal(s.budget.overThreshold, s.budget.pctUsed >= s.budget.warnThresholdPct);
  assert.ok(s.totalCostUsd > 0); // opus entries carry a non-zero cost
});

test("record persists across a cache invalidation (file-backed)", () => {
  invalidateLedgerCache();
  const before = summarize().entryCount;
  record({ surface: "narrate", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 10 });
  invalidateLedgerCache(); // forces a re-read from disk
  assert.equal(summarize().entryCount, before + 1);
});
