/**
 * @rnd/web — the Generative Studio's chart theme.
 *
 * WHY THIS IS CLIENT-SIDE: `config` is the one part of a Vega-Lite spec the
 * trusted compiler (`bff/src/generative/schema.ts`) deliberately CANNOT emit —
 * the IR grammar has no `config` key, so a model can never restyle a chart, hide
 * an axis, or smuggle a URL through a theme. The host therefore owns the theme
 * outright and merges it in at render time (`prepareSpec`). Nothing here is
 * model-derived.
 *
 * The categorical scheme is Okabe-Ito, the standard 8-colour palette designed to
 * stay distinguishable under deuteranopia, protanopia and tritanopia. Colour is
 * never the only carrier of meaning in this lane — the tile's trust state uses a
 * glyph + border style (WCAG 1.4.1), not a hue.
 */

export type ThemeMode = "light" | "dark";

/** Okabe-Ito — colourblind-safe categorical palette (Wong, Nature Methods 2011).
 *  Used as-is on the DARK surface, where all eight clear 3:1 against `#0d1117`. */
export const COLORBLIND_SCHEME = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#D55E00", // vermillion
  "#F0E442", // yellow
  "#999999", // grey
] as const;

/** The SAME eight hues, darkened for the LIGHT surface.
 *
 *  Okabe-Ito is designed for colour-vision deficiency, NOT for contrast against white —
 *  measured against `#ffffff`, four of the eight fail WCAG's 3:1 non-text minimum
 *  (orange 2.25:1, sky 2.31:1, grey 2.85:1, and yellow at 1.32:1, which is effectively
 *  invisible). Shipping one palette for both surfaces would have made light mode
 *  unreadable, so each hue is darkened until it clears 3:1 while keeping its position —
 *  and therefore its colourblind separation — in the sequence. Measured range on white:
 *  4.53:1 – 6.69:1. */
export const COLORBLIND_SCHEME_LIGHT = [
  "#0072B2", // blue        5.19:1
  "#B26200", // orange      4.53:1
  "#007A59", // bluish green 5.35:1
  "#A65683", // reddish purple 4.91:1
  "#1A6E99", // sky blue    5.62:1
  "#B34D00", // vermillion  5.28:1
  "#8A7500", // yellow→olive 4.54:1
  "#5C5C5C", // grey        6.69:1
] as const;

/** Sequential ramp for continuous colour (heatmaps, quantitative colour scales). Viridis —
 *  perceptually uniform AND colourblind-safe (the standard choice for exactly this), so a
 *  `rect` heatmap or a quantitative `color` encoding reads as a smooth premium gradient
 *  instead of Vega's default washed-out blues. Host-owned like everything else here. */
export const SEQUENTIAL_SCHEME = [
  "#440154",
  "#414487",
  "#2a788e",
  "#22a884",
  "#7ad151",
  "#fde725",
] as const;

interface ModeTokens {
  text: string;
  muted: string;
  grid: string;
  domain: string;
  /** The opaque surface the tile paints on — used to stroke arc/donut slices apart. */
  surface: string;
}

/** MEASURED against each mode's surface (dark `#0d1117`, light `#ffffff`): title text
 *  16.0:1 / 15.8:1 and axis+legend labels 7.7:1 / 6.4:1, all well past WCAG's 4.5:1 for
 *  text. Marks clear the 3:1 non-text minimum in both modes (see the two palettes above). */
const TOKENS: Record<ThemeMode, ModeTokens> = {
  dark: { text: "#e6edf3", muted: "#9aa7b4", grid: "rgba(230,237,243,0.12)", domain: "rgba(230,237,243,0.35)", surface: "#0d1117" },
  light: { text: "#1f2328", muted: "#57606a", grid: "rgba(31,35,40,0.10)", domain: "rgba(31,35,40,0.35)", surface: "#ffffff" },
};

/** The categorical scheme for a mode — colourblind-safe AND contrast-safe on that surface. */
export function schemeFor(mode: ThemeMode): string[] {
  return [...(mode === "light" ? COLORBLIND_SCHEME_LIGHT : COLORBLIND_SCHEME)];
}

/** WCAG relative luminance of an `rgb()`/`rgba()` string; null if it isn't one. */
function relativeLuminance(css: string): number | null {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(",").map((v) => parseFloat(v.trim()));
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (!Number.isFinite(r) || alpha < 0.1) return null; // transparent — keep walking up
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/**
 * Pick the theme from the surface the chart is ACTUALLY painted on, by walking up to the
 * first ancestor with an opaque background and measuring its luminance.
 *
 * Why measured, not inferred: this was first wired to a `lightCanvas` prop, then to the app's
 * `skin` — both were wrong. The dark "warroom" skin colours the CHROME while still drawing the
 * tile canvas on white, so a skin-derived theme put the dark palette on a white background and
 * Okabe-Ito's yellow rendered at 1.32:1 — a bar you cannot see. Any proxy for "is the surface
 * dark" can drift from the surface itself; the surface cannot.
 */
export function resolveThemeMode(el: Element | null): ThemeMode {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const lum = relativeLuminance(getComputedStyle(node).backgroundColor);
    if (lum !== null) return lum > 0.5 ? "light" : "dark";
  }
  return "dark";
}

/** The Vega-Lite `config` block the host applies to every generative tile. */
export function vegaConfig(mode: ThemeMode): Record<string, unknown> {
  const t = TOKENS[mode];
  const scheme = schemeFor(mode);
  return {
    background: "transparent",
    font: "inherit",
    title: { color: t.text, fontSize: 12, fontWeight: 600, anchor: "start" },
    axis: {
      labelColor: t.muted,
      titleColor: t.muted,
      labelFontSize: 10,
      titleFontSize: 10,
      gridColor: t.grid,
      domainColor: t.domain,
      tickColor: t.domain,
    },
    legend: { labelColor: t.muted, titleColor: t.muted, labelFontSize: 10, titleFontSize: 10, symbolType: "circle", symbolSize: 60 },
    view: { stroke: "transparent" },
    // `category` for nominal series; `heatmap`/`ramp` give continuous colour a premium
    // perceptually-uniform gradient instead of Vega's default two-stop blues.
    range: { category: scheme, heatmap: [...SEQUENTIAL_SCHEME], ramp: [...SEQUENTIAL_SCHEME] },
    // Single-series marks get the first scheme colour rather than Vega's default blue.
    mark: { color: scheme[0], tooltip: true },
    // --- Premium per-mark styling (host-owned config; the model never touches this) ---
    // Rounded bar caps, smooth monotone lines with points, translucent area fills, donut
    // arcs stroked apart on the surface colour, softened heatmap cells. Every value here is
    // a Vega-Lite mark-config key — no data, no URL, no expr — so the trust seam is intact.
    bar: { cornerRadiusEnd: 3, cornerRadiusTopLeft: 3, cornerRadiusTopRight: 3 },
    line: { strokeWidth: 2.5, interpolate: "monotone", point: { filled: true, size: 40 } },
    area: { fillOpacity: 0.28, interpolate: "monotone", line: { strokeWidth: 2 } },
    point: { filled: true, size: 70, strokeWidth: 1.25 },
    arc: { innerRadius: 28, padAngle: 0.02, cornerRadius: 3, stroke: t.surface, strokeWidth: 1 },
    rect: { cornerRadius: 2 },
    boxplot: { size: 22 },
  };
}
