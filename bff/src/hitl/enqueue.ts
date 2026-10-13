/**
 * HITL enqueue store — file-backed queue of human-review requests raised from a
 * grounded conclusion.
 *
 * Mirrors the file-backed idiom of store.ts (a small JSON file, gitignored,
 * path-overridable via env so tests use a scratch file). Created on first
 * enqueue; deleting it just empties the queue.
 *
 * IMPORTANT: an enqueued item is a REVIEW REQUEST, not a graph mutation. It
 * carries NO forward/inverse ops (`forwardOps: []`, `inverseOps: []`) — approving
 * it records a human review decision, it never mutates the graph. The authorized
 * writer (store.ts → ops.ts) is the only write surface; this store never touches
 * it and never touches the read-only agent/MCP path.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { HitlPendingItem } from "@rnd/shared";

const here = dirname(fileURLToPath(import.meta.url));
/** Enqueued-review-requests path; HITL_ENQUEUED_PATH lets tests use a scratch file. */
export const HITL_ENQUEUED_PATH =
  process.env.HITL_ENQUEUED_PATH ?? join(here, "../../hitl-enqueued.json");

interface StoreShape {
  items: HitlPendingItem[];
}

let cache: StoreShape | null = null;
let cacheSig: string | null = null;

function diskSig(): string {
  if (!existsSync(HITL_ENQUEUED_PATH)) return "";
  try {
    const s = statSync(HITL_ENQUEUED_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Load the queue, re-reading on disk change. Missing/parse-fail → empty queue. */
function load(): StoreShape {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: StoreShape = { items: [] };
  if (sig !== "") {
    try {
      const raw = JSON.parse(readFileSync(HITL_ENQUEUED_PATH, "utf-8"));
      if (raw && Array.isArray(raw.items)) parsed = { items: raw.items };
    } catch {
      parsed = { items: [] };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: StoreShape): void {
  writeFileSync(HITL_ENQUEUED_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

/** The enqueued review requests (insertion order), appended to the pending queue. */
export function getEnqueued(): HitlPendingItem[] {
  return [...load().items];
}

/** Persist a PRE-BUILT pending item into the queue (deduped by id — re-routing the
 *  same item is idempotent). Used by F2 to route an agent-drafted remediation into
 *  the same review queue. The item may carry ops or be ops-free; THIS store never
 *  applies them — the authorized writer (store.ts → ops.ts) does, on approval. */
export function enqueueItem(item: HitlPendingItem): HitlPendingItem {
  const store = load();
  const deduped = store.items.filter((i) => i.id !== item.id);
  persist({ items: [...deduped, item] });
  return item;
}

/** Build + persist a review request from a grounded conclusion. Carries NO graph
 *  ops — approving it records a human review decision only, never a mutation. */
export function enqueueFromConclusion(input: {
  summary: string;
  confidence?: number;
  citedNodeIds: string[];
}): HitlPendingItem {
  const item: HitlPendingItem = {
    id: `enq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: "Review: grounded conclusion",
    description: input.summary,
    effect: "Records a human review decision for this conclusion (no graph mutation).",
    targetNodeId: input.citedNodeIds[0],
    forwardOps: [],
    inverseOps: [],
  };
  const store = load();
  persist({ items: [...store.items, item] });
  return item;
}
