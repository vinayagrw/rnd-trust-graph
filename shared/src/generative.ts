/** Generative Vega-Lite lane — plain types (validation lives in bff zod v4).
 *  A tile's vlSkeleton is a CONSTRAINED Vega-Lite fragment: the model never
 *  emits data values; `data` is a named reference the server binds. */

/** The named datasets the server binds and a tile may reference. */
export type GenerativeDatasetName = "cited" | "metrics" | "edges";

export interface FieldMenuEntry {
  name: string;
  vlType: "quantitative" | "nominal" | "ordinal" | "temporal";
  cardinality: number;
  /** Which bound dataset this field belongs to. A tile's field refs are validated
   *  against the fields of the dataset the tile selected (dataset-scoped menu). */
  dataset: GenerativeDatasetName;
}

/** Rows the server binds from ALREADY-CITED graph nodes/edges.
 *  - `cited`  — one wide row per cited node: {id,label,kind,degree,flagged,...parsed attrs}.
 *  - `metrics`— tidy-long: one row per numeric attribute {nodeId,label,kind,metric,value}.
 *  - `edges`  — one row per induced edge: {source,target,kind}. */
export interface GenerativeDatasets {
  cited: Record<string, string | number | boolean | null>[];
  metrics: Record<string, string | number | boolean | null>[];
  edges: Record<string, string | number | boolean | null>[];
}

/** Where a tile's numbers came from. Every field is server-derived at compose
 *  time from the ALREADY-CITED node set — the model contributes none of it. */
export interface TileProvenance {
  /** Cited graph node ids the tile's dataset was bound from. */
  nodeIds: string[];
  /** The field names the tile actually encodes (channels + transform filters). */
  fields: string[];
  /** How many bound rows the tile's dataset held at compose time. */
  rowCount: number;
}

/** Exploratory = an LLM-composed chart (the default for this lane). Certified =
 *  a tile a human reviewer graduated (Phase 7). Rendered with a NON-COLOR signal
 *  (glyph + border style), never colour alone — WCAG 1.4.1. */
export type TileStatus = "exploratory" | "certified";

/** A tile's role in a composed board layout. HOST-OWNED: set only by the server's
 *  `assignLayout`, never by the model. `kpi` = a single-number card, `hero` = the
 *  dominant chart, `detail` = a supporting chart, `gauge` = a single metric drawn on
 *  a radial arc against a host-derived domain, `spark` = a single metric with an inline
 *  sparkline of its series. `gauge`/`spark` are KpiCard-family (single-metric, host-
 *  computed from bound rows, no Vega) and sit in the KPI strip. */
export type TileRole = "kpi" | "hero" | "detail" | "gauge" | "spark";

/** The aggregate a KPI card computes over its bound rows (host-computed value). */
export type KpiAggregate = "count" | "sum" | "mean" | "min" | "max";

/** A KPI-card descriptor. HOST-OWNED — the model never emits a number; the client
 *  computes the value by applying `aggregate` to `field` over the already-bound
 *  (and cross-filtered) rows of the tile's dataset. `field` is omitted for `count`. */
export interface TileKpi {
  field?: string;
  aggregate: KpiAggregate;
  label: string;
  /** HOST-SET domain [min,max] for a `role:"gauge"` tile — the arc is drawn against it.
   *  Derived from the bound metric's ACTUAL min/max in `layout.ts` `deriveKpi`, never
   *  emitted by the model. Absent for plain `kpi`/`spark` tiles. */
  domain?: [number, number];
}

export interface GenerativeTile {
  id: string;
  title: string;
  /** Constrained VL fragment (mark/encoding/transform/params/data-name only). */
  vlSkeleton: Record<string, unknown>;
  /** Which named dataset the skeleton references. */
  dataset: GenerativeDatasetName;
  /** Deterministic chart-quality score 0..1 (Draco-lite critic). Higher = the chart
   *  shape fits the data better. Undefined for template tiles (not critic-gated). */
  appropriateness?: number;
  /** Trust state of the tile. Absent = exploratory. */
  status?: TileStatus;
  /** The model's one-line reason for THIS chart choice. Prose only — never a data
   *  value; it is shown to the user, never fed back into binding. */
  rationale?: string;
  /** Server-derived lineage (see TileProvenance). */
  provenance?: TileProvenance;
  /** HOST-OWNED layout role in a composed board (set by `assignLayout`). */
  role?: TileRole;
  /** HOST-OWNED grid span (1 = half width, 2 = full width). Set by `assignLayout`. */
  span?: 1 | 2;
  /** HOST-OWNED KPI descriptor — present only on `role:"kpi"` tiles; the value is
   *  computed client-side from bound rows, never emitted by the model. */
  kpi?: TileKpi;
  /** Candidate-and-rank audit (board mode): how many gated alternatives this slot's
   *  worker produced. Surfaced in the UI so the user can see the best visual was
   *  PICKED from options, not the only one tried. HOST-set, never from the model. */
  candidateCount?: number;
  /** The winning candidate's deterministic critic score 0..1 (the "why this one"). */
  candidateScore?: number;
}

/** The layout archetypes the server can compose a board into (§3 of the design
 *  doc). Chosen by the planner as a HINT; the server owns the actual role/span. */
export type LayoutArchetype =
  | "kpi-grid"
  | "hero-rail"
  | "bento"
  | "small-multiples"
  | "master-detail"
  | "analytic-grid";

/** The concrete filter-control kinds a board's rail can render. HOST-DERIVED from
 *  each field's type + cardinality (§4.2 cardinality→control rule) — the model
 *  never authors a control. */
export type FilterControlKind =
  | "toggle"
  | "dropdown"
  | "checkbox"
  | "multiselect"
  | "search"
  | "range"
  | "date-range";

/** A single host-derived filter control. Its `options`/`domain` are the DISTINCT
 *  values (or min/max) read from the bound datasets — never from the model. */
export interface FilterControl {
  field: string;
  dataset: GenerativeDatasetName;
  kind: FilterControlKind;
  vlType: FieldMenuEntry["vlType"];
  label: string;
  /** Distinct values for a categorical control (dropdown/checkbox/multiselect). */
  options?: (string | number)[];
  /** [min,max] for a `range`, or [minISO,maxISO] for a `date-range`. */
  domain?: [number, number] | [string, string];
}

/** One slot in a board plan — the planner's INTENT for a tile. Carries no data,
 *  no span, no control config; the model may only name a role/dataset/intent. */
export interface BoardSlot {
  role: TileRole;
  dataset: GenerativeDatasetName;
  /** Free-text analytical intent for this slot (never rendered as a data value). */
  intent: string;
  /** Optional chart-shape hint (e.g. "bar", "line", "donut"). */
  chartHint?: string;
}

/** The planner's output — model-proposed INTENT only. `filterFields` are field
 *  NAMES (⊆ the field menu); the server derives the actual controls. */
export interface BoardPlan {
  archetype: LayoutArchetype;
  filterFields: string[];
  slots: BoardSlot[];
}

export interface GenerativeBoard {
  version: 1;
  tiles: GenerativeTile[];
  citedNodeIds: string[];
  source: "llm" | "template";
  /** HOST-OWNED layout archetype the board was arranged into. */
  layout?: LayoutArchetype;
  /** HOST-DERIVED filter controls for the board's rail. */
  filters?: FilterControl[];
  /** Deterministic board-level quality score 0..1 (see `scoreBoard`). */
  boardScore?: number;
  /** One-line "why this board" rationale surfaced to the user. */
  boardRationale?: string;
  /** The planner's intent (audit/lineage) — never a data value. */
  plan?: BoardPlan;
}
