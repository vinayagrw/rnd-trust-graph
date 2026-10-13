/**
 * Saved-dashboards store (Feature 10 — publish / save / share).
 *
 * A small, file-backed JSON store that persists chat-composed dashboards so a user
 * can SAVE a board and re-open it later. It MIRRORS `ask/threadStore.ts`: cache +
 * disk-sig, Zod-validated on read AND write, gitignore-safe, hot-reloadable.
 *
 * TRUST BOUNDARY (non-negotiable): this store holds the INERT `DashboardSpec` plus
 * the TRUSTED `DashboardAudit` that rode alongside it — nothing else. It NEVER
 * touches Neo4j, runs no Cypher, and writes NO graph triples. The persisted spec is
 * re-validated by the SAME grounding schema (`dashboardSpecSchema`) used at compose
 * time, so a saved board is still structurally inert and grounded (every
 * `widget.nodeIds` ⊆ `citedNodeIds`) — persisting it can never fabricate a citation
 * or smuggle a value/URL/markup. HITL/approval affordances remain host-chrome only;
 * they are not expressible in a spec, so a saved board can never carry one.
 *
 * Storage model (matches threadStore.ts):
 *   bff/dashboards.json  ->  { dashboards: { [id]: SavedDashboard } }
 * Created on first write; deleting it just empties the saved set (no crash).
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SavedDashboard } from "@rnd/shared";
import { dashboardSpecSchema } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted dashboards live at bff/dashboards.json (gitignore-safe, created on
 *  first write). Overridable via DASHBOARDS_STORE_PATH so tests use a scratch file. */
export const DASHBOARDS_STORE_PATH =
  process.env.DASHBOARDS_STORE_PATH ?? join(here, "../../dashboards.json");

// --- Schema ----------------------------------------------------------------
// The audit is TRUSTED metadata (computed by the BFF at compose time); we validate
// its shape loosely — it carries no answer content and no grounding root.
const auditSchema = z
  .object({
    model: z.string().max(120).optional(),
    estimated: z.boolean().optional(),
    faithfulnessScore: z.number().optional(),
    faithfulnessBand: z.string().max(40).optional(),
    verifiedQueryIds: z.array(z.string()).default([]),
    certifiedCount: z.number().default(0),
  })
  .strict();

const savedRecordSchema = z
  .object({
    id: z.string().min(1).max(96),
    title: z.string().min(1).max(200),
    // Re-validate the spec with the FULL grounding schema — a persisted board must
    // stay inert + grounded (widget.nodeIds ⊆ citedNodeIds), never just any object.
    spec: dashboardSpecSchema,
    audit: auditSchema.optional(),
    savedAt: z.number(),
    updatedAt: z.number(),
    savedBy: z.string().max(120).optional(),
  })
  .strict();

const storeSchema = z
  .object({ dashboards: z.record(z.string(), savedRecordSchema).default({}) })
  .strict();
type Store = z.infer<typeof storeSchema>;

/** Body accepted by save() — the client-supplied fields. id/savedAt are owned by
 *  the store (id may be supplied to overwrite an existing board). */
export const saveDashboardSchema = z
  .object({
    id: z.string().min(1).max(96).regex(/^[A-Za-z0-9_-]+$/).optional(),
    title: z.string().min(1).max(200),
    spec: dashboardSpecSchema,
    audit: auditSchema.optional(),
    savedBy: z.string().max(120).optional(),
  })
  .strict();
export type SaveDashboardBody = z.infer<typeof saveDashboardSchema>;

// --- Cache + load/persist (mirrors threadStore.ts) --------------------------
let cache: Store | null = null;
let cacheSig: string | null = null;

function diskSig(): string {
  if (!existsSync(DASHBOARDS_STORE_PATH)) return "";
  try {
    const s = statSync(DASHBOARDS_STORE_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

function load(): Store {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: Store = { dashboards: {} };
  if (sig !== "") {
    try {
      parsed = storeSchema.parse(JSON.parse(readFileSync(DASHBOARDS_STORE_PATH, "utf-8")));
    } catch {
      parsed = { dashboards: {} };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: Store): void {
  writeFileSync(DASHBOARDS_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

// --- Public API -------------------------------------------------------------

/** Saved-dashboard list — newest first, WITHOUT the heavy spec/audit payloads. */
export function listDashboards(): Array<{
  id: string;
  title: string;
  savedAt: number;
  updatedAt: number;
  widgetCount: number;
  savedBy?: string;
}> {
  const { dashboards } = load();
  return Object.values(dashboards)
    .map((d) => ({
      id: d.id,
      title: d.title,
      savedAt: d.savedAt,
      updatedAt: d.updatedAt,
      widgetCount: d.spec.widgets.length,
      savedBy: d.savedBy,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Full saved dashboard (spec + audit) for re-open, or null. */
export function getDashboard(id: string): SavedDashboard | null {
  return (load().dashboards[id] as SavedDashboard | undefined) ?? null;
}

/**
 * Upsert a saved dashboard. Returns the stored record. savedAt is preserved across
 * saves; updatedAt refreshes. The spec is re-validated by the grounding schema (a
 * ZodError → 400 upstream), so an ungrounded/tampered board is rejected.
 */
export function saveDashboard(body: SaveDashboardBody): SavedDashboard {
  const store = load();
  const id = body.id ?? randomUUID();
  const now = Date.now();
  const existing = store.dashboards[id];
  const record = savedRecordSchema.parse({
    id,
    title: body.title,
    spec: body.spec,
    audit: body.audit,
    savedAt: existing?.savedAt ?? now,
    updatedAt: now,
    savedBy: body.savedBy ?? existing?.savedBy,
  });
  persist({ dashboards: { ...store.dashboards, [id]: record } });
  return record as SavedDashboard;
}

/** Delete a saved dashboard. Returns true if it existed. */
export function deleteDashboard(id: string): boolean {
  const store = load();
  if (!store.dashboards[id]) return false;
  const { [id]: _removed, ...rest } = store.dashboards;
  persist({ dashboards: rest });
  return true;
}

/** Test hook: drop the cache so the next read re-reads disk. */
export function invalidateDashboardStoreCache(): void {
  cache = null;
  cacheSig = null;
}
