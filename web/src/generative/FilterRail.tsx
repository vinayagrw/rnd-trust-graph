/**
 * @rnd/web — FilterRail: the Generative Studio board's host-derived filter rail
 * (Task 11). Renders the board's `FilterControl[]` (derived on the BFF from each
 * field's type + cardinality — never authored by the model) and writes predicate
 * state into the shared `filterControls` store. `applyControls` (already built)
 * turns that state into a coherent node-id narrowing of ALL three datasets.
 *
 * SELF-CONTAINED: it reads `getControls()` and subscribes via `subscribeControls`.
 * Effects do NOT run under the SSR render test, so the initial markup is seeded
 * from `getControls()` read at call time (the useState initializer) — the effect
 * only keeps it in sync afterwards.
 *
 * Returns `null` when there are no controls (an empty rail is nothing to show).
 */
import { useEffect, useState } from "react";
import type { FilterControl } from "@rnd/shared";
import {
  getControls,
  setControl,
  clearControls,
  subscribeControls,
  isActiveControl,
  type ControlValue,
} from "./filterControls.js";

/** A one-line hint of the control's shape, for the caption `${field} · ${hint} → ${kind}`. */
function cardinalityHint(control: FilterControl): string {
  switch (control.kind) {
    case "dropdown":
    case "checkbox":
    case "multiselect":
      return `${control.options?.length ?? 0} values`;
    case "range":
    case "date-range":
      return control.domain ? `${control.domain[0]}–${control.domain[1]}` : "range";
    case "search":
      return "text";
    case "toggle":
      return "on/off";
  }
}

/** The set of values a categorical control currently holds (empty if unset). */
function selectedValues(v: ControlValue | undefined): (string | number)[] {
  return v && v.type === "set" ? v.values : [];
}

const inputStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  borderRadius: 6,
  border: "1px solid var(--frame-border)",
  background: "var(--frame-surface)",
  color: "var(--frame-text)",
};

export function FilterRail({ filters }: { filters: FilterControl[] }): JSX.Element | null {
  // Seed from the store at call time so the SSR render is correct without the effect.
  const [controls, setControls] = useState<Record<string, ControlValue>>(() => getControls());

  useEffect(() => subscribeControls(() => setControls({ ...getControls() })), []);

  if (filters.length === 0) return null;

  // Active fields (a filled set / non-blank search / finite range) drive the chips.
  const activeFields = Object.entries(controls)
    .filter(([, v]) => isActiveControl(v))
    .map(([field]) => field);
  const labelFor = (field: string) => filters.find((f) => f.field === field)?.label ?? field;

  return (
    <div
      data-testid="generative-filter-rail"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 10,
        borderRadius: 8,
        border: "1px solid var(--frame-border)",
        background: "var(--frame-surface)",
      }}
    >
      {/* Active-filter chips: individually removable + a Clear all. */}
      {activeFields.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {activeFields.map((field) => (
            <span
              key={field}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 10,
                padding: "1px 7px",
                borderRadius: 999,
                border: "1px solid rgba(88,166,255,.55)",
                background: "rgba(88,166,255,.16)",
                color: "var(--frame-text)",
              }}
            >
              {labelFor(field)}
              <button
                type="button"
                aria-label={`Remove ${labelFor(field)} filter`}
                onClick={() => setControl(field, null)}
                style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => clearControls()}
            style={{ ...inputStyle, fontSize: 10, cursor: "pointer", background: "transparent" }}
          >
            Clear all
          </button>
        </div>
      )}

      {/* One control per host-derived FilterControl. */}
      {filters.map((control) => (
        <div key={`${control.dataset}:${control.field}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--frame-text-muted)" }}>
            {control.field} · {cardinalityHint(control)} → {control.kind}
          </span>
          {renderControl(control, controls[control.field])}
        </div>
      ))}
    </div>
  );
}

/** Render one control by kind, wiring each change straight to `setControl`. A change
 *  that empties the control passes `null` (removing it from the store). */
function renderControl(control: FilterControl, value: ControlValue | undefined): JSX.Element {
  const { field, kind, options = [], domain } = control;

  switch (kind) {
    case "toggle": {
      // A single on/off predicate: on → the first option (or the string "true", which the
      // store's String()-based match still equates to a boolean `true` cell); off → cleared.
      const onValue: string | number = options.length ? options[0] : "true";
      const checked = selectedValues(value).some((v) => String(v) === String(onValue));
      return (
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--frame-text)" }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setControl(field, e.target.checked ? { type: "set", values: [onValue] } : null)}
          />
          {control.label}
        </label>
      );
    }

    case "dropdown": {
      const current = selectedValues(value)[0];
      return (
        <select
          aria-label={control.label}
          value={current === undefined ? "" : String(current)}
          onChange={(e) => setControl(field, e.target.value ? { type: "set", values: [e.target.value] } : null)}
          style={inputStyle}
        >
          <option value="">All</option>
          {options.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      );
    }

    case "checkbox":
    case "multiselect": {
      // Each option is an independently-toggled membership in the value set.
      const selected = selectedValues(value);
      const toggle = (opt: string | number) => {
        const has = selected.some((v) => String(v) === String(opt));
        const next = has ? selected.filter((v) => String(v) !== String(opt)) : [...selected, opt];
        setControl(field, next.length ? { type: "set", values: next } : null);
      };
      return (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {options.map((opt) => (
            <label
              key={String(opt)}
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--frame-text)" }}
            >
              <input
                type="checkbox"
                checked={selected.some((v) => String(v) === String(opt))}
                onChange={() => toggle(opt)}
              />
              {String(opt)}
            </label>
          ))}
        </div>
      );
    }

    case "search": {
      const text = value && value.type === "search" ? value.text : "";
      return (
        <input
          type="search"
          aria-label={control.label}
          placeholder={`Search ${control.label}…`}
          value={text}
          onChange={(e) => setControl(field, e.target.value ? { type: "search", text: e.target.value } : null)}
          style={inputStyle}
        />
      );
    }

    case "range": {
      const [lo, hi] = (domain as [number, number] | undefined) ?? [0, 0];
      const current = value && value.type === "range" ? value : { min: lo, max: hi };
      const write = (min: number, max: number) => setControl(field, { type: "range", min, max });
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="number"
            aria-label={`${control.label} minimum`}
            min={lo}
            max={hi}
            value={current.min}
            onChange={(e) => write(Number(e.target.value), current.max)}
            style={{ ...inputStyle, width: 72 }}
          />
          <span style={{ fontSize: 10, color: "var(--frame-text-muted)" }}>–</span>
          <input
            type="number"
            aria-label={`${control.label} maximum`}
            min={lo}
            max={hi}
            value={current.max}
            onChange={(e) => write(current.min, Number(e.target.value))}
            style={{ ...inputStyle, width: 72 }}
          />
        </div>
      );
    }

    case "date-range": {
      const [from0, to0] = (domain as [string, string] | undefined) ?? ["", ""];
      const current = value && value.type === "dateRange" ? value : { from: from0, to: to0 };
      const write = (from: string, to: string) => setControl(field, { type: "dateRange", from, to });
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="date"
            aria-label={`${control.label} from`}
            min={from0}
            max={to0}
            value={current.from}
            onChange={(e) => write(e.target.value, current.to)}
            style={inputStyle}
          />
          <span style={{ fontSize: 10, color: "var(--frame-text-muted)" }}>–</span>
          <input
            type="date"
            aria-label={`${control.label} to`}
            min={from0}
            max={to0}
            value={current.to}
            onChange={(e) => write(current.from, e.target.value)}
            style={inputStyle}
          />
        </div>
      );
    }
  }
}
