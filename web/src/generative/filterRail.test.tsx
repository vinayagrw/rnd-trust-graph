/**
 * Render tests for the Generative Studio's FilterRail (T11).
 *
 * `renderToStaticMarkup` runs the component WITHOUT effects — so the rail's
 * initial markup must reflect `getControls()` read at CALL TIME (via the
 * useState initializer), not via the subscribe effect. The tests assert the
 * host-supplied options/domain render, that an empty filter list renders
 * nothing, and that the active-chip / Clear-all affordances read the store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { FilterControl } from "@rnd/shared";
import { FilterRail } from "./FilterRail.js";
import { setControl, clearControls } from "./filterControls.js";

const DROPDOWN: FilterControl = {
  field: "kind",
  dataset: "cited",
  kind: "dropdown",
  vlType: "nominal",
  label: "Node kind",
  options: ["Drug", "AdverseEvent", "Stat"],
};

const RANGE: FilterControl = {
  field: "prr",
  dataset: "cited",
  kind: "range",
  vlType: "quantitative",
  label: "PRR",
  domain: [0, 10],
};

test("empty filters → renders nothing (null)", () => {
  const html = renderToStaticMarkup(<FilterRail filters={[]} />);
  assert.equal(html, "");
});

test("a dropdown control renders its host-supplied options + the field/kind caption", () => {
  clearControls();
  const html = renderToStaticMarkup(<FilterRail filters={[DROPDOWN]} />);
  assert.match(html, /data-testid="generative-filter-rail"/);
  assert.match(html, /Drug/);
  assert.match(html, /AdverseEvent/);
  assert.match(html, /Stat/);
  // The small caption is "${field} · ${cardinalityHint} → ${kind}".
  assert.match(html, /kind/);
  assert.match(html, /dropdown/);
});

test("a range control renders two numeric inputs bounded by its domain", () => {
  clearControls();
  const html = renderToStaticMarkup(<FilterRail filters={[RANGE]} />);
  assert.match(html, /type="number"/);
  assert.match(html, /min="0"/);
  assert.match(html, /max="10"/);
  assert.match(html, /range/);
});

test("the rail shows active chips + a Clear all when the store already holds a control", () => {
  clearControls();
  setControl("kind", { type: "set", values: ["Drug"] });
  const html = renderToStaticMarkup(<FilterRail filters={[DROPDOWN]} />);
  // The active field is chipped (initial render reads getControls() at call time).
  assert.match(html, /Clear all/);
  clearControls();
});

test("with no active controls there is no Clear all", () => {
  clearControls();
  const html = renderToStaticMarkup(<FilterRail filters={[DROPDOWN]} />);
  assert.doesNotMatch(html, /Clear all/);
});

test("a search control renders a text input", () => {
  clearControls();
  const search: FilterControl = {
    field: "label",
    dataset: "cited",
    kind: "search",
    vlType: "nominal",
    label: "Label",
  };
  const html = renderToStaticMarkup(<FilterRail filters={[search]} />);
  assert.match(html, /type="(text|search)"/);
  assert.match(html, /search/);
});
