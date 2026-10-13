/**
 * Safety readiness TREND — an append-only score history persisted in Neo4j.
 *
 * Each snapshot is a `(:Safety:SafetyScoreSnapshot)` node. It carries BOTH the
 * `:Safety` marker (so the FAIR canvas `WHERE NOT n:Safety` already excludes it —
 * that query stays byte-identical, untouched) AND `:SafetyScoreSnapshot` (so the
 * safety canvas can exclude it too, and getTrend can find the series). A governed
 * correction / revert writes a forced point, so the readiness line bends exactly
 * when a finding is cleared — the payoff of the corrective loop.
 *
 * Neo4j-backed by design (matching the "real stack" stance): the trend survives a
 * restart and is queryable. Writes are best-effort at the call sites — a snapshot
 * failure never breaks a report read or a correction apply.
 */
import { randomUUID } from "node:crypto";
import type { SafetyTrendPoint } from "@rnd/shared";
import { read, write } from "../neo4j.js";

/** The score fields a snapshot records (everything the trend needs). */
export interface SnapshotInput {
  overall: number;
  weightedIndex: number;
  assessed: number;
  unsafe: number;
  /** Optional annotation — e.g. "SUBJ-206 code mapped" — shown on the trend marker. */
  note?: string;
}

/** ISO minute prefix ("2026-07-09T12:34") for the dedupe-by-minute guard. */
const minuteOf = (iso: string): string => iso.slice(0, 16);

/**
 * Append a score snapshot. With `dedupeByMinute`, a snapshot already written in
 * the same clock minute is skipped (so repeated report reads don't spam the
 * series); a forced snapshot (apply/revert) always writes so the movement shows.
 */
export async function captureSnapshot(
  input: SnapshotInput,
  opts: { dedupeByMinute?: boolean } = {},
): Promise<void> {
  const at = new Date().toISOString();
  if (opts.dedupeByMinute) {
    const existing = await read<{ n: number }>(
      `MATCH (s:SafetyScoreSnapshot) WHERE s.at STARTS WITH $minute RETURN count(s) AS n`,
      { minute: minuteOf(at) },
    );
    if (Number(existing[0]?.n ?? 0) > 0) return;
  }
  await write(
    `CREATE (s:Safety:SafetyScoreSnapshot {
        id: $id, at: $at, overall: $overall, weightedIndex: $weightedIndex,
        assessed: $assessed, unsafe: $unsafe, note: $note })`,
    {
      id: `SNAP-${randomUUID()}`,
      at,
      overall: input.overall,
      weightedIndex: input.weightedIndex,
      assessed: input.assessed,
      unsafe: input.unsafe,
      note: input.note ?? null,
    },
  );
}

/** The ordered readiness trend (oldest → newest). */
export async function getTrend(): Promise<SafetyTrendPoint[]> {
  const rows = await read<{
    at: string;
    overall: number;
    weightedIndex: number;
    assessed: number;
    unsafe: number;
    note: string | null;
  }>(
    `MATCH (s:SafetyScoreSnapshot)
     RETURN s.at AS at, s.overall AS overall, s.weightedIndex AS weightedIndex,
            s.assessed AS assessed, s.unsafe AS unsafe, s.note AS note
     ORDER BY s.at`,
  );
  return rows.map((r) => ({
    at: r.at,
    overall: Number(r.overall),
    weightedIndex: Number(r.weightedIndex),
    assessed: Number(r.assessed),
    unsafe: Number(r.unsafe),
    ...(r.note ? { note: r.note } : {}),
  }));
}
