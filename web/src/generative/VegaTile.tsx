/**
 * @rnd/web — VegaTile: the LOCKED vega-embed runtime for the Generative Studio
 * lane (Task 9). This is the security-critical client half of the sandboxed
 * Vega-Lite lane: the model (T3/T6) only ever emits a constrained IR that the
 * trusted BFF compiler turns into a `vlSkeleton`; this component is the last
 * line of defence that renders that skeleton WITHOUT ever letting Vega reach
 * outside the page.
 *
 * Lockdown posture (see `docs/superpowers/plans/2026-07-13-generative-studio-vega-lane.md`
 * §5 threat table):
 *   - `ast: true` — vega-embed parses/executes the Vega-Lite→Vega DATAFLOW via the
 *     AST interpreter path instead of `new Function(...)`, so a spec can never
 *     smuggle arbitrary JS through an `expr`/`signal` string.
 *   - `renderer: "canvas"` — no SVG DOM injection surface (defence in depth; the
 *     compiler already can't emit `mark: "text"` with unescaped HTML, but canvas
 *     removes the whole DOM-injection class regardless).
 *   - `actions: false` — no export/view-source/open-in-editor menu (those routes
 *     can trigger new-tab navigation to attacker-controlled URLs on a compromised
 *     spec, and just aren't useful for an inline exploratory tile).
 *   - `loader: denyAllLoader` — every Vega I/O primitive (`load`/`http`/`file`/
 *     `sanitize`) is a hard reject. The tile's data is always the server-bound
 *     `datasets[tile.dataset]` array injected via `prepareSpec`; nothing in a
 *     `vlSkeleton` can name a URL (the compiler never emits `data.url`), but the
 *     loader is denied anyway so a future compiler bug can't turn into an SSRF/
 *     exfil primitive.
 *   - `usermeta` is stripped in `prepareSpec` (belt-and-suspenders): vega-embed
 *     deep-merges a spec's `usermeta.embedOptions` OVER the host's `opts` — if a
 *     spec ever carried `usermeta.embedOptions.ast = false`, it would flip the
 *     AST guarantee above. The trusted compiler (`bff/src/generative/schema.ts`)
 *     already can't emit `usermeta` (`.strict()` schemas reject unknown keys),
 *     but this component strips it a second time so the guarantee doesn't rest
 *     on the compiler alone.
 *   - `window.vega` / `window.View` / `window.VEGA_DEBUG` are NEVER assigned by
 *     this file (vega-embed may set `VEGA_DEBUG` itself in dev builds — that is
 *     vega-embed's own behaviour, not something this component adds).
 */
import { useEffect, useRef, useState } from "react";
import type { GenerativeDatasets, GenerativeTile } from "@rnd/shared";
import type { EmbedOptions, Result as EmbedResult, VisualizationSpec } from "vega-embed";
import { vegaConfig, resolveThemeMode, type ThemeMode } from "./vegaTheme.js";

/** Every I/O primitive Vega's runtime loader exposes is denied outright. A
 *  stable module-level instance so `LOCKED_EMBED_OPTIONS.loader === denyAllLoader`
 *  holds by reference (asserted directly in the lockdown test). Deliberately
 *  untyped as the nominal vega `Loader` interface (and given a rest-param
 *  signature): the lockdown test calls these methods directly with varying
 *  arities (e.g. `sanitize(uri, {})`), so the export must stay structurally
 *  callable with any arguments rather than pinned to one loader method's
 *  exact parameter list. It still satisfies `Loader` structurally wherever
 *  vega-embed's `EmbedOptions.loader` expects one (checked below). */
async function blocked(..._args: unknown[]): Promise<never> {
  throw new Error("blocked: external loading is disabled");
}

export const denyAllLoader = {
  load: blocked,
  http: blocked,
  file: blocked,
  sanitize: blocked,
};

/** The locked embed-options set. `as const` so every field is the literal value
 *  the lockdown test asserts, not merely a widened `boolean`/`string`. */
export const LOCKED_EMBED_OPTIONS = {
  ast: true,
  actions: false,
  renderer: "canvas",
  loader: denyAllLoader,
} as const satisfies EmbedOptions;

/** Pure: strip `usermeta` (belt-and-suspenders — see file header), inject ONLY
 *  the tile's own named dataset (never the whole `GenerativeDatasets` bag, so a
 *  tile can't be pointed at a dataset the compiler didn't bind it to), and apply
 *  the HOST's chart theme.
 *
 *  The theme is written LAST and unconditionally: `config` is unrepresentable in
 *  the model-facing IR, so a skeleton can never carry one — the host owns styling
 *  outright (see `vegaTheme.ts`). */
export function prepareSpec(
  tile: GenerativeTile,
  datasets: GenerativeDatasets,
  mode: ThemeMode = "dark",
): Record<string, unknown> {
  const { usermeta: _usermeta, ...rest } = tile.vlSkeleton as Record<string, unknown> & {
    usermeta?: unknown;
  };
  return {
    ...rest,
    datasets: { [tile.dataset]: datasets[tile.dataset] },
    config: vegaConfig(mode),
  };
}

/** Best-effort extraction of selected row `id`s from a Vega selection param
 *  signal. Vega-Lite compiles a `params: [{name, select}]` entry into a plain
 *  signal (the one this component listens on, NOT its `_store` sibling) whose
 *  VALUE shape varies with selection type/version:
 *    - a "predicate" object keyed by projected field, e.g. `{unit, id: [...]}`
 *      when the selection happens to project onto the `id` field directly;
 *    - a single-tuple shape `{unit, fields: [{field}], values: [...]}` (the
 *      most-recently-toggled point);
 *    - occasionally an array of datum-like rows.
 *  This is intentionally defensive: an unrecognised/empty shape yields `[]`,
 *  which the caller turns into `onSelect(null)` rather than ever throwing. */
/** A selected tuple, as `field -> accepted values`. */
type Predicate = Record<string, unknown[]>;

/** Normalise Vega's point-selection signal into predicates. Its shape varies with version and
 *  projection, so every recognised form is handled and an unknown one yields `[]` (fail closed
 *  to "no selection") rather than throwing out of a Vega event handler. */
function toPredicates(value: unknown): Predicate[] {
  if (value == null || typeof value !== "object") return [];

  // Single-tuple shape: `{unit, fields: [{field}, ...], values: [...]}`.
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.fields) && Array.isArray(obj.values)) {
    const fields = obj.fields as Array<{ field?: unknown }>;
    const values = obj.values as unknown[];
    const pred: Predicate = {};
    fields.forEach((f, i) => {
      if (typeof f?.field === "string" && values[i] !== undefined) {
        pred[f.field] = Array.isArray(values[i]) ? (values[i] as unknown[]) : [values[i]];
      }
    });
    return Object.keys(pred).length ? [pred] : [];
  }

  // Predicate shape keyed by projected field: `{unit, kind: ["Drug"], flagged: [false]}`.
  const pred: Predicate = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "unit" || k === "vlPoint" || k === "_vgsid_") continue;
    if (Array.isArray(v)) pred[k] = v;
  }
  return Object.keys(pred).length ? [pred] : [];
}

/**
 * Resolve a selection to GRAPH NODE IDS by matching the selected dimension values against the
 * tile's own bound rows and reading each matching row's node key.
 *
 * The indirection is the whole point. A selection on an aggregated chart names a GROUP
 * ("kind = Drug"), not a node — there is no id on an aggregated tuple to read. Mapping the
 * group back through the rows turns "the user clicked the Drug bar" into "these are the Drug
 * nodes", which is exactly what the cross-filter needs, and it works identically for a
 * non-aggregated tile (where the predicate happens to identify a single row).
 */
export function selectedIds(
  value: unknown,
  rows: ReadonlyArray<Record<string, unknown>>,
  nodeKey: string,
): string[] {
  const predicates = toPredicates(value);
  if (!predicates.length) return [];

  const ids = new Set<string>();
  for (const row of rows) {
    const matches = predicates.some((pred) =>
      Object.entries(pred).every(([field, accepted]) =>
        accepted.some((v) => String(row[field]) === String(v)),
      ),
    );
    if (!matches) continue;
    const id = row[nodeKey];
    if (id !== undefined && id !== null) ids.add(String(id));
  }
  return [...ids];
}

/** Which column of each dataset joins a row back to a graph node id — mirrors the compiler's
 *  `NODE_KEY` (bff/src/generative/schema.ts). A `metrics` row is keyed by `nodeId`, an `edges`
 *  row by `source`; reading `id` on those (the old behaviour) always came back empty. */
const NODE_KEY: Record<GenerativeTile["dataset"], string> = {
  cited: "id",
  metrics: "nodeId",
  edges: "source",
};

export interface VegaTileProps {
  tile: GenerativeTile;
  datasets: GenerativeDatasets;
  onSelect: (ids: string[] | null) => void;
  /** Force a chart theme. Omit (the norm) and the theme is MEASURED from the surface the tile
   *  is painted on — see `resolveThemeMode`. Every attempt to infer it from a prop instead
   *  (`lightCanvas`, then the app `skin`) picked the wrong palette. */
  light?: boolean;
  /** Open the tile's lineage drawer ("Explain this tile"). Omitted = no button. */
  onExplain?: (tile: GenerativeTile) => void;
  /** Refine this tile by chat (Phase 5). Omitted = no refine controls. */
  onRefine?: (tile: GenerativeTile, instruction: string) => void;
  /** Walk the most recent refinement back. Shown only when `restorable > 0`. */
  onRestore?: (tile: GenerativeTile) => void;
  /** How many prior versions are available to restore (drives the ↩ button). */
  restorable?: number;
  /** A refine round is in flight for this tile — disable the controls and show a hint. */
  refining?: boolean;
}

/** Refine presets that the tile IR can ACTUALLY express (mark swap, a facet channel, a
 *  colour channel, binning). Deliberately NOT "log scale" / "top N": the encoding-only IR
 *  carries no scale config and no sort/limit transform, so those would silently no-op. */
const REFINE_PRESETS: { label: string; instruction: string }[] = [
  { label: "Swap mark", instruction: "Redraw this with a different, better-fitting mark type." },
  { label: "Facet by kind", instruction: "Break this into small multiples faceted by the kind field." },
  { label: "Color by kind", instruction: "Add a colour encoding by the kind field." },
  { label: "Bin values", instruction: "Bin the quantitative field into buckets." },
];

/** Chart-shaped placeholder shown from the moment a tile arrives until vega-embed
 *  resolves — ghost axes + a shimmering plot area, so a streaming board grows in
 *  place instead of popping. */
function TileSkeleton() {
  return (
    <div
      data-testid="vega-tile-skeleton"
      aria-hidden
      style={{
        height: 160,
        borderLeft: "1px solid var(--frame-border)",
        borderBottom: "1px solid var(--frame-border)",
        borderRadius: 2,
        margin: "8px 8px 8px 4px",
        background:
          "repeating-linear-gradient(90deg, var(--frame-border) 0 1px, transparent 1px 44px)",
        opacity: 0.35,
      }}
    />
  );
}

/** Tile chrome: title, a NON-COLOR trust pill (flask glyph + dashed border =
 *  exploratory; check glyph + solid border = certified — the state reads without
 *  colour vision), an "Explain this tile" affordance, and a provenance strip naming
 *  the grounded nodes and the fields actually charted.
 *
 *  NO quality meter here, deliberately: the deterministic critic is a GATE (it rejects
 *  a bad chart before emission), not a discriminator that ranks good ones — every tile
 *  that survives scores at or near 1.0, so a per-tile meter would render the same value
 *  on everything and imply a gradation that does not exist. The score is still reported,
 *  as a stated fact, in the lineage drawer where it is informative rather than decorative. */
export function VegaTile({
  tile,
  datasets,
  onSelect,
  light,
  onExplain,
  onRefine,
  onRestore,
  restorable = 0,
  refining = false,
}: VegaTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [refineText, setRefineText] = useState("");
  const certified = tile.status === "certified";

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let result: EmbedResult | undefined;
    setReady(false);

    (async () => {
      // Lazy chunk — vega/vega-lite/vega-embed only load once a tile is
      // actually rendered (see vite.config.ts manualChunks: "vega").
      const { default: embed } = await import("vega-embed");
      if (cancelled) return;

      const mode: ThemeMode = light === undefined ? resolveThemeMode(el) : light ? "light" : "dark";
      const spec = prepareSpec(tile, datasets, mode) as unknown as VisualizationSpec;
      const embedded = await embed(el, spec, LOCKED_EMBED_OPTIONS);
      if (cancelled) {
        // The effect was cleaned up before embed() resolved — finalize
        // immediately instead of leaking the view.
        embedded.finalize();
        return;
      }
      result = embedded;
      setReady(true);

      const params = Array.isArray((tile.vlSkeleton as Record<string, unknown>).params)
        ? ((tile.vlSkeleton as Record<string, unknown>).params as Array<{ name?: unknown }>)
        : [];
      for (const p of params) {
        const name = typeof p?.name === "string" ? p.name : undefined;
        if (!name) continue;
        result.view.addSignalListener(name, (_signalName, value) => {
          try {
            // Resolve against the tile's OWN bound rows — the selection names dimension values,
            // and the rows are what turn those into node ids.
            const ids = selectedIds(value, datasets[tile.dataset] ?? [], NODE_KEY[tile.dataset]);
            onSelect(ids.length ? ids : null);
          } catch {
            // Defensive: an unexpected signal shape must never throw out of a
            // Vega event handler — fail closed to "no selection".
            onSelect(null);
          }
        });
      }
    })();

    return () => {
      cancelled = true;
      // If embed() already resolved, finalize now; otherwise the in-flight
      // promise above finalizes itself as soon as it resolves (the race guard
      // above), so the view is never leaked either way.
      result?.finalize();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tile, datasets, light]);

  const prov = tile.provenance;
  /** Rows the tile is rendering right now — `datasets` arrives already cross-filtered. */
  const drawnRows = (datasets[tile.dataset] ?? []).length;

  return (
    <div style={{ borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, minHeight: 16 }}>
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            color: "var(--frame-text-muted)",
          }}
        >
          {tile.title}
        </span>
        <span
          data-testid={certified ? "vega-tile-certified" : "vega-tile-exploratory"}
          title={
            certified
              ? "Certified: a human reviewer approved this chart"
              : "Exploratory: an LLM-composed chart, not a certified query pattern"
          }
          style={{
            fontSize: 9,
            textTransform: "uppercase",
            letterSpacing: 0.4,
            padding: "0 6px",
            borderRadius: 999,
            // Non-colour state signal: dashed border + flask glyph vs solid + check.
            border: certified ? "1px solid rgba(35,134,54,0.8)" : "1px dashed rgba(217,119,6,0.7)",
            color: certified ? "rgba(35,134,54,0.95)" : "rgba(217,119,6,0.95)",
            fontWeight: 700,
            whiteSpace: "nowrap",
          }}
        >
          {certified ? "✓ certified" : "⚗ exploratory"}
        </span>
        {typeof tile.candidateCount === "number" && tile.candidateCount > 0 && (
          // Candidate-and-rank audit — shows the best chart was PICKED from ranked options,
          // not the only one tried ("where I find out the best visuals").
          <span
            data-testid="vega-tile-candidates"
            title={`Candidate-and-rank: chosen from ${tile.candidateCount} candidate encoding${tile.candidateCount === 1 ? "" : "s"} the server ranked${typeof tile.candidateScore === "number" ? ` — winning fit ${Math.round(tile.candidateScore * 100)}%` : ""}. The best visual was picked, not the only one tried.`}
            style={{
              fontSize: 9,
              padding: "0 6px",
              borderRadius: 999,
              border: "1px solid rgba(46,160,67,.45)",
              color: "var(--frame-text-muted)",
              whiteSpace: "nowrap",
              cursor: "help",
            }}
          >
            ★ {tile.candidateCount > 1 ? `best of ${tile.candidateCount}` : "ranked"}
            {typeof tile.candidateScore === "number" ? ` · ${Math.round(tile.candidateScore * 100)}%` : ""}
          </span>
        )}
        {onExplain && (
          <button
            type="button"
            onClick={() => onExplain(tile)}
            title="Show this tile's lineage: rationale, fields, cited nodes and the exact bound rows"
            style={{
              marginLeft: "auto",
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 6,
              border: "1px solid var(--frame-border)",
              background: "transparent",
              color: "var(--frame-text)",
              cursor: "pointer",
            }}
          >
            🔍 Explain
          </button>
        )}
      </div>

      <div ref={containerRef} />
      {!ready && <TileSkeleton />}

      {prov && (
        <div
          data-testid="vega-tile-provenance"
          style={{
            marginTop: 4,
            fontSize: 10,
            lineHeight: 1.5,
            color: "var(--frame-text-muted)",
            borderTop: "1px dashed var(--frame-border)",
            paddingTop: 4,
          }}
        >
          Grounded in {prov.nodeIds.length} cited node{prov.nodeIds.length === 1 ? "" : "s"} ·{" "}
          {/* Report what the chart ACTUALLY drew. A cross-filter narrows the rows after compose,
              so showing only the compose-time count would overstate the tile while a filter is
              active — the one place a provenance strip must not be approximate. */}
          {drawnRows === prov.rowCount
            ? `${prov.rowCount} ${tile.dataset} row${prov.rowCount === 1 ? "" : "s"}`
            : `${drawnRows} of ${prov.rowCount} ${tile.dataset} rows (filtered)`}
          {prov.fields.length > 0 && <> · fields: {prov.fields.join(", ")}</>}
        </div>
      )}

      {onRefine && (
        <div
          data-testid="vega-tile-refine"
          style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
            {REFINE_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                disabled={refining}
                onClick={() => onRefine(tile, p.instruction)}
                title={p.instruction}
                style={{
                  fontSize: 10,
                  padding: "1px 7px",
                  borderRadius: 999,
                  border: "1px solid var(--frame-border)",
                  background: "transparent",
                  color: "var(--frame-text)",
                  cursor: refining ? "default" : "pointer",
                  opacity: refining ? 0.5 : 1,
                }}
              >
                {p.label}
              </button>
            ))}
            {restorable > 0 && onRestore && (
              <button
                type="button"
                disabled={refining}
                onClick={() => onRestore(tile)}
                title="Restore the previous version of this tile"
                style={{
                  fontSize: 10,
                  padding: "1px 7px",
                  borderRadius: 999,
                  border: "1px solid rgba(217,119,6,0.6)",
                  background: "transparent",
                  color: "rgba(217,119,6,0.95)",
                  cursor: refining ? "default" : "pointer",
                  opacity: refining ? 0.5 : 1,
                }}
              >
                ↩ Restore ({restorable})
              </button>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const text = refineText.trim();
              if (!text || refining) return;
              onRefine(tile, text);
              setRefineText("");
            }}
            style={{ display: "flex", gap: 5 }}
          >
            <input
              value={refineText}
              disabled={refining}
              onChange={(e) => setRefineText(e.target.value)}
              placeholder={refining ? "refining…" : "Refine: e.g. facet by kind"}
              aria-label={`Refine ${tile.title}`}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 10,
                padding: "2px 6px",
                borderRadius: 6,
                border: "1px solid var(--frame-border)",
                background: "var(--frame-surface)",
                color: "var(--frame-text)",
              }}
            />
            <button
              type="submit"
              disabled={refining || !refineText.trim()}
              style={{
                fontSize: 10,
                padding: "2px 8px",
                borderRadius: 6,
                border: "1px solid var(--frame-border)",
                background: "transparent",
                color: "var(--frame-text)",
                cursor: refining || !refineText.trim() ? "default" : "pointer",
                opacity: refining || !refineText.trim() ? 0.5 : 1,
              }}
            >
              {refining ? "…" : "↻"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
