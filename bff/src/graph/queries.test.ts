/**
 * parseAttrs numeric-coercion tests.
 *
 * Guards the fix for the blanket Number() bug: only an allow-list of genuinely
 * numeric attr keys (kept in step with DECIMAL_ATTRS in etl/rdf/generate.ts) is
 * coerced to a number; id-like values (code=0001, efo=1e3) must stay strings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAttrs } from "./queries.js";

test("parseAttrs coerces only allow-listed numeric keys", () => {
  const out = parseAttrs("prr=3.5;ror=2.1;chi2=12;cases=40;records=7;otScore=0.88")!;
  assert.equal(out.prr, 3.5);
  assert.equal(out.ror, 2.1);
  assert.equal(out.chi2, 12);
  assert.equal(out.cases, 40);
  assert.equal(out.records, 7);
  assert.equal(out.otScore, 0.88);
  for (const v of Object.values(out)) assert.equal(typeof v, "number");
});

test("parseAttrs keeps id-like values as strings (no Number() corruption)", () => {
  const out = parseAttrs("code=0001;efo=1e3;status=confirmed;vocab=MedDRA")!;
  // Previously code=0001 → 1 and efo=1e3 → 1000; both must stay verbatim strings.
  assert.equal(out.code, "0001");
  assert.equal(out.efo, "1e3");
  assert.equal(out.status, "confirmed");
  assert.equal(out.vocab, "MedDRA");
  for (const v of Object.values(out)) assert.equal(typeof v, "string");
});

test("parseAttrs handles empty / undefined / blank values", () => {
  assert.equal(parseAttrs(undefined), undefined);
  assert.equal(parseAttrs(""), undefined);
  // A blank value for a numeric key stays an empty string, not NaN/0.
  const out = parseAttrs("prr=;status=open")!;
  assert.equal(out.prr, "");
  assert.equal(out.status, "open");
});
