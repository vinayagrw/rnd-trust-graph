# CLAUDE.md — rnd-trust-graph

Operational notes for any Claude Code session working on this app. Keep this file
high-signal: the goal is to stop known issues from recurring, not to restate the README.

## LLM "not active" / "worked before, now scripted" — READ THIS FIRST

**Symptom:** the app narrates from the scripted/cached fallback instead of the live model,
often after it *was* working. Nothing in the code is broken.

**Root cause (recurring):** the BFF proves live-mode by spawning the `claude` CLI
(`spawn("claude", ["--version"])` in `bff/src/diag.ts`). `claude.exe` and `uvx.exe` live in
`~/.local/bin`. A BFF launched from a shell whose PATH does **not** include `~/.local/bin`
(e.g. a terminal opened before the tools were installed/relocated there) fails that probe →
`getLiveStatus().live = false` → the whole app silently drops to scripted narration.

**Guard already in place:** `bff/src/config.ts` prepends `~/.local/bin` to `process.env.PATH`
at startup (idempotent). Do **not** remove it. If the issue still appears, the running BFF
predates the guard — **restart it** (see below).

**`tsx watch` does NOT reliably reload on a `config.ts` change** — an already-running BFF
keeps its old behaviour. Config/env/PATH changes require a real restart, not just an edit.

### How to diagnose live-mode (in order)

1. `curl http://localhost:8787/api/diag` → want `"live":true` with
   `checks:{claudeBin:true, uvx:true}`. If `claudeBin:false`, it's the PATH issue above.
2. Confirm the binaries exist: `ls ~/.local/bin/claude.exe ~/.local/bin/uvx.exe`.
3. Sanity-check the CLI directly: `echo "say PONG" | claude -p --output-format stream-json
   --verbose --max-turns 3 --model claude-opus-4-8` → should return `{"subtype":"success",
   "result":"PONG"}` in a few seconds. If this works but `/api/diag` says `false`, it's PATH.

### The definitive live-vs-cached test

Token streaming alone does **not** prove live — the cached fallback also word-streams to
preserve the demo. The real test: after a narration, check the FinOps ledger —

```
curl "http://localhost:8787/api/finops/ledger?limit=3"
```

A **live** call records `"estimated":false` with real `inputTokens`/`outputTokens`/`costUsd`.
A cached run never does. Also grep the BFF log for `[claude-code] fallback (<reason>)` —
its presence means it fell back and why (`spawn-failed` = PATH, `not-authenticated` = login,
`no-tools` = uvx/MCP, `timeout`, `empty-output`).

### Restarting the app's BFF

The web dev server proxies `/api → http://localhost:8787` (override `BFF_PROXY`). The app is
only as live as whatever holds `:8787`. To restart: stop the process on `:8787`, then
`npm run dev:bff` **from a shell that has `~/.local/bin` on PATH** (cwd must be the repo so
the workspace loads `bff/.env`, which sets `LLM_PROVIDER=claude-code`).

> If `:8787` may belong to another Claude session, confirm with the user before killing it.

## Env / provider notes

- `bff/.env` sets `LLM_PROVIDER=claude-code` (subscription auth, no API key). The root `.env`
  has **no** uncommented `LLM_PROVIDER`, so a BFF started with cwd = repo-root would default
  to `provider:"api"` + blank key = dead. Always launch the BFF via `npm run dev:bff` (cwd is
  the `bff` workspace → loads `bff/.env`).
- To run on the cloud API instead: set `LLM_PROVIDER=api` **and** a real `ANTHROPIC_API_KEY`.

## Testing

- **`npm test` (full BFF suite) hangs** on the CLI eval tests. Run a targeted subset, e.g.
  `cd bff && node --import tsx --import ./test-setup.ts --test src/safety/remediate.test.ts`.
- Standard gate before claiming done: `npm run typecheck` (3 workspaces) → targeted BFF tests
  → live render-proof.

## Trust invariants — do NOT regress

- All graph writes go through the HITL **authorized writer** (`hitl/ops.ts` `applyOp` →
  Neo4j `write()` + `reasoner.update()`). The agent/MCP path stays **read-only**
  (`--read-only` MCP, `/api/sparql` write-guard, `ask/enforced.ts`).
- The FAIR canvas must stay **byte-identical**: `graph/queries.ts` keeps `WHERE NOT n:Safety`.
  Safety trend snapshots are tagged `:Safety:SafetyScoreSnapshot` so that exclusion already
  hides them (the FAIR query is untouched); the **safety** canvas query adds
  `WHERE NOT n:SafetyScoreSnapshot`.
- **F2 safety remediation — two governed paths, both fully reversible** (this replaced the old
  "propose-only, empty ops" posture, authorized 2026-07-09):
  1. **ROUTE** (`remediationPendingItem`) stays **propose-only** — its canonical HITL ops are
     still EMPTY (records intent for the owner); this is still asserted in `remediate.test.ts`.
  2. **APPLY** (`safety/ops.ts` `applySafetyOps` via `/api/safety/remediation/apply`) applies the
     finding's reversible corrective `SafetyChangeOp`s to the **isolated** safety substrate
     (safety reasoner + `:Safety` Neo4j) — this **clears the finding and moves the score**; revert
     replays the inverse for a byte-identical restore. It NEVER touches a FAIR/canonical triple or
     the read-only agent/MCP path. The safety writer is the ONLY safety-mutation path (analog of
     `hitl/ops.ts`). Detection runs SHACL over the **live reasoner dump** (`getSafetyViolations`),
     so a governed `update()` is reflected once `invalidateSafetyShacl()` clears the cache.
- Any new overlay `ChangeOp` must be replayed in `store.ts` `rebuildOverlay`, or `persist()`
  wipes it. (Safety corrections persist to `safety-changesets.json` and replay on load via
  `safety/store.ts` `ensureReplayed`.)
