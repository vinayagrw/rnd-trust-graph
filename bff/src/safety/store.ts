/**
 * Safety corrective change store — the governed apply/revert log for UC4
 * corrections, isolated from the FAIR HITL store (hitl/store.ts).
 *
 * A correction is applied by the authorized safety-writer (safety/ops.ts) over the
 * safety reasoner + the `:Safety` Neo4j projection, then recorded here with its
 * exact inverse so it is fully reversible. Each apply/revert also writes a forced
 * trend snapshot (history.ts), so the readiness line bends when a finding clears.
 *
 * Persistence mirrors the hitl-changesets.json / threads.json pattern (a small
 * gitignored JSON file, SAFETY_CHANGESETS_PATH-overridable for tests). On load,
 * the applied (not reverted) corrections are REPLAYED into the safety reasoner so
 * the in-memory graph stays consistent with the log across a BFF restart.
 *
 * TRUST: writes go only through the authorized safety-writer; the read-only
 * agent/MCP path and the FAIR canvas are untouched. Reverting restores
 * byte-identical prior state.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SafetyChangeOp, SafetyFinding } from "@rnd/shared";
import { applySafetyOps, applySafetyReasonerOps } from "./ops.js";
import { getSafetyReport } from "./service.js";
import { captureSnapshot } from "./history.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SAFETY_CHANGESETS_PATH =
  process.env.SAFETY_CHANGESETS_PATH ?? join(here, "../../safety-changesets.json");

/** One recorded corrective change set. */
export interface SafetyChangeSet {
  id: string;
  ts: string;
  findingId: string;
  subjectId: string;
  title: string;
  forwardOps: SafetyChangeOp[];
  inverseOps: SafetyChangeOp[];
  status: "applied" | "reverted";
}

interface StoreShape {
  changeSets: SafetyChangeSet[];
}

let cache: StoreShape | null = null;
let cacheSig: string | null = null;
let replayedFor: string | null = null;

function diskSig(): string {
  if (!existsSync(SAFETY_CHANGESETS_PATH)) return "";
  try {
    const s = statSync(SAFETY_CHANGESETS_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

function readStore(): StoreShape {
  const sig = diskSig();
  if (cache && sig === cacheSig) return cache;
  let parsed: StoreShape = { changeSets: [] };
  if (sig !== "") {
    try {
      const raw = JSON.parse(readFileSync(SAFETY_CHANGESETS_PATH, "utf-8"));
      if (raw && Array.isArray(raw.changeSets)) parsed = { changeSets: raw.changeSets };
    } catch {
      parsed = { changeSets: [] };
    }
  }
  cache = parsed;
  cacheSig = sig;
  return cache;
}

function persist(store: StoreShape): void {
  writeFileSync(SAFETY_CHANGESETS_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
  cacheSig = diskSig();
}

/**
 * Replay the applied (not reverted) corrections into the safety reasoner once, so
 * a restarted BFF's in-memory graph matches the log (Neo4j already holds the
 * mirror). Reasoner-only replay — idempotent per disk signature.
 */
async function ensureReplayed(): Promise<void> {
  const store = readStore();
  if (replayedFor === cacheSig) return;
  const ops = store.changeSets
    .filter((c) => c.status === "applied")
    .flatMap((c) => c.forwardOps);
  if (ops.length) await applySafetyReasonerOps(ops);
  replayedFor = cacheSig;
}

/** Finding ids that currently have an APPLIED (not reverted) correction. */
export async function appliedFindingIds(): Promise<Set<string>> {
  await ensureReplayed();
  const ids = new Set<string>();
  for (const cs of readStore().changeSets) {
    if (cs.status === "applied") ids.add(cs.findingId);
  }
  return ids;
}

/** The full corrective audit log (newest first). */
export async function listSafetyChangeSets(): Promise<SafetyChangeSet[]> {
  await ensureReplayed();
  return [...readStore().changeSets].sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Deterministic snapshot after an apply/revert — reads the fresh score + writes a
 *  forced trend point annotated with what moved it. Best-effort. */
async function snapshotAfter(note: string): Promise<void> {
  try {
    const r = await getSafetyReport();
    await captureSnapshot(
      {
        overall: r.overall,
        weightedIndex: r.weightedIndex,
        assessed: r.subjectsAssessed,
        unsafe: r.subjectsAssessed - Math.round((r.overall * r.subjectsAssessed) / 100),
        note,
      },
      { dedupeByMinute: false },
    );
  } catch {
    /* snapshot is best-effort — never fail the apply/revert on it */
  }
}

/**
 * Apply a finding's corrective change set. Mutates the safety substrate via the
 * authorized writer, records the reversible change set, and writes a trend point.
 * Idempotent: re-applying an already-applied finding is a no-op.
 */
export async function applyCorrection(finding: SafetyFinding): Promise<SafetyChangeSet | null> {
  await ensureReplayed();
  const store = readStore();
  const existing = store.changeSets.find(
    (c) => c.findingId === finding.id && c.status === "applied",
  );
  if (existing) return existing;
  if (!finding.correction.forwardOps.length) return null; // nothing to correct

  await applySafetyOps(finding.correction.forwardOps);
  const cs: SafetyChangeSet = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    findingId: finding.id,
    subjectId: finding.subjectId,
    title: `Correct: ${finding.riskType} (${finding.affectedSubjects.join(" + ")})`,
    forwardOps: finding.correction.forwardOps,
    inverseOps: finding.correction.inverseOps,
    status: "applied",
  };
  persist({ changeSets: [...store.changeSets, cs] });
  await snapshotAfter(`corrected ${finding.subjectId} · ${finding.riskType}`);
  return cs;
}

/** Revert an applied correction by finding id: replay its inverse ops, mark
 *  reverted, and write a trend point. Idempotent. */
export async function revertCorrection(findingId: string): Promise<SafetyChangeSet | null> {
  await ensureReplayed();
  const store = readStore();
  const cs = store.changeSets.find((c) => c.findingId === findingId && c.status === "applied");
  if (!cs) return null;
  await applySafetyOps(cs.inverseOps);
  const reverted: SafetyChangeSet = { ...cs, status: "reverted" };
  persist({
    changeSets: store.changeSets.map((c) => (c.id === cs.id ? reverted : c)),
  });
  await snapshotAfter(`reverted ${cs.subjectId} · ${findingId}`);
  return reverted;
}

/** Test hook: drop the in-memory cache + replay guard so the next call re-reads. */
export function resetSafetyStoreCache(): void {
  cache = null;
  cacheSig = null;
  replayedFor = null;
}
