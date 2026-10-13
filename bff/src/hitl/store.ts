/**
 * HITL change-set store (apply / revert + file-backed persistence).
 *
 * Mirrors the threads.json / finops-ledger.json pattern: a small JSON file
 * (bff/hitl-changesets.json, gitignored) holding the ordered audit log of every
 * governed mutation. Overridable via HITL_CHANGESETS_PATH so tests use a scratch
 * file. Created on first apply; deleting it just empties the audit log.
 *
 * Persistence ALSO rebuilds the runtime flag overlay: on load, every APPLIED
 * changeset's setFlagResolved ops are replayed into overlay.ts so the suppressed
 * flags survive a BFF restart (the overlay is a pure projection of applied
 * changesets). Data ops (edges/props/provenance) are NOT replayed on load — they
 * already live durably in Neo4j + the RDF store from when they were applied.
 *
 * TRUST BOUNDARY: every mutation goes through ops.ts → the AUTHORIZED writer
 * (Neo4j write() + reasoner.update()). This store never touches the read-only
 * agent/MCP path. It is observability + governance over writes that were already
 * authorized, not a new write surface.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ChangeSet,
  ChangeOp,
  HitlPendingItem,
  ReviewerIdentity,
  ReviewPurpose,
} from "@rnd/shared";
import { applyOps } from "./ops.js";
import {
  markFlagResolved,
  markManualFlag,
  clearManualFlag,
  markEdgeTag,
  clearEdgeTag,
  resetOverlay,
} from "./overlay.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Audit log path; HITL_CHANGESETS_PATH lets tests point at a scratch file. */
export const HITL_CHANGESETS_PATH =
  process.env.HITL_CHANGESETS_PATH ?? join(here, "../../hitl-changesets.json");

interface StoreShape {
  changeSets: ChangeSet[];
}

let cache: StoreShape | null = null;
let cacheSig: string | null = null;
let overlayBuiltFor: string | null = null;

function diskSig(): string {
  if (!existsSync(HITL_CHANGESETS_PATH)) return "";
  try {
    const s = statSync(HITL_CHANGESETS_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Rebuild the runtime flag overlay from the applied changesets (idempotent). */
function rebuildOverlay(store: StoreShape, sig: string): void {
  if (overlayBuiltFor === sig) return;
  resetOverlay();
  for (const cs of store.changeSets) {
    if (cs.status !== "applied") continue;
    for (const op of cs.forwardOps) {
      if (op.op === "setFlagResolved") markFlagResolved(op.nodeId, op.flag);
      // Manual flags replay BOTH directions in applied-changeset order, so a later
      // "unflag" changeset (forward removeManualFlag) correctly cancels an earlier
      // add on restart — the net overlay matches the live one.
      else if (op.op === "addManualFlag") markManualFlag(op.nodeId, op.flag, op.reason);
      else if (op.op === "removeManualFlag") clearManualFlag(op.nodeId, op.flag);
      // Edge tags replay both directions in applied order too (same rationale as
      // manual flags): the additive overlay is a pure projection of the applied
      // changesets, so tags survive a BFF restart and a later untag cancels an
      // earlier tag. WITHOUT this, persist()'s post-apply rebuildOverlay wipes a
      // just-applied edge tag (resetOverlay clears it, the replay never re-adds it).
      else if (op.op === "addEdgeTag") markEdgeTag(op.source, op.kind, op.target, op.tag, op.reason);
      else if (op.op === "removeEdgeTag") clearEdgeTag(op.source, op.kind, op.target, op.tag);
    }
  }
  overlayBuiltFor = sig;
}

/** Load the audit log, re-reading on disk change; rebuilds the overlay to match. */
function load(): StoreShape {
  const sig = diskSig();
  if (cache && sig === cacheSig) {
    rebuildOverlay(cache, sig);
    return cache;
  }
  let parsed: StoreShape = { changeSets: [] };
  if (sig !== "") {
    try {
      const raw = JSON.parse(readFileSync(HITL_CHANGESETS_PATH, "utf-8"));
      if (raw && Array.isArray(raw.changeSets)) parsed = { changeSets: raw.changeSets };
    } catch {
      parsed = { changeSets: [] };
    }
  }
  cache = parsed;
  cacheSig = sig;
  rebuildOverlay(parsed, sig);
  return cache;
}

function persist(store: StoreShape): void {
  writeFileSync(HITL_CHANGESETS_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
  overlayBuiltFor = null; // force overlay rebuild against the new signature
  rebuildOverlay(store, cacheSig);
}

/** The full audit log (newest first), for GET /api/hitl/changesets. */
export function listChangeSets(): ChangeSet[] {
  return [...load().changeSets].sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Pending-item ids that currently have an APPLIED (not reverted) change set, so
 *  the pending queue can hide them — approving an item should remove it from the
 *  queue, and reverting its change set should bring it back. Derived purely from
 *  the audit log. */
export function appliedItemIds(): Set<string> {
  const ids = new Set<string>();
  for (const cs of load().changeSets) {
    if (cs.status === "applied" && cs.itemId) ids.add(cs.itemId);
  }
  return ids;
}

/** Node ids that carry at least one APPLIED (not reverted) governed change set —
 *  i.e. a human reviewer approved a change about that node. Surfaced as a
 *  "human-reviewed" trust stamp on the canvas (the green check), so approving ANY
 *  governed item — not only the ones that add a HUMAN_APPROVED edge — visibly
 *  marks the node as reviewed. Reverting the change set clears the stamp. */
export function humanReviewedNodeIds(): Set<string> {
  const ids = new Set<string>();
  for (const cs of load().changeSets) {
    if (cs.status === "applied" && cs.targetNodeId) ids.add(cs.targetNodeId);
  }
  return ids;
}

/** Create + apply a change set from an approved pending item. Mutates BOTH
 *  projections via the authorized writer, then records the audit entry. */
export async function apply(item: {
  title: string;
  description: string;
  targetNodeId?: string;
  /** Originating pending-item id, when approving a queue item — recorded on the
   *  change set so the queue can hide an applied item (and resurface on revert). */
  itemId?: string;
  forwardOps: ChangeOp[];
  inverseOps: ChangeOp[];
  actor?: string;
  /** Structured reviewer identity + stated purpose (F6). Audit metadata only —
   *  never part of the op replay, so revert stays byte-identical. */
  reviewer?: ReviewerIdentity;
  purpose?: ReviewPurpose;
}): Promise<ChangeSet> {
  await applyOps(item.forwardOps);
  const changeSet: ChangeSet = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    // Keep the legacy `actor` string in lock-step with the structured reviewer
    // (name) so existing audit views keep working; default unchanged.
    actor: item.reviewer?.name ?? item.actor ?? "demo-reviewer",
    reviewer: item.reviewer,
    purpose: item.purpose,
    title: item.title,
    description: item.description,
    targetNodeId: item.targetNodeId,
    itemId: item.itemId,
    forwardOps: item.forwardOps,
    inverseOps: item.inverseOps,
    status: "applied",
  };
  const store = load();
  persist({ changeSets: [...store.changeSets, changeSet] });
  return changeSet;
}

/** Revert an applied change set: replay its inverse ops, mark it reverted. The
 *  inverse ops restore byte-identical prior state on BOTH projections + overlay. */
export async function revert(changeSetId: string): Promise<ChangeSet | null> {
  const store = load();
  const cs = store.changeSets.find((c) => c.id === changeSetId);
  if (!cs) return null;
  if (cs.status === "reverted") return cs; // idempotent — already undone
  await applyOps(cs.inverseOps);
  const reverted: ChangeSet = { ...cs, status: "reverted" };
  persist({
    changeSets: store.changeSets.map((c) => (c.id === changeSetId ? reverted : c)),
  });
  return reverted;
}

/** Test/boot hook: re-read disk + rebuild the overlay from applied changesets. */
export function refreshFromDisk(): void {
  cache = null;
  cacheSig = null;
  overlayBuiltFor = null;
  load();
}

export type { HitlPendingItem };
