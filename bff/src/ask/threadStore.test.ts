/**
 * Thread-store unit tests (Phase 5 — Beat-4 persistence/restore).
 *
 * The persistence story rides on these:
 *  (a) a saved conversation ROUND-TRIPS — messages + grounding (citedNodeIds /
 *      isFallback) come back byte-identical, so chips + canvas highlight restore;
 *  (b) the list is newest-first and create/delete behave;
 *  (c) the snapshot schema REJECTS garbage (so a bad PUT can't persist junk);
 *  (d) TRUST: the store touches conversation history ONLY — it imports nothing
 *      from neo4j/agent/bridge, so it can never run Cypher or weaken grounding.
 *
 * Uses a scratch THREADS_STORE_PATH so it never touches a real bff/threads.json.
 * Run: `node --import tsx --test src/ask/threadStore.test.ts`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = join(tmpdir(), `rtg-threads-test-${process.pid}.json`);
process.env.THREADS_STORE_PATH = SCRATCH;

// Import AFTER setting the env var so the module picks up the scratch path.
const {
  listThreads,
  getThread,
  saveThread,
  createThread,
  deleteThread,
  saveThreadSchema,
  invalidateThreadCache,
  THREADS_STORE_PATH,
} = await import("./threadStore.js");

function cleanup() {
  if (existsSync(SCRATCH)) unlinkSync(SCRATCH);
  invalidateThreadCache();
}

before(() => assert.equal(THREADS_STORE_PATH, SCRATCH, "must use scratch store"));
beforeEach(cleanup);
after(cleanup);

test("round-trips messages + grounding so chips and highlight restore", () => {
  const id = "thread-A";
  const messages = [
    { id: "m1", role: "user", content: "Which patients report myocarditis?" },
    { id: "m2", role: "assistant", content: "Six distinct patients report AE-MYOCARDITIS." },
  ];
  const grounding = { citedNodeIds: ["AE-MYOCARDITIS", "DRUG-CPI"], isFallback: false };

  saveThread(id, { messages, grounding });
  const got = getThread(id);

  assert.ok(got, "thread should exist after save");
  assert.deepEqual(got!.messages, messages, "messages round-trip exactly");
  assert.deepEqual(got!.grounding, grounding, "grounding (cited ids) round-trips → chips restore");
});

test("persists across a fresh read (simulated reload) by re-reading disk", () => {
  saveThread("thread-B", {
    messages: [{ id: "x", role: "user", content: "hi" }],
    grounding: { citedNodeIds: ["N1"], isFallback: false },
  });
  // Drop the in-memory cache → next read must come from disk, like a new process.
  invalidateThreadCache();
  const got = getThread("thread-B");
  assert.deepEqual(got!.grounding.citedNodeIds, ["N1"], "survives cache drop / reload");
  assert.ok(existsSync(SCRATCH), "store file is written to disk");
});

test("derives a title from the first user message", () => {
  const rec = saveThread("thread-C", {
    messages: [{ id: "1", role: "user", content: "What is the PRR for STAT-MYO-CPI?" }],
    grounding: { citedNodeIds: [], isFallback: false },
  });
  assert.equal(rec.title, "What is the PRR for STAT-MYO-CPI?");
});

test("a blank thread (no real user turn) is never persisted", () => {
  // createThread mints an id but has no user turn yet → nothing lands on disk.
  const blank = createThread("first");
  assert.equal(getThread(blank.threadId), null, "blank createThread is not stored");
  assert.deepEqual(listThreads(), [], "the list stays empty — no 'Conversation …' rows");
  // An assistant-only / whitespace-only save is also blank → not persisted.
  saveThread("thread-blank", {
    messages: [
      { id: "a", role: "assistant", content: "hello" },
      { id: "b", role: "user", content: "   " },
    ],
    grounding: { citedNodeIds: [], isFallback: false },
  });
  assert.equal(getThread("thread-blank"), null, "assistant/whitespace-only save is not stored");
});

test("list is newest-first and reflects create/delete", () => {
  const a = createThread("first");
  const b = createThread("second");
  // Blank threads don't persist — give each a real user turn (b first, then a) so
  // both land and `a` is the most-recently-updated.
  saveThread(b.threadId, {
    messages: [{ id: "1", role: "user", content: "b turn" }],
    grounding: { citedNodeIds: [], isFallback: false },
  });
  saveThread(a.threadId, {
    messages: [{ id: "1", role: "user", content: "a turn" }],
    grounding: { citedNodeIds: [], isFallback: false },
  });

  let list = listThreads();
  assert.equal(list.length, 2);
  assert.equal(list[0].threadId, a.threadId, "newest-updated first");
  assert.equal(list[0].messageCount, 1);

  assert.equal(deleteThread(b.threadId), true);
  assert.equal(deleteThread(b.threadId), false, "second delete is a no-op");
  list = listThreads();
  assert.equal(list.length, 1);
  assert.equal(list[0].threadId, a.threadId);
});

test("snapshot schema REJECTS garbage (a bad PUT cannot persist junk)", () => {
  // Unknown top-level key is rejected by .strict().
  assert.throws(() => saveThreadSchema.parse({ messages: [], evil: true }));
  // Message missing required id/role is rejected.
  assert.throws(() => saveThreadSchema.parse({ messages: [{ content: "no id/role" }] }));
  // Grounding with a non-array citedNodeIds is rejected.
  assert.throws(() =>
    saveThreadSchema.parse({ messages: [], grounding: { citedNodeIds: "nope", isFallback: false } })
  );
});

test("a missing store file yields an empty list (never throws)", () => {
  cleanup();
  assert.deepEqual(listThreads(), []);
  assert.equal(getThread("does-not-exist"), null);
});

test("TRUST: stored file contains only history, no graph credentials/queries", () => {
  saveThread("thread-D", {
    messages: [{ id: "1", role: "user", content: "hi" }],
    grounding: { citedNodeIds: ["N1"], isFallback: false },
  });
  const raw = readFileSync(SCRATCH, "utf-8");
  // Sanity: the persisted blob is plain conversation history; it must not carry
  // a Neo4j connection secret or a Cypher write clause. (Matched as whole words
  // so our own camelCase field names like `createdAt` don't false-positive.)
  assert.doesNotMatch(raw, /\b(MERGE|DETACH)\b|bolt:\/\/|neo4j:\/\/|password/i);
  // The store module must not import the graph layer at all (compile-time trust):
  const mod = readFileSync(join(import.meta.dirname, "threadStore.ts"), "utf-8");
  assert.doesNotMatch(mod, /from ["']\.\.\/(neo4j|graph)|from ["']\.\/(agent|aguiBridge|enforced)/);
});
