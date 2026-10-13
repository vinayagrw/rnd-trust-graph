/**
 * Custom-playbook store — persistence for USER-AUTHORED safety-dossier playbooks
 * (the AI-assisted "create a playbook" feature). A small, file-backed JSON store
 * that mirrors `ask/threadStore.ts` byte-for-byte in structure: cache + disk-sig,
 * Zod-validated on read AND write, gitignore-safe, hot-reloadable.
 *
 * TRUST BOUNDARY (non-negotiable): a playbook is pure ORCHESTRATION CONFIG — an
 * ordered list of questions/prompts. This store holds config ONLY. It NEVER
 * touches Neo4j, never runs Cypher, never weakens the read-only / grounding
 * guarantees. Each `ask` step's question is later handed to the UNCHANGED
 * grounded agent, which still refuses off-graph on its own; so a saved playbook
 * can never fabricate an answer or a citation — it can only ask.
 *
 * The stored strings are treated as UNTRUSTED input to that downstream agent
 * (OWASP LLM01/LLM05): they are sanitized + length-capped here on write and
 * re-validated on read, and step `kind` is enum-locked so authored content can
 * never introduce a new step type or a write path.
 *
 * This module is deliberately IGNORANT of the curated playbooks — curated-id
 * collision + immutability are enforced one layer up in `definitions.ts`, which
 * keeps this store a dumb persistence sink and avoids an import cycle.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Playbook } from "@rnd/shared";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted custom playbooks live at bff/playbooks-custom.json (gitignore-safe,
 *  created on first write). Overridable via PLAYBOOKS_STORE_PATH so tests use a
 *  scratch file. */
export const PLAYBOOKS_STORE_PATH =
  process.env.PLAYBOOKS_STORE_PATH ?? join(here, "../../playbooks-custom.json");

// --- Sanitization ----------------------------------------------------------
/** Replace control chars (codepoint < 0x20, plus DEL 0x7F) with a space,
 *  collapse runs of whitespace, trim, and hard-cap length. Written as a
 *  codepoint loop (no control-char regex literal) so nothing weird survives
 *  into stored config or the downstream grounded agent. */
function clean(max: number) {
  return (s: string): string => {
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0) ?? 0;
      out += code < 0x20 || code === 0x7f ? " " : ch;
    }
    return out.replace(/[ \t]+/g, " ").trim().slice(0, max);
  };
}

// --- Schema ----------------------------------------------------------------
const stepSchema = z
  .object({
    id: z.string().min(1).max(64).transform(clean(64)),
    kind: z.enum(["ask", "checkpoint", "synth"]),
    title: z.string().min(1).max(120).transform(clean(120)),
    question: z.string().max(600).transform(clean(600)).optional(),
    prompt: z.string().max(600).transform(clean(600)).optional(),
  })
  .strict()
  .refine(
    (s) =>
      (s.kind === "ask" && !!s.question) ||
      (s.kind === "checkpoint" && !!s.prompt) ||
      s.kind === "synth",
    { message: "ask steps require a question; checkpoint steps require a prompt" },
  );

/** The body accepted by createCustom/updateCustom — a full playbook definition
 *  minus store-owned fields (origin/timestamps are stamped here). Structural
 *  rules encode "a sensible dossier": at least one `ask`, and if a `synth`
 *  assembly step is present it must be last. */
export const customPlaybookSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "id must be kebab-case (a-z, 0-9, hyphen)"),
    title: z.string().min(1).max(120).transform(clean(120)),
    description: z.string().min(1).max(1000).transform(clean(1000)),
    steps: z.array(stepSchema).min(1).max(12),
  })
  .strict()
  .refine((p) => p.steps.some((s) => s.kind === "ask"), {
    message: "a playbook needs at least one ask step",
  })
  .refine(
    (p) => {
      const last = p.steps.findIndex((s) => s.kind === "synth");
      return last === -1 || last === p.steps.length - 1;
    },
    { message: "a synth (assemble) step, if present, must be the last step" },
  );

export type CustomPlaybookInput = z.infer<typeof customPlaybookSchema>;

/** A stored record = the validated definition + store-owned provenance. */
const recordSchema = customPlaybookSchema.and(
  z.object({
    origin: z.literal("custom"),
    createdBy: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  }),
);

const storeSchema = z
  .object({ playbooks: z.record(z.string(), recordSchema).default({}) })
  .strict();
type Store = z.infer<typeof storeSchema>;

// --- Cache + load/persist (mirrors threadStore.ts / adminConfig.ts) ---------
let cache: Store | null = null;
let cacheSig: string | null = null;

function diskSig(): string {
  if (!existsSync(PLAYBOOKS_STORE_PATH)) return "";
  try {
    const s = statSync(PLAYBOOKS_STORE_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Effective store, read at request time; re-reads when the file changes on disk
 *  so an external edit/deletion is picked up without a restart. A missing or
 *  corrupt file → an empty store (never throws, never blanks the demo). */
function load(): Store {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: Store = { playbooks: {} };
  if (sig !== "") {
    try {
      parsed = storeSchema.parse(JSON.parse(readFileSync(PLAYBOOKS_STORE_PATH, "utf-8")));
    } catch {
      parsed = { playbooks: {} };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: Store): void {
  writeFileSync(PLAYBOOKS_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

// --- Public API (used by definitions.ts orchestration) ----------------------

/** All custom playbooks, newest first. Typed as the shared `Playbook`. */
export function listCustom(): Playbook[] {
  const { playbooks } = load();
  return Object.values(playbooks).sort((a, b) => b.updatedAt - a.updatedAt) as Playbook[];
}

export function getCustom(id: string): Playbook | undefined {
  return load().playbooks[id] as Playbook | undefined;
}

export function hasCustom(id: string): boolean {
  return Boolean(load().playbooks[id]);
}

/** Validate + persist a NEW custom playbook. Throws ZodError on an invalid shape
 *  (the route maps that to a 400). Throws a plain Error if the id already exists. */
export function createCustom(input: unknown, createdBy?: string): Playbook {
  const def = customPlaybookSchema.parse(input);
  const store = load();
  if (store.playbooks[def.id]) throw new Error(`playbook id already exists: ${def.id}`);
  const now = Date.now();
  const record = recordSchema.parse({
    ...def,
    origin: "custom",
    createdBy,
    createdAt: now,
    updatedAt: now,
  });
  persist({ playbooks: { ...store.playbooks, [def.id]: record } });
  return record as Playbook;
}

/** Validate + persist an UPDATE to an existing custom playbook (id in the path
 *  wins; body id is overwritten to match). Preserves createdAt/createdBy. */
export function updateCustom(id: string, input: unknown, updatedBy?: string): Playbook {
  const def = customPlaybookSchema.parse({ ...(input as object), id });
  const store = load();
  const existing = store.playbooks[id];
  if (!existing) throw new Error(`unknown custom playbook: ${id}`);
  const record = recordSchema.parse({
    ...def,
    origin: "custom",
    createdBy: existing.createdBy ?? updatedBy,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  });
  persist({ playbooks: { ...store.playbooks, [id]: record } });
  return record as Playbook;
}

/** Delete a custom playbook. Returns true if it existed. */
export function deleteCustom(id: string): boolean {
  const store = load();
  if (!store.playbooks[id]) return false;
  const { [id]: _removed, ...rest } = store.playbooks;
  persist({ playbooks: rest });
  return true;
}

/** Test hook: drop the cache so the next read re-reads disk. */
export function invalidatePlaybookCache(): void {
  cache = null;
  cacheSig = null;
}
