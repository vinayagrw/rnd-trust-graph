/**
 * Test isolation for the file-backed admin config.
 *
 * `node --test <glob>` runs each test FILE in its own worker process, but those
 * processes all share one on-disk `bff/admin-config.json`. `getConfig()` re-reads
 * that file whenever its mtime/size changes (so out-of-band edits hot-apply), so a
 * concurrent test process writing the shared file makes another process's
 * `getConfig()` re-read a foreign value mid-test. Observed symptom: the
 * "agent, bridge and UI all read the SAME configured marker" test intermittently
 * saw `NOT_IN_GRAPH:` instead of the `MARKER_X:` it had just set — and the runs
 * also left the real `admin-config.json` polluted for the live dev server.
 *
 * Fix: give every worker its OWN throwaway config file under the OS temp dir,
 * keyed by pid, and clean it up on exit. This must run BEFORE any module reads
 * `ADMIN_CONFIG_PATH`, so it is loaded via `--import` ahead of the test files.
 * Normal (non-test) runs never set this env, so production behaviour is unchanged.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

/** Point a file-backed store's path env at a per-pid scratch file, cleaned on
 *  exit, BEFORE the store module reads it (ESM imports are hoisted, so a test
 *  file cannot do this itself — it must happen here via `--import`). */
function scratchEnv(envVar: string, name: string): void {
  if (process.env[envVar]) return;
  const path = join(tmpdir(), `${name}-${process.pid}.json`);
  process.env[envVar] = path;
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
  process.on("exit", () => {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
  });
}

scratchEnv("ADMIN_CONFIG_PATH", "rtg-admin-config");
// HITL change-set audit log — isolate per worker so the round-trip tests never
// touch (or replay an applied changeset from) the real bff/hitl-changesets.json.
scratchEnv("HITL_CHANGESETS_PATH", "rtg-hitl-changesets");
// HITL enqueued review-request queue — isolate per worker so enqueue tests never
// pollute the real bff/hitl-enqueued.json (or the pending queue other tests read).
scratchEnv("HITL_ENQUEUED_PATH", "rtg-hitl-enqueued");
// Eval scorecard (F2) ledger — isolate per worker so answer-quality recording in
// tests (and any path that scores an answer) never pollutes the real
// bff/eval-ledger.json or another worker's run.
scratchEnv("EVAL_LEDGER_PATH", "rtg-eval-ledger");
