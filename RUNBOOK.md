# Demo RUNBOOK — never fail live

Rehearse this. The whole point of "all-real, offline" is that nothing on stage depends on the room's wifi.

## What changed recently (2026-06-30)

Latest-first; see [`BUILD_STATUS.md`](BUILD_STATUS.md) for the verified per-change detail + test counts.

- **Conversation persistence shared dock ↔ Beat 4** — a chat started in the floating AskDock is now the
  **same** persistent conversation you see when you **⤢ expand** to the full Conversation page (and survives
  minimize/reload). History-only, grounded path unchanged.
- **Manual reviewer flag (⚑)** — flag any node from the provenance drawer (`POST /api/hitl/flag`); it's a
  governed, reversible overlay shown back on the node and in the radar.
- **FinOps meter** — header pill shows live token spend & cost (`/api/finops/summary`), amber/red vs budget.
- **Reviewer notifications (ReviewBell)** — header bell badges items routed to a human (`/api/hitl/pending`).
- **Known / Missing / Conflicting evidence ledger** — Beat-4 answers bucket the real cited nodes with a
  confidence boundary.

> [!NOTE]
> **Green-suite recovery:** the HITL apply→revert round-trip tests run against the shared Neo4j and flake on a
> dirty radar. If `npm test -w bff` shows round-trip failures, run **`npm run etl`** to reset the baseline,
> then re-run — that's a state issue, not a regression.

## Pre-flight (the morning of)

- [ ] `npm run db:up` then `npm run etl` — confirm hero subjects loaded (`scripts/verify.cypher` count checks pass).
- [ ] `npm run dev` — open http://localhost:5173; run all 4 beats once in **Scripted** mode.
- [ ] **Beat 4 (ask/conversation):** ask one question, confirm a grounded answer; then **switch threads** (the history list scrolls inside its pane — the page itself must not scroll) and confirm a prior conversation restores.
- [ ] **Beat 4 affordances:** click 2+ canvas nodes → context chips accumulate + a relational pill ("Connections" / "Compare known-missing") fires one grounded turn; on a grounded answer with diagrams, confirm each figure's inline zoom (−/reset/+) and the fullscreen expand (Esc closes).
- [ ] **Beat 1 (radar):** open a flagged finding → severity badge + remediation owner show, "Why was this flagged?" shows the SHACL reason; run one Approve/Escalate and confirm it appears as "Reviewed by" (and is revertible).
- [ ] **Admin panel** loads — `GET /api/admin/config` returns the effective config *and* the read-only `enforced` block (proof the grounding invariants are code-locked, not editable). Edits **hot-apply with no restart**.
- [ ] Open http://localhost:7474 in a second tab, logged in, query pre-typed (authenticity cutaway).
- [ ] Confirm `data/fallbacks/narrations.json` exists and `data/fallbacks/recorded-demo.mp4` plays.
- [ ] **Kill wifi and run the full flow** — narration + ask must fall back to cached content, badged "offline".
- [ ] Battery > 80%, screen-sleep disabled, notifications off.

## Live LLM mode (local Claude Code — no API key)

The demo can run live narration + ask through your **local `claude` CLI**; auth rides on your
Claude Code subscription login, so **no `ANTHROPIC_API_KEY` is needed** and no raw key sits in the BFF.
Controlled by `bff/.env` (`LLM_PROVIDER=claude-code`). Prereqs, all checked by **`GET /api/diag`**:

- [ ] `claude --version` works (Claude Code on PATH) **and you are logged in** (run `claude` once to sign in).
- [ ] `uvx --version` works (`uv` installed) — needed for the `/ask` read-only Neo4j MCP loop.
- [ ] Neo4j up (`npm run db:up`).
- [ ] **Watch the header pill:** green **"Live · Claude Code (no API key)"** = ready. Hover it for the
      per-check breakdown. The BFF also logs `live-readiness: READY/NOT READY …` on startup.
- [ ] If a live call ever drops to fallback, the `/ask` badge shows the **reason** (`spawn-failed`,
      `not-authenticated`, `no-tools`, `timeout`, …) — hover it for the fix. Failures are logged to the
      BFF console, never silent.

To run **fully offline / cached-only** instead, set `LLM_PROVIDER=api` with a blank `ANTHROPIC_API_KEY`.

Note: narration and ask have **independent** models/timeouts (`NARRATE_*` vs `ASK_*`). You can point narration at a cheaper model to cut tokens without affecting ask quality — a slow or small narration model never degrades the `/ask` tool-loop.

## On stage — degradation ladder

| If… | Do this |
|---|---|
| Live narration stalls | Nothing — it auto-falls-back to cached narration (within ~6s on cloud API, ~20–30s on local Claude Code's cold start) and badges "offline". Keep talking. |
| Ask-anything errors (Beats 1–3) | It returns the cached answer for that beat. Don't retype; move on. |
| Beat 4 (ask/conversation) errors or times out | The chat badges the **reason** (`spawn-failed`, `not-authenticated`, `no-tools`, `timeout`, …); fall back to the cached answer and move on. Switching threads still works (history is local, not a live call). |
| Path doesn't render | Click **Replay hero path** (pinned `pathId`) — deterministic, always fires. |
| Reasoner / SPARQL cameo unreachable | Non-critical cutaway — skip it. The graph beats don't depend on the reasoner; `REASONER_BACKEND=oxigraph` (default) is in-process and needs no sidecar. |
| Neo4j unreachable | `docker compose restart neo4j`; if still down → switch to recording (below). |
| Whole app wedged | Switch display to the recorded fallback at the matching beat timestamp. |

## Recorded fallback

`data/fallbacks/recorded-demo.mp4` — recorded run of the **three graph beats**, chaptered:
- 00:00 Radar · 00:45 Explanation path reveal · 02:10 Provenance drill · 02:50 Multimodal resolve · 03:30 Ask-anything.

The recording covers the graph beats (1–3) and the single-shot ask. **Beat 4 (the persisted ask/conversation) is demoed live** — it is not in the recording, so if the room is fully offline, narrate the conversation beat from the cached ask answer rather than reaching for a timestamp.

Switch to it mid-sentence and narrate over it; the script matches the live flow.

## After

- `npm run db:down` to stop Neo4j. Graph state persists in `data/neo4j/data/` for next time.
