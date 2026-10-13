/**
 * Host-owned layout + filter derivation — PURE, deterministic, no LLM.
 *
 * This is the trust boundary for the two new host-owned concerns:
 *  - `deriveFilters` turns a list of field NAMES (from the planner's intent) into
 *    concrete filter controls, choosing the control KIND from each field's type +
 *    cardinality (the §4.2 rule) and sourcing every option/domain from the DISTINCT
 *    values actually present in the bound datasets. The model contributes only the
 *    field names; it never authors a control kind or an option value.
 *  - `assignLayout` stamps `role` + `span` on tiles per archetype. Sizing is a host
 *    decision — the model's IR has no span, and cannot get one.
 *  - `deriveKpi` produces a KPI-card descriptor whose NUMBER is computed client-side
 *    from bound rows (never emitted by the model).
 */
import type {
  FieldMenuEntry,
  FilterControl,
  FilterControlKind,
  GenerativeDatasets,
  GenerativeDatasetName,
  GenerativeTile,
  LayoutArchetype,
  BoardSlot,
  TileKpi,
  TileRole,
} from "@rnd/shared";

/** Dataset preference when a field name exists in more than one dataset: cited is
 *  the primary node table, then the tidy-long metrics, then edges. */
const DATASET_ORDER: GenerativeDatasetName[] = ["cited", "metrics", "edges"];

/** Derive concrete filter controls for a set of requested field names. A control is
 *  scoped to ONE dataset (its primary), and its options/domain are read from that
 *  dataset's rows — so a categorical control lists exactly the values on screen. */
export function deriveFilters(fieldMenu: FieldMenuEntry[], requestedFields: string[], datasets: GenerativeDatasets): FilterControl[] {
  const controls: FilterControl[] = [];
  const seen = new Set<string>();
  for (const name of requestedFields) {
    if (seen.has(name)) continue;
    const entries = fieldMenu.filter((f) => f.name === name);
    if (entries.length === 0) continue; // not a real bound field — skip defensively
    seen.add(name);
    const primary = pickPrimary(entries);
    const control = buildControl(name, primary, datasets);
    if (control) controls.push(control);
  }
  return controls;
}

function pickPrimary(entries: FieldMenuEntry[]): FieldMenuEntry {
  for (const ds of DATASET_ORDER) {
    const hit = entries.find((e) => e.dataset === ds);
    if (hit) return hit;
  }
  return entries[0]!;
}

function buildControl(name: string, entry: FieldMenuEntry, datasets: GenerativeDatasets): FilterControl | null {
  const rows = datasets[entry.dataset] ?? [];
  const base = { field: name, dataset: entry.dataset, vlType: entry.vlType, label: humanize(name) };

  if (entry.vlType === "quantitative") {
    const nums = rows.map((r) => r[name]).filter((v): v is number => typeof v === "number");
    if (nums.length === 0) return null;
    return { ...base, kind: "range", domain: [Math.min(...nums), Math.max(...nums)] };
  }
  if (entry.vlType === "temporal") {
    const dates = rows.map((r) => r[name]).filter((v): v is string => typeof v === "string").sort();
    if (dates.length === 0) return null;
    return { ...base, kind: "date-range", domain: [dates[0]!, dates[dates.length - 1]!] };
  }
  // nominal / ordinal → a value-list control; the kind depends on cardinality.
  const distinct = distinctValues(rows, name);
  if (distinct.length === 0) return null;
  const kind = categoricalKind(distinct);
  const control: FilterControl = { ...base, kind };
  if (kind === "toggle") {
    // A boolean toggle filters to the TRUTHY value when checked. Hand the UI the "on"
    // literal explicitly ("true") — it must NOT infer it from option order, which sorts
    // "false" before "true" and would invert the filter (checking "Flagged" would keep
    // the UNflagged nodes).
    control.options = ["true"];
  } else if (kind !== "search") {
    control.options = distinct; // search needs no pre-listed options
  }
  return control;
}

/** boolean-like → toggle; ≤7 → dropdown; 8–25 → multiselect; >25 → search. */
function categoricalKind(distinct: (string | number)[]): FilterControlKind {
  // `distinctValues` stringifies booleans, so a boolean field shows up as "true"/"false".
  const boolean = distinct.length <= 2 && distinct.every((v) => v === "true" || v === "false");
  if (boolean) return "toggle";
  if (distinct.length <= 7) return "dropdown";
  if (distinct.length <= 25) return "multiselect";
  return "search";
}

function distinctValues(rows: Record<string, unknown>[], field: string): (string | number)[] {
  const set = new Set<string | number>();
  for (const r of rows) {
    const v = r[field];
    if (v === null || v === undefined) continue;
    if (typeof v === "number" || typeof v === "string") set.add(v);
    else if (typeof v === "boolean") set.add(String(v));
  }
  return [...set].sort((a, b) => (typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b))));
}

/** The single-metric, host-computed card roles (KpiCard family). These are NEVER
 *  charts: their value/series is computed on the client from bound rows, so they sit
 *  in the KPI strip and never take an LLM worker. `kpi` = number, `gauge` = radial
 *  dial, `spark` = number + sparkline. */
export function isKpiFamilyRole(role: TileRole | undefined): boolean {
  return role === "kpi" || role === "gauge" || role === "spark";
}

/**
 * Stamp `role` + `span` on tiles per archetype. KPI-family tiles (host-created,
 * carrying a `.kpi` descriptor, or already marked `kpi`/`gauge`/`spark`) always
 * render as span-1 cards in every archetype, KEEPING their own family role; the
 * remaining CHART tiles get their role/span by position. Returns NEW tile objects (pure).
 */
export function assignLayout(archetype: LayoutArchetype, tiles: GenerativeTile[]): GenerativeTile[] {
  let chartIdx = 0;
  const chartCount = tiles.filter((t) => !isKpiFamilyRole(t.role) && !t.kpi).length;
  return tiles.map((t) => {
    if (isKpiFamilyRole(t.role) || t.kpi) {
      const role: TileRole = isKpiFamilyRole(t.role) ? t.role! : "kpi";
      return { ...t, role, span: 1 as const };
    }
    const { role, span } = chartRoleSpan(archetype, chartIdx++, chartCount);
    return { ...t, role, span };
  });
}

/** Archetypes with a dominant first chart put it in a full-width hero; the uniform
 *  archetypes make every chart an equal half-width detail. */
function chartRoleSpan(archetype: LayoutArchetype, pos: number, _count: number): { role: TileRole; span: 1 | 2 } {
  const heroFirst = archetype === "hero-rail" || archetype === "master-detail" || archetype === "bento";
  if (heroFirst && pos === 0) return { role: "hero", span: 2 };
  return { role: "detail", span: 1 };
}

/** A host KPI descriptor for a KpiCard-family slot (`kpi`/`gauge`/`spark`). A metrics
 *  slot summarises the numeric `value`; anything else counts rows. The value itself is
 *  computed on the client from bound rows — never here, and never by the model.
 *
 *  For a `gauge` slot the descriptor also carries a host-derived `domain` [min,max]
 *  read from the bound metric's ACTUAL values in `datasets` — so the dial is drawn
 *  against real data extents, still never a model-supplied range. */
export function deriveKpi(slot: BoardSlot, fieldMenu: FieldMenuEntry[], datasets?: GenerativeDatasets): TileKpi {
  const hasValue = fieldMenu.some((f) => f.dataset === slot.dataset && f.name === "value" && f.vlType === "quantitative");
  const kpi: TileKpi =
    slot.dataset === "metrics" && hasValue
      ? { field: "value", aggregate: "mean", label: shortLabel(slot.intent) }
      : { aggregate: "count", label: shortLabel(slot.intent) };

  // A gauge needs a domain to draw its arc against. Host-derive it from the bound
  // metric's real min/max — only meaningful when the KPI folds over a numeric field.
  if (slot.role === "gauge" && kpi.field && datasets) {
    const domain = fieldDomain(datasets[slot.dataset] ?? [], kpi.field);
    if (domain) kpi.domain = domain;
  }
  return kpi;
}

/** The [min,max] of a numeric column across bound rows, host-derived (never the model).
 *  A degenerate (single-value) column is widened so a gauge arc still has extent. */
function fieldDomain(rows: Record<string, unknown>[], field: string): [number, number] | undefined {
  const nums: number[] = [];
  for (const r of rows) {
    const v = r[field];
    if (typeof v === "number" && Number.isFinite(v)) nums.push(v);
  }
  if (nums.length === 0) return undefined;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    if (max > 0) min = 0;
    else if (min < 0) max = 0;
    else max = 1; // all-zero → [0,1]
  }
  return [min, max];
}

function humanize(name: string): string {
  return name.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortLabel(intent: string): string {
  const s = intent.trim().replace(/\s+/g, " ");
  return s.length <= 28 ? s : `${s.slice(0, 27)}…`;
}
