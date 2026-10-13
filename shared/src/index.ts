export * from "./types.js";
export * from "./dashboard.js";
export * from "./refusal.js";
export * from "./generative.js";

/** Canonical brand palette (mirrors web/src/theme/tokens.css). Re-exported so the
 *  canvas renderer and any server-side SVG share one source of truth. */
export const BRAND = {
  // Clinical chrome (frame)
  navy: "#0a2540",
  clinicalBlue: "#1769d6",
  teal: "#13b8a6",
  frameBg: "#f4f7fb",
  // Dark luminous graph canvas (off-black, raised-luminance edges)
  canvas: "#14181f",
  edge: "#79b8ff",
  edgeIdle: "#3a424d",
  edgeActive: "#f0f6ff",
  edgeAlt: "#bc8cff",
  live: "#3fb950",
} as const;

/** Light-canvas palette — projector-survival fallback for bright rooms. */
export const CANVAS_LIGHT = {
  canvas: "#f4f7fb",
  edge: "#1769d6",
  edgeIdle: "#c2ccd9",
  edgeActive: "#0a2540",
  label: "#0a2540",
} as const;

/** Dark-canvas palette (default). */
export const CANVAS_DARK = {
  canvas: BRAND.canvas,
  edge: BRAND.edge,
  edgeIdle: BRAND.edgeIdle,
  edgeActive: BRAND.edgeActive,
  label: "#e6edf3",
} as const;

/** Redundant-encoded readiness scale (hue is never the only channel — pair with
 *  ring thickness + numeric badge in the renderer). CVD-safer than red→green. */
export function readinessColor(score: number): string {
  if (score >= 70) return "#2bb673";
  if (score >= 40) return "#e0a93b";
  return "#de4a3b";
}

/** Node colours on the dark canvas, keyed by kind. */
export const NODE_COLORS: Record<string, string> = {
  Patient: "#8b949e",
  AdverseEvent: "#f78166",
  Drug: "#58a6ff",
  BiologicalTarget: "#3fb950",
  Pathway: "#d29922",
  SignalStat: "#bc8cff",
  Evidence: "#79c0ff",
  PathologyImage: "#ff7b72",
  OmicsProfile: "#a5d6ff",
  Concept: "#13b8a6",
  // Workstream-1 modalities — distinct, projector-legible hues (pink / cyan / violet).
  LiteratureAbstract: "#ff80bf",
  ClinicalTrial: "#39c5cf",
  OntologySlice: "#a371f7",
  RegulatoryDoc: "#e3b341", // regulatory amber — authoritative documents
  GeneticAssociation: "#7ee787", // genomics green
  ExternalPipeline: "#9aa4b2", // F8: desaturated grey — "not real" synthetic overlay
};

/** Fallback for any kind not in NODE_COLORS — keeps the canvas/legend/filters in lockstep. */
export const DEFAULT_NODE_COLOR = "#8b949e";

/** Single source of truth for a node's kind colour. Use everywhere a kind is
 *  drawn (canvas fill, filters/legend swatch, hop disc) so they never drift. */
export function nodeColor(kind: string): string {
  return NODE_COLORS[kind] ?? DEFAULT_NODE_COLOR;
}
