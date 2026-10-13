/**
 * The theme's accessibility claims, enforced mechanically.
 *
 * These started as a COMMENT asserting "WCAG 3:1 marks / 4.5:1 text in both themes" that
 * was never measured — and when measured, was false: four of Okabe-Ito's eight hues fail
 * 3:1 on white (yellow at 1.32:1). A comment cannot fail; this test can. If someone adds a
 * hue or lightens a token, the suite says so instead of the palette quietly going
 * unreadable in light mode.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { COLORBLIND_SCHEME, COLORBLIND_SCHEME_LIGHT, SEQUENTIAL_SCHEME, vegaConfig, schemeFor, resolveThemeMode } from "./vegaTheme.js";

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The surfaces each mode actually renders against (`--frame-surface`). */
const SURFACE = { dark: "#0d1117", light: "#ffffff" } as const;

/** WCAG 1.4.11 — non-text (a chart mark) needs 3:1 against its background. */
const MARK_MIN = 3;
/** WCAG 1.4.3 — text (axis/legend labels, titles) needs 4.5:1. */
const TEXT_MIN = 4.5;

for (const mode of ["dark", "light"] as const) {
  test(`every ${mode}-mode categorical colour clears WCAG 3:1 against the ${mode} surface`, () => {
    for (const colour of schemeFor(mode)) {
      const ratio = contrast(colour, SURFACE[mode]);
      assert.ok(
        ratio >= MARK_MIN,
        `${colour} is ${ratio.toFixed(2)}:1 on ${SURFACE[mode]} — below the ${MARK_MIN}:1 minimum for a chart mark`,
      );
    }
  });

  test(`${mode}-mode axis, legend and title text clears WCAG 4.5:1`, () => {
    const cfg = vegaConfig(mode) as {
      title: { color: string };
      axis: { labelColor: string; titleColor: string };
      legend: { labelColor: string };
    };
    for (const [what, colour] of [
      ["title", cfg.title.color],
      ["axis label", cfg.axis.labelColor],
      ["axis title", cfg.axis.titleColor],
      ["legend label", cfg.legend.labelColor],
    ] as const) {
      const ratio = contrast(colour, SURFACE[mode]);
      assert.ok(
        ratio >= TEXT_MIN,
        `${what} ${colour} is ${ratio.toFixed(2)}:1 on ${SURFACE[mode]} — below ${TEXT_MIN}:1`,
      );
    }
  });
}

test("the dark palette is Okabe-Ito, and the light palette keeps its hue ORDER (so colourblind separation survives darkening)", () => {
  assert.deepEqual(schemeFor("dark"), [...COLORBLIND_SCHEME]);
  assert.equal(COLORBLIND_SCHEME_LIGHT.length, COLORBLIND_SCHEME.length);
  // Every light hue is a DARKENED counterpart, never brighter than the Okabe-Ito original.
  COLORBLIND_SCHEME_LIGHT.forEach((light, i) => {
    assert.ok(
      luminance(light) <= luminance(COLORBLIND_SCHEME[i]) + 1e-9,
      `light[${i}] ${light} is brighter than Okabe-Ito ${COLORBLIND_SCHEME[i]} — it will fail on white`,
    );
  });
});

test("the config carries premium, host-owned mark styling in BOTH modes (the 'fancy' polish, enforced)", () => {
  for (const mode of ["dark", "light"] as const) {
    const cfg = vegaConfig(mode) as {
      bar: { cornerRadiusEnd: number };
      line: { interpolate: string; strokeWidth: number };
      area: { fillOpacity: number };
      arc: { innerRadius: number; stroke: string };
      range: { heatmap: unknown[] };
    };
    assert.ok(cfg.bar.cornerRadiusEnd > 0, `${mode}: bars must have rounded caps`);
    assert.equal(cfg.line.interpolate, "monotone", `${mode}: lines must be smoothed`);
    assert.ok(cfg.area.fillOpacity > 0 && cfg.area.fillOpacity < 1, `${mode}: area fills must be translucent`);
    assert.ok(cfg.arc.innerRadius > 0, `${mode}: arcs must render as donuts`);
    assert.ok(Array.isArray(cfg.range.heatmap) && cfg.range.heatmap.length >= 4, `${mode}: heatmaps need a multi-stop gradient`);
  }
});

test("arc slices are stroked with the mode's OWN surface colour so donut wedges separate", () => {
  assert.equal((vegaConfig("dark") as { arc: { stroke: string } }).arc.stroke, "#0d1117");
  assert.equal((vegaConfig("light") as { arc: { stroke: string } }).arc.stroke, "#ffffff");
});

test("the sequential heatmap ramp is a distinct, ordered gradient (not the categorical palette)", () => {
  assert.ok(SEQUENTIAL_SCHEME.length >= 4);
  // It must not simply reuse the categorical scheme's first colours.
  assert.notDeepEqual([...SEQUENTIAL_SCHEME].slice(0, 3), schemeFor("dark").slice(0, 3));
});

test("resolveThemeMode MEASURES the painted surface, walking past transparent ancestors", () => {
  // A minimal Element/getComputedStyle stand-in: a tile sits in a transparent wrapper inside an
  // opaque surface — exactly the arrangement that fooled the earlier prop-based guesses.
  const make = (bg: string, parent: any = null): any => ({ backgroundColor: bg, parentElement: parent });
  const g = globalThis as { getComputedStyle?: unknown };
  const original = g.getComputedStyle;
  g.getComputedStyle = ((el: { backgroundColor: string }) => ({ backgroundColor: el.backgroundColor })) as never;
  try {
    const whiteSurface = make("rgb(255, 255, 255)");
    const transparentWrapper = make("rgba(0, 0, 0, 0)", whiteSurface);
    // The dark "warroom" skin still paints the tile on white — the tile must read LIGHT.
    assert.equal(resolveThemeMode(transparentWrapper), "light");

    const darkSurface = make("rgb(13, 17, 23)");
    assert.equal(resolveThemeMode(make("rgba(0, 0, 0, 0)", darkSurface)), "dark");

    // No opaque ancestor at all → fail safe to dark rather than guessing light.
    assert.equal(resolveThemeMode(make("rgba(0, 0, 0, 0)")), "dark");
    assert.equal(resolveThemeMode(null), "dark");
  } finally {
    g.getComputedStyle = original;
  }
});
