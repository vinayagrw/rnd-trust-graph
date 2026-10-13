import { z } from "zod";
import type { GenerativeTile, FieldMenuEntry } from "@rnd/shared";

/** Model-facing IR — the model writes THIS grammar, never raw Vega-Lite.
 *  Every object is .strict(): unknown keys (usermeta, on, expr…) fail parse. */
const MARKS = ["bar", "line", "point", "area", "rect", "tick", "text", "arc", "boxplot"] as const;
const VL_TYPES = ["quantitative", "nominal", "ordinal", "temporal"] as const;
const AGGREGATES = ["count", "sum", "mean", "min", "max"] as const;
// x/y/color/size/opacity/tooltip + theta (pie/arc), column/row (facet small-multiples),
// xOffset (grouped bars). All are position/mapping channels — still encoding-only, no config.
const CHANNELS = ["x", "y", "color", "size", "opacity", "tooltip", "theta", "column", "row", "xOffset"] as const;
const DATASETS = ["cited", "metrics", "edges"] as const;
const OPS = { "=": "equal", "!=": "notEqual", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", in: "oneOf" } as const;

/** Build the IR schema for a DATASET-SCOPED field menu: a tile's `field` refs are
 *  validated against the fields of the dataset the tile selected (not a flat set),
 *  so a `cited`-only field can't be used on an `edges`/`metrics` tile. */
export function tileIRSchema(fieldMenu: FieldMenuEntry[]) {
  const byDataset: Record<string, Set<string>> = { cited: new Set(), metrics: new Set(), edges: new Set() };
  for (const f of fieldMenu) byDataset[f.dataset]?.add(f.name);

  const channelDef = z.object({
    field: z.string().optional(),
    type: z.enum(VL_TYPES).optional(),
    aggregate: z.enum(AGGREGATES).optional(),
    bin: z.boolean().optional(),
  }).strict().refine((c) => c.field !== undefined || c.aggregate === "count", { message: "channel needs a field (or aggregate:count)" });

  return z.object({
    title: z.string().max(120),
    // Prose only — the model's reason for choosing THIS chart. It is displayed
    // to the user and never fed back into binding, so it can carry no data.
    rationale: z.string().max(200).optional(),
    dataset: z.enum(DATASETS),
    mark: z.enum(MARKS),
    encoding: z.object(Object.fromEntries(CHANNELS.map((c) => [c, channelDef.optional()]))).strict()
      .refine((e) => Object.values(e).some(Boolean), { message: "at least one channel" }),
    transform: z.array(z.object({
      filter: z.object({
        field: z.string(),
        op: z.enum(Object.keys(OPS) as [keyof typeof OPS, ...(keyof typeof OPS)[]]),
        value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()])).max(20)]),
      }).strict(),
    }).strict()).max(3).optional(),
    // NO `params` — selection is host-owned (see compileTile). `.strict()` means a model that
    // tries to declare one fails parse rather than having it silently dropped.
  }).strict().superRefine((tile, ctx) => {
    // Every field ref must belong to the SELECTED dataset's field menu.
    const allowed = byDataset[tile.dataset] ?? new Set<string>();
    for (const [ch, def] of Object.entries(tile.encoding)) {
      if (def?.field && !allowed.has(def.field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["encoding", ch, "field"], message: `field "${def.field}" is not in dataset "${tile.dataset}"` });
      }
    }
    tile.transform?.forEach((t, i) => {
      if (!allowed.has(t.filter.field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transform", i, "filter", "field"], message: `field "${t.filter.field}" is not in dataset "${tile.dataset}"` });
      }
    });
  });
}
export type TileIR = z.infer<ReturnType<typeof tileIRSchema>>;

/** The column in each dataset that joins a row back to a graph node id. Cross-filter and
 *  node→chat context both key off this, so it is a property of the BINDING, not a choice
 *  the model gets to make. */
export const NODE_KEY: Record<GenerativeTile["dataset"], string> = {
  cited: "id", // one row per node
  metrics: "nodeId", // tidy-long: one row per numeric attribute of a node
  edges: "source", // an edge row is anchored on its source node
};

/** Context the SERVER (never the model) supplies so a compiled tile can carry its
 *  own lineage: which cited nodes the dataset was bound from, and how many rows it
 *  held at compose time. */
export interface CompileContext {
  nodeIds: string[];
  rowCount: number;
}

/**
 * The fields a point selection projects onto: the tile's DIMENSION fields — every encoded
 * field that is not itself an aggregate.
 *
 * Projecting straight onto the node key does not work, and this was found the hard way: most
 * composed tiles are aggregated (a bar of `count` by `kind`), and an aggregated mark's tuple
 * has no `id`/`nodeId` column at all — it represents a GROUP of nodes. A selection projected
 * onto the node key therefore matched nothing and clicking a bar did nothing.
 *
 * Projecting onto the dimensions instead ("kind = Drug") is both resolvable and what the user
 * means: the client maps the selected dimension values back to node ids through the bound rows
 * (`selectedIds` in web/src/generative/VegaTile.tsx). Falls back to the node key for a tile with
 * no dimensions at all (a bare aggregate), where there is nothing else to project onto.
 */
function selectionFields(ir: TileIR): string[] {
  const dims = new Set<string>();
  for (const [channel, def] of Object.entries(ir.encoding)) {
    if (!def?.field || def.aggregate || channel === "tooltip") continue;
    dims.add(def.field);
  }
  return dims.size ? [...dims] : [NODE_KEY[ir.dataset]];
}

/** The field names a tile actually reads — encoding channels plus transform
 *  filters, de-duplicated, in a stable order. Derived from the IR, so it can
 *  never name a field the schema did not already validate. */
function fieldsUsed(ir: TileIR): string[] {
  const seen = new Set<string>();
  for (const def of Object.values(ir.encoding)) if (def?.field) seen.add(def.field);
  for (const t of ir.transform ?? []) seen.add(t.filter.field);
  return Array.from(seen);
}

/** Trusted compiler: IR → constrained VL fragment. The output contains ONLY
 *  keys this function writes — usermeta/expr/href/on are unrepresentable. */
export function compileTile(ir: TileIR, id: string, ctx?: CompileContext): GenerativeTile {
  const vlSkeleton: Record<string, unknown> = {
    title: ir.title,
    data: { name: ir.dataset },
    mark: ir.mark,
    encoding: Object.fromEntries(Object.entries(ir.encoding).filter(([, v]) => v).map(([ch, def]) => [ch, {
      ...(def!.field ? { field: def!.field } : {}),
      ...(def!.type ? { type: def!.type } : {}),
      ...(def!.aggregate ? { aggregate: def!.aggregate } : {}),
      ...(def!.bin ? { bin: true } : {}),
    }])),
  };
  if (ir.transform?.length) {
    vlSkeleton.transform = ir.transform.map((t) => ({
      filter: { field: t.filter.field, [OPS[t.filter.op]]: t.filter.value },
    }));
  }
  // Selection is HOST-OWNED, like `config` — not a model choice.
  //
  // It used to be an optional IR field, and in practice the model never emitted it: across a
  // live board, zero of four tiles declared `params`, so the cross-filter was unreachable and
  // clicking a mark did nothing. Worse, a model-authored param carries no field projection, so
  // even when present the client could not tell WHICH node was picked.
  //
  // The compiler therefore always emits exactly one point selection, projected onto the
  // dataset's node key. That makes cross-filter a property of the lane rather than a coin-flip,
  // and it removes a model degree of freedom (the model can no longer name a signal at all).
  vlSkeleton.params = [{ name: "picked", select: { type: "point", fields: selectionFields(ir) } }];
  return {
    id,
    title: ir.title,
    vlSkeleton,
    dataset: ir.dataset,
    status: "exploratory",
    ...(ir.rationale ? { rationale: ir.rationale } : {}),
    provenance: {
      nodeIds: ctx?.nodeIds ?? [],
      fields: fieldsUsed(ir),
      rowCount: ctx?.rowCount ?? 0,
    },
  };
}
