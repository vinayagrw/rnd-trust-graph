/**
 * @rnd/web — predicate filter store for the Generative Studio board's filter rail.
 *
 * This is SEPARATE from the tiny id-based cross-filter (`filterStore.ts`), which is
 * left byte-identical. Controls hold per-field predicate state (a value set, a numeric
 * range, a date range, or a search string). `applyControls` turns the active predicates
 * into a surviving node-id set (reusing each dataset's node key) and narrows ALL three
 * datasets to it via the SAME `narrowDatasets` the cross-filter uses — so a predicate on
 * a `cited` field also narrows the `metrics`/`edges` tiles for the same nodes (coherent,
 * not half-filtered). The Studio composes the two systems as
 * `narrowDatasets(applyControls(datasets, controls, fieldMenu), selection)`; because both
 * are node-id narrowings, the result is their intersection.
 */
import type { FieldMenuEntry, GenerativeDatasets, GenerativeDatasetName } from "@rnd/shared";
import { narrowDatasets } from "./filterStore.js";

export type ControlValue =
  | { type: "set"; values: (string | number)[] }
  | { type: "range"; min: number; max: number }
  | { type: "dateRange"; from: string; to: string }
  | { type: "search"; text: string };

/** The column each dataset joins back to a node id (mirrors bff `NODE_KEY`). */
const NODE_KEY: Record<GenerativeDatasetName, string> = { cited: "id", metrics: "nodeId", edges: "source" };
const DATASET_ORDER: GenerativeDatasetName[] = ["cited", "metrics", "edges"];

let controls: Record<string, ControlValue> = {};
const listeners = new Set<() => void>();

export function setControl(field: string, next: ControlValue | null): void {
  if (next === null) {
    if (!(field in controls)) return;
    const { [field]: _drop, ...rest } = controls;
    controls = rest;
  } else {
    controls = { ...controls, [field]: next };
  }
  for (const l of listeners) l();
}

export function getControls(): Record<string, ControlValue> {
  return controls;
}

export function clearControls(): void {
  controls = {};
  for (const l of listeners) l();
}

export function subscribeControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True when a control actually constrains anything (an empty set / blank search is a no-op). */
export function isActiveControl(v: ControlValue): boolean {
  switch (v.type) {
    case "set":
      return v.values.length > 0;
    case "search":
      return v.text.trim().length > 0;
    case "range":
      return Number.isFinite(v.min) && Number.isFinite(v.max);
    case "dateRange":
      return Boolean(v.from || v.to);
  }
}

/**
 * Narrow every dataset by the active predicate controls. Pure. Each control restricts
 * the primary dataset that carries its field; the surviving node ids are intersected
 * across controls, and all datasets are narrowed to that id set (via `narrowDatasets`).
 * With no active controls the datasets are returned by reference (no churn).
 */
export function applyControls(datasets: GenerativeDatasets, state: Record<string, ControlValue>, fieldMenu: FieldMenuEntry[]): GenerativeDatasets {
  const active = Object.entries(state).filter(([, v]) => isActiveControl(v));
  if (active.length === 0) return datasets;

  let surviving: Set<string> | null = null;
  for (const [field, value] of active) {
    const ds = primaryDataset(field, fieldMenu);
    if (!ds) continue; // not a bound field — ignore defensively
    const ids = new Set<string>();
    for (const row of datasets[ds]) {
      if (matches(row[field], value)) for (const id of survivingIdsForRow(ds, field, row)) ids.add(id);
    }
    surviving = surviving === null ? ids : intersect(surviving, ids);
  }
  if (surviving === null) return datasets;
  return narrowDatasets(datasets, [...surviving]);
}

/** The node id(s) a matching row contributes to the surviving set. For `cited`/`metrics`
 *  it is the single node key. For `edges` it depends on WHICH field matched: filtering by
 *  `source`/`target` keeps that endpoint; filtering by any other edge field (e.g. `kind`)
 *  keeps BOTH endpoints, so an edge-type filter narrows to the nodes that edge connects. */
function survivingIdsForRow(ds: GenerativeDatasetName, field: string, row: Record<string, unknown>): string[] {
  if (ds === "edges") {
    if (field === "source") return [String(row.source)];
    if (field === "target") return [String(row.target)];
    return [String(row.source), String(row.target)];
  }
  return [String(row[NODE_KEY[ds]])];
}

function primaryDataset(field: string, fieldMenu: FieldMenuEntry[]): GenerativeDatasetName | null {
  for (const ds of DATASET_ORDER) {
    if (fieldMenu.some((f) => f.dataset === ds && f.name === field)) return ds;
  }
  return null;
}

function matches(cell: unknown, value: ControlValue): boolean {
  switch (value.type) {
    case "set": {
      const c = typeof cell === "boolean" ? String(cell) : (cell as string | number);
      return value.values.some((v) => v === c || String(v) === String(cell));
    }
    case "range":
      return typeof cell === "number" && cell >= value.min && cell <= value.max;
    case "dateRange": {
      if (typeof cell !== "string") return false;
      return (!value.from || cell >= value.from) && (!value.to || cell <= value.to);
    }
    case "search":
      return String(cell ?? "").toLowerCase().includes(value.text.trim().toLowerCase());
  }
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}
