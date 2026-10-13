/**
 * Cron matcher unit tests — pins the tiny 5-field engine the scheduler relies on.
 * Pure arithmetic over Date (local time), so these are deterministic with fixed
 * dates. Covers: presets, wildcard/step/range/list, the Vixie dom/dow OR rule,
 * malformed-expression rejection, and nextRun look-ahead.
 *
 * Run: `node --import tsx --test src/playbooks/cron.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextRun, cadenceToCron, isValidCron } from "./cron.js";

/** Local-time Date builder (month is 1-based here for readability). */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

test("daily preset matches only at 09:00", () => {
  const c = parseCron(cadenceToCron("daily"));
  assert.equal(cronMatches(c, at(2026, 6, 30, 9, 0)), true);
  assert.equal(cronMatches(c, at(2026, 6, 30, 9, 1)), false);
  assert.equal(cronMatches(c, at(2026, 6, 30, 10, 0)), false);
});

test("hourly preset matches at the top of every hour", () => {
  const c = parseCron(cadenceToCron("hourly"));
  assert.equal(cronMatches(c, at(2026, 6, 30, 0, 0)), true);
  assert.equal(cronMatches(c, at(2026, 6, 30, 13, 0)), true);
  assert.equal(cronMatches(c, at(2026, 6, 30, 13, 30)), false);
});

test("weekly preset matches Mondays at 09:00 (dow rule)", () => {
  const c = parseCron(cadenceToCron("weekly")); // 0 9 * * 1
  for (const day of [28, 29, 30]) {
    const d = at(2026, 6, day, 9, 0);
    assert.equal(cronMatches(c, d), d.getDay() === 1, `day ${day} getDay=${d.getDay()}`);
  }
});

test("step, range, and list fields", () => {
  const step = parseCron("*/15 * * * *");
  assert.equal(cronMatches(step, at(2026, 6, 30, 8, 15)), true);
  assert.equal(cronMatches(step, at(2026, 6, 30, 8, 20)), false);

  const range = parseCron("0 9-17 * * *");
  assert.equal(cronMatches(range, at(2026, 6, 30, 12, 0)), true);
  assert.equal(cronMatches(range, at(2026, 6, 30, 8, 0)), false);

  const list = parseCron("0 0 * * 1,3,5");
  const wed = at(2026, 7, 1, 0, 0); // 2026-07-01
  assert.equal(cronMatches(list, wed), [1, 3, 5].includes(wed.getDay()));
});

test("Vixie dom/dow OR rule: both restricted → match on EITHER", () => {
  const c = parseCron("0 9 1 * 1"); // 1st of month OR Monday, at 09:00
  for (const day of [1, 6, 8]) {
    const d = at(2026, 6, day, 9, 0);
    const expected = d.getDate() === 1 || d.getDay() === 1;
    assert.equal(cronMatches(c, d), expected, `day ${day}`);
  }
});

test("malformed expressions are rejected", () => {
  assert.throws(() => parseCron("0 9 * *")); // 4 fields
  assert.throws(() => parseCron("60 * * * *")); // minute out of range
  assert.throws(() => parseCron("* 24 * * *")); // hour out of range
  assert.throws(() => parseCron("0 9 * * 8")); // dow out of range (0-7)
  assert.equal(isValidCron("0 9 * * 1-5"), true);
  assert.equal(isValidCron("nonsense"), false);
});

test("nextRun finds the next matching minute", () => {
  const from = at(2026, 6, 30, 10, 0); // after today's 09:00
  const next = nextRun(cadenceToCron("daily"), from);
  assert.ok(next, "a next run exists");
  const d = new Date(next!);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 1); // rolls to next day (2026-07-01)

  // Strictly after `from`: the very next minute is returned for a wildcard-minute.
  const soon = nextRun("* * * * *", from);
  assert.equal(soon, at(2026, 6, 30, 10, 1).getTime());
});

test("nextRun returns null for an impossible schedule within horizon", () => {
  // Feb 30 never occurs.
  assert.equal(nextRun("0 0 30 2 *", at(2026, 1, 1, 0, 0)), null);
});
