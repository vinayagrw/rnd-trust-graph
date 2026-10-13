/**
 * Conversation thread store (Phase 5 — persistence/restore for Beat 4).
 *
 * A small, file-backed JSON store that persists Beat-4 conversations so a user
 * can RELOAD the page or SWITCH threads and get the exact same chat back —
 * messages PLUS the per-turn grounding state (citedNodeIds / isFallback) that
 * drives the citation chips and the companion-canvas highlight.
 *
 * TRUST BOUNDARY (non-negotiable): this store holds CONVERSATION HISTORY ONLY.
 * It NEVER touches Neo4j, never runs Cypher, and never weakens the read-only /
 * grounding guarantees. Grounding stays 100% server-side in the untouched
 * `askGraph` agent and the `/api/agui` bridge — those are not modified. This is
 * a separate concern layered AROUND the grounded bridge: the bridge still does
 * all the grounding; this store merely records what the bridge already produced
 * so it survives a reload. A thread's citedNodeIds were produced by the grounded
 * bridge on the live turn; persisting/replaying them cannot fabricate citations
 * (they can only ever be ids the grounded agent itself emitted).
 *
 * Storage model (byte-simple, matches the adminConfig.ts pattern):
 *   bff/threads.json  ->  { threads: { [threadId]: ThreadRecord } }
 * Created on first write; deleting it just empties the history (no crash).
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted threads live at bff/threads.json (gitignore-safe, created on first
 *  write). Overridable via THREADS_STORE_PATH so tests use a scratch file. */
export const THREADS_STORE_PATH =
  process.env.THREADS_STORE_PATH ?? join(here, "../../threads.json");

// --- Schema ----------------------------------------------------------------
// A persisted message: we keep CopilotKit/AG-UI message shape loosely (id, role,
// content, optional toolCalls) so it round-trips into `agent.setMessages`.
// `.passthrough()` keeps any extra fields (e.g. generativeUI metadata) intact.
const messageSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    content: z.string().optional(),
  })
  .passthrough();

/** Grounding state for a thread — exactly the shape the bridge publishes as the
 *  STATE_SNAPSHOT the canvas reads. Persisted so chips/highlight restore. */
const groundingSchema = z
  .object({
    citedNodeIds: z.array(z.string()).default([]),
    isFallback: z.boolean().default(false),
  })
  .strict();

const threadRecordSchema = z
  .object({
    threadId: z.string(),
    title: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    messages: z.array(messageSchema).default([]),
    grounding: groundingSchema.default({ citedNodeIds: [], isFallback: false }),
  })
  .strict();

export type ThreadRecord = z.infer<typeof threadRecordSchema>;
export type Grounding = z.infer<typeof groundingSchema>;

const storeSchema = z
  .object({ threads: z.record(z.string(), threadRecordSchema).default({}) })
  .strict();
type Store = z.infer<typeof storeSchema>;

/** Body accepted by PUT /api/threads/:id — a full snapshot of one conversation.
 *  threadId/createdAt are owned by the store, so they are not accepted here. */
export const saveThreadSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    messages: z.array(messageSchema).max(1000).default([]),
    grounding: groundingSchema.default({ citedNodeIds: [], isFallback: false }),
  })
  .strict();
export type SaveThreadBody = z.infer<typeof saveThreadSchema>;

// --- Cache + load/persist (mirrors adminConfig.ts) -------------------------
let cache: Store | null = null;
let cacheSig: string | null = null;

function diskSig(): string {
  if (!existsSync(THREADS_STORE_PATH)) return "";
  try {
    const s = statSync(THREADS_STORE_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Effective store, read at request time; re-reads when the file changes on
 *  disk so an external edit/deletion is picked up without a restart. A missing
 *  or corrupt file → an empty store (never throws, never blanks the demo). */
function load(): Store {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: Store = { threads: {} };
  if (sig !== "") {
    try {
      parsed = storeSchema.parse(JSON.parse(readFileSync(THREADS_STORE_PATH, "utf-8")));
    } catch {
      parsed = { threads: {} };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: Store): void {
  writeFileSync(THREADS_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

/** Derive a short human title from the first user message, else a timestamp. */
function deriveTitle(messages: SaveThreadBody["messages"]): string {
  const firstUser = messages.find((m) => m.role === "user" && typeof m.content === "string");
  const text = (firstUser?.content ?? "").trim();
  if (text) return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return `Conversation ${new Date().toLocaleString()}`;
}

/** A thread is "real" once it has at least one non-empty user turn. A brand-new
 *  thread with only assistant/empty messages is BLANK and must never be persisted
 *  — that is what produced the wall of empty "Conversation <timestamp>" rows. */
function hasRealUserTurn(messages: SaveThreadBody["messages"]): boolean {
  return messages.some(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0
  );
}

// --- Public API (used by the routes) ---------------------------------------

/** Thread list for the switcher — newest first, without the heavy messages. */
export function listThreads(): Array<{
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}> {
  const { threads } = load();
  return Object.values(threads)
    .map((t) => ({
      threadId: t.threadId,
      title: t.title,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      messageCount: t.messages.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

/** Full thread record (messages + grounding) for restore, or null. */
export function getThread(threadId: string): ThreadRecord | null {
  return load().threads[threadId] ?? null;
}

/**
 * Upsert a thread's full snapshot (messages + grounding). Returns the record.
 * createdAt is preserved across saves; updatedAt + title refresh.
 *
 * A brand-new thread with no real user turn is NOT written to disk (a transient
 * record is returned so callers still get a shape). This is the definitive guard
 * against blank "Conversation <timestamp>" rows — no matter which caller (a run
 * that finalized without a user message, the POST route, etc.). An EXISTING
 * thread still updates normally, so nothing an established conversation does is lost.
 */
/**
 * Strictly-increasing wall-clock stamp. `Date.now()` alone is not enough: two
 * turns saved inside the same millisecond tie on `updatedAt`, `listThreads`'s
 * comparator returns 0, and the newest-first order then falls back to whatever
 * key order `persist` happened to write — which is not creation order. Clamping
 * to `last + 1` keeps the ordering total without changing the stored shape.
 */
let lastStamp = 0;
function nextStamp(): number {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return lastStamp;
}

export function saveThread(threadId: string, body: SaveThreadBody): ThreadRecord {
  const store = load();
  const now = nextStamp();
  const existing = store.threads[threadId];
  const record: ThreadRecord = threadRecordSchema.parse({
    threadId,
    title: body.title?.trim() || existing?.title || deriveTitle(body.messages),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    messages: body.messages,
    grounding: body.grounding,
  });
  if (!existing && !hasRealUserTurn(body.messages)) {
    return record; // transient: a blank new thread never lands on disk
  }
  persist({ threads: { ...store.threads, [threadId]: record } });
  return record;
}

/** Mint a new thread id + title. NOTE: nothing is persisted until the thread has
 *  a real user turn (see `saveThread`), so a created-but-unused thread never shows
 *  up in the list as a blank. */
export function createThread(title?: string): ThreadRecord {
  return saveThread(randomUUID(), {
    title: title?.trim() || `Conversation ${new Date().toLocaleString()}`,
    messages: [],
    grounding: { citedNodeIds: [], isFallback: false },
  });
}

/** Delete a thread. Returns true if it existed. */
export function deleteThread(threadId: string): boolean {
  const store = load();
  if (!store.threads[threadId]) return false;
  const { [threadId]: _removed, ...rest } = store.threads;
  persist({ threads: rest });
  return true;
}

/** Test hook: drop the cache so the next read re-reads disk. */
export function invalidateThreadCache(): void {
  cache = null;
  cacheSig = null;
}
