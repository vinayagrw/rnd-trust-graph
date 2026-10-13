import Fastify from "fastify";
import cors from "@fastify/cors";
import { log } from "./log.js";
import { config, liveModeAvailable } from "./config.js";
import { healthcheck, closeDriver } from "./neo4j.js";
import {
  getFullGraph,
  getSafetyGraph,
  getExplanationPath,
  getProvenance,
  resolveEntity,
  HERO_PATH_ID,
} from "./graph/queries.js";
import { getTerminology } from "./graph/terminology.js";
import { heroGraphToTurtle } from "./graph/rdf.js";
import { sparqlSelectReadOnly, SparqlWriteRejectedError } from "./graph/sparql.js";
import { getCanonicalReasoner } from "./reasoner/service.js";
import { narrate } from "./narrate/narrator.js";
import { explainNode } from "./explain/explainNode.js";
import { streamLiteratureSynthesis } from "./litsynth/service.js";
import { getCompetitiveOverlay } from "./overlay/competitivePipeline.js";
import {
  listPlaybooks,
  getPlaybook,
  createPlaybook,
  updatePlaybook,
  deletePlaybook,
  CuratedReadOnlyError,
} from "./playbooks/definitions.js";
import { runPlaybook } from "./playbooks/runner.js";
import { draftPlaybook, refinePlaybook } from "./playbooks/draft.js";
import {
  listRoutines,
  getRoutineByPlaybook,
  upsertRoutine,
  deleteRoutine,
  listRuns,
} from "./playbooks/routines.js";
import { startScheduler, executeRoutineRun, composeSnapshot } from "./playbooks/scheduler.js";
import {
  listDashboards,
  getDashboard,
  saveDashboard,
  deleteDashboard,
  saveDashboardSchema,
} from "./dashboards/store.js";
import {
  listSchedules,
  getSchedule,
  upsertSchedule,
  deleteSchedule,
  listSnapshots,
  scheduleInputSchema,
} from "./dashboards/snapshots.js";
import { getRiskReport, getGatedConclusions } from "./graph/risk.js";
import { getSafetyReport, getSafetyAudit } from "./safety/service.js";
import { explainSafetyFinding } from "./safety/explain.js";
import { planRemediations, remediationPendingItem } from "./safety/remediate.js";
import { getTrend } from "./safety/history.js";
import { applyCorrection, revertCorrection, appliedFindingIds } from "./safety/store.js";
import { resolveNode } from "./graph/resolve.js";
import { askGraph } from "./ask/agent.js";
import { aguiBridge } from "./ask/aguiBridge.js";
import { bindDatasets } from "./generative/bind.js";
import { refineTile } from "./generative/refine.js";
import { composeBoardOrchestrated } from "./generative/orchestrator.js";
import { registerCopilotRuntime } from "./ask/copilotRuntime.js";
import {
  listThreads,
  getThread,
  saveThread,
  createThread,
  deleteThread,
  saveThreadSchema,
} from "./ask/threadStore.js";
import { getLiveStatus } from "./diag.js";
import { getConfig, setConfig } from "./config/adminConfig.js";
import { summarize as finopsSummary, recentEntries } from "./finops/ledger.js";
import { summarizeEval as evalSummary } from "./eval/scorecard.js";
import { ALLOWED_TOOLS, EXCLUDED_WRITE_TOOL } from "./ask/enforced.js";
import {
  getPendingItems,
  getPendingItem,
  enqueueFromConclusion,
  enqueueItem,
  getEnqueued,
  apply as hitlApply,
  revert as hitlRevert,
  listChangeSets,
  appliedItemIds,
  humanReviewedNodeIds,
  refreshFromDisk as hitlRefreshFromDisk,
} from "./hitl/index.js";
import { suggestQuestions as suggestChangeQuestions } from "./hitl/suggest.js";
import { ZodError } from "zod";
import type { NarrateRequest, AskRequest, RiskFlag, ChangeOp, EdgeKind, PlaybookDraft, GenerativeTile, LayoutArchetype } from "@rnd/shared";

/** Normalize an optional reviewer body (F6) into a ReviewerIdentity, or undefined
 *  when no name was supplied. Defensive: trims, and only returns a value when there
 *  is a non-empty name so a blank selector never stamps an empty reviewer. */
function reviewerFrom(
  r?: { name?: string; role?: string },
): import("@rnd/shared").ReviewerIdentity | undefined {
  const name = (r?.name ?? "").trim();
  if (!name) return undefined;
  return { name, role: (r?.role ?? "").trim() || "Reviewer" };
}

/** Read-only structural guarantees the admin UI displays as LOCKED. Computed
 *  from in-code enforcement (config.mcp + ./ask/enforced) — never editable. */
function enforcedGuarantees() {
  return {
    neo4jReadOnly: config.mcp.readOnly,
    allowedTools: [...ALLOWED_TOOLS],
    excludedWriteTool: EXCLUDED_WRITE_TOOL,
    groundingRefusalEnforced: true,
    note:
      "Enforced in code, not editable via config: the Neo4j MCP --read-only flag, " +
      "the read-only tool allow-list (the write tool is never allowed), and the " +
      "off-path-citation refusal (validateGrounding). Prompts are advisory; these " +
      "structural guarantees hold even if a prompt is maliciously weakened.",
  } as const;
}

/** Begin an SSE response on the raw socket and return a typed event writer. */
function sse(reply: import("fastify").FastifyReply) {
  reply.hijack(); // we own the socket from here; Fastify won't also respond.
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  return {
    send: (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => reply.raw.end(),
  };
}

const app = Fastify({ logger: true });

// Observe-only error hook: log request-handler errors with file:line/function via
// the located logger. Uses onError (NOT setErrorHandler) so Fastify's default
// response serialization — and every API shape/test — is left exactly as-is.
app.addHook("onError", async (req, _reply, err) => {
  log.error(`request ${req.method} ${req.url} failed:`, err);
});

await app.register(cors, { origin: config.corsOrigin });

// --- Health ----------------------------------------------------------------
app.get("/api/health", async () => ({
  ok: await healthcheck(),
  liveMode: liveModeAvailable(),
  model: config.narrator.model,
}));

// --- Live-readiness preflight (presenter): is the LLM path actually live? ---
app.get("/api/diag", async () => getLiveStatus());

// --- Beat 2: graph + deterministic explanation path ------------------------
app.get<{ Querystring: { scope?: "hero" | "all" } }>("/api/graph", async (req) => {
  return getFullGraph(req.query.scope ?? "all");
});

app.get("/api/explain", async (_req, reply) => {
  const path = await getExplanationPath();
  // §11 guard: never blank the wow — fall back to the pinned hero path id.
  if (path.hops.length === 0) {
    reply.code(503);
    return { error: "explanation path empty", pathId: HERO_PATH_ID };
  }
  return path;
});

// --- Phase 4: W3C/RDF cameo — live hero subgraph serialized to Turtle -------
app.get("/api/rdf", async (_req, reply) => {
  try {
    const turtle = await heroGraphToTurtle();
    reply.header("Content-Type", "text/turtle; charset=utf-8");
    return turtle;
  } catch (err) {
    // Never crash the demo: degrade to a clear 503 if the graph is unreachable.
    reply.code(503).header("Content-Type", "text/plain; charset=utf-8");
    return `RDF export unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
});

// --- Read-only SPARQL over the canonical reasoner (RDF-first, slice 1d) ------
// Accepts SELECT / ASK / CONSTRUCT / DESCRIBE against the asserted + inferred
// canonical store. Update / graph-management ops (INSERT/DELETE/LOAD/…) are
// rejected up front (SparqlWriteRejectedError → 400) — the store stays the
// read-mostly source of truth; no mutation path is reachable from HTTP.
app.post<{ Body: { query?: string } }>("/api/sparql", async (req, reply) => {
  const query = req.body?.query?.trim();
  if (!query) {
    reply.code(400);
    return { error: "query required" };
  }
  try {
    return await sparqlSelectReadOnly(query);
  } catch (err) {
    if (err instanceof SparqlWriteRejectedError) {
      reply.code(400);
      return { error: err.message };
    }
    reply.code(400);
    return { error: `SPARQL error: ${err instanceof Error ? err.message : String(err)}` };
  }
});

app.get<{ Params: { id: string } }>("/api/provenance/:id", async (req, reply) => {
  const prov = await getProvenance(req.params.id);
  if (!prov) {
    reply.code(404);
    return { error: "no provenance", id: req.params.id };
  }
  return prov;
});

// --- Narrator (SSE) — live Opus 4.8 with cached fallback -------------------
app.post<{ Body: NarrateRequest }>(
  "/api/narrate",
  {
    schema: {
      body: {
        type: "object",
        // beatId keys the cached fallback; required so a malformed POST is a 400,
        // not a silent default. pathId is optional (server resolves the hero path).
        required: ["beatId"],
        properties: {
          beatId: { type: "string" },
          pathId: { type: "string" },
        },
      },
    },
  },
  async (req, reply) => {
  const path = await getExplanationPath();
  const ch = sse(reply);
  await narrate(req.body.beatId ?? path.pathId, path, (e) => ch.send(e));
  ch.end();
  }
);

// --- Literature synthesis (SSE, F7) — source-ranked, inline-cited ----------
// Same stream protocol as /narrate plus a leading `ranked` event. Synthesizes
// ONLY the served LiteratureAbstract nodes; every inline [LIT-PMID-…] citation is
// enforced ⊆ the supplied ids, and a deterministic template (which merely restates
// the served summaries) is streamed when the live LLM is unavailable or refused.
app.post<{ Body: { focusNodeId?: string; topic?: string } }>(
  "/api/litsynth",
  {
    schema: {
      body: {
        type: "object",
        properties: {
          focusNodeId: { type: "string" },
          topic: { type: "string" },
        },
      },
    },
  },
  async (req, reply) => {
    const ch = sse(reply);
    await streamLiteratureSynthesis(
      { focusNodeId: req.body?.focusNodeId, topic: req.body?.topic },
      (e) => ch.send(e),
    );
    ch.end();
  }
);

// --- Scientific playbooks / safety dossiers (F5) ----------------------------
// GET lists the curated playbooks; POST runs one and streams step progress via
// SSE. Each `ask` step drives the UNCHANGED grounded agent; `checkpoint` steps
// enqueue a HITL review (non-blocking — the reviewer approves asynchronously).
// Pure orchestration: no new answer source, no new write path.
app.get("/api/playbooks", async () => ({ playbooks: listPlaybooks() }));

app.post<{ Body: { playbookId?: string } }>(
  "/api/playbooks/run",
  {
    schema: {
      body: {
        type: "object",
        required: ["playbookId"],
        properties: { playbookId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const ch = sse(reply);
    await runPlaybook(req.body?.playbookId ?? "", (e) => ch.send(e));
    ch.end();
  }
);

// --- AI-assisted playbook authoring (create / edit custom playbooks) ---------
// draft/refine call the model (schema-seeded, JSON) to PROPOSE a playbook; the
// user edits + explicitly saves via POST/PUT. All authored content is Zod-
// validated + sanitized in the store; curated playbooks are read-only. These
// endpoints produce CONFIG only — no new answer source, no graph write.

/** Pick only the persisted playbook fields (the store schema is strict, so we
 *  never forward UI-only fields like `warnings`). */
function pickDef(body: unknown): { title?: unknown; description?: unknown; steps?: unknown } {
  const b = (body ?? {}) as Record<string, unknown>;
  return { title: b.title, description: b.description, steps: b.steps };
}

/** Map an authoring error to a status + payload (ZodError→400 with issues,
 *  curated→409, else 400 with the message). */
function authoringError(
  reply: import("fastify").FastifyReply,
  err: unknown,
): { error: string; issues?: unknown } {
  if (err instanceof ZodError) {
    reply.code(400);
    return { error: "invalid playbook", issues: err.issues };
  }
  if (err instanceof CuratedReadOnlyError) {
    reply.code(409);
    return { error: err.message };
  }
  reply.code(400);
  return { error: err instanceof Error ? err.message : "bad request" };
}

app.post<{ Body: { goal?: string } }>(
  "/api/playbooks/draft",
  {
    schema: {
      body: {
        type: "object",
        required: ["goal"],
        properties: { goal: { type: "string", minLength: 1, maxLength: 1000 } },
      },
    },
  },
  async (req) => draftPlaybook(req.body?.goal ?? ""),
);

app.post<{ Body: { draft?: PlaybookDraft; instruction?: string } }>(
  "/api/playbooks/refine",
  {
    schema: {
      body: {
        type: "object",
        required: ["draft", "instruction"],
        properties: {
          draft: { type: "object" },
          instruction: { type: "string", minLength: 1, maxLength: 1000 },
        },
      },
    },
  },
  async (req) => {
    const draft = req.body?.draft;
    if (!draft) return { draft: { title: "", description: "", steps: [], warnings: [] }, grounded: false };
    return refinePlaybook(draft, req.body?.instruction ?? "");
  },
);

app.post<{ Body: { playbook?: unknown; reviewer?: { name?: string } } }>(
  "/api/playbooks",
  async (req, reply) => {
    try {
      const id = ((req.body?.playbook ?? {}) as { id?: unknown }).id;
      const playbook = createPlaybook(
        { id, ...pickDef(req.body?.playbook) },
        req.body?.reviewer?.name?.trim() || undefined,
      );
      reply.code(201);
      return { playbook };
    } catch (err) {
      return authoringError(reply, err);
    }
  },
);

app.put<{ Params: { id: string }; Body: { playbook?: unknown; reviewer?: { name?: string } } }>(
  "/api/playbooks/:id",
  async (req, reply) => {
    try {
      const playbook = updatePlaybook(
        req.params.id,
        pickDef(req.body?.playbook),
        req.body?.reviewer?.name?.trim() || undefined,
      );
      return { playbook };
    } catch (err) {
      return authoringError(reply, err);
    }
  },
);

app.delete<{ Params: { id: string } }>("/api/playbooks/:id", async (req, reply) => {
  try {
    const deleted = deletePlaybook(req.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: `unknown playbook: ${req.params.id}` };
    }
    return { deleted: true };
  } catch (err) {
    return authoringError(reply, err);
  }
});

// --- Routines / schedules (run a playbook on a cadence) ----------------------
// A routine is orchestration config only: it decides WHEN a playbook runs. The
// in-process scheduler fires due routines HEADLESS through the unchanged runner
// (each ask step still refuses off-graph; each checkpoint still enqueues a
// non-blocking HITL item). One routine per playbook (upsert). No new answer
// source, no graph write. curated/custom both schedulable — scheduling never
// mutates the playbook definition, so curated immutability is untouched.

app.get("/api/routines", async () => ({ routines: listRoutines() }));

/** Run history (optionally scoped to one routine via ?routineId=). */
app.get<{ Querystring: { routineId?: string } }>("/api/routines/runs", async (req) => ({
  runs: listRuns(req.query?.routineId),
}));

/** Create-or-update the routine for a playbook. 404 if the playbook is unknown,
 *  400 (with Zod issues) on an invalid cadence/cron. */
app.put<{ Params: { id: string }; Body: { routine?: unknown; reviewer?: { name?: string } } }>(
  "/api/playbooks/:id/routine",
  async (req, reply) => {
    if (!getPlaybook(req.params.id)) {
      reply.code(404);
      return { error: `unknown playbook: ${req.params.id}` };
    }
    try {
      const routine = upsertRoutine(
        req.params.id,
        req.body?.routine,
        req.body?.reviewer?.name?.trim() || undefined,
      );
      return { routine };
    } catch (err) {
      return authoringError(reply, err);
    }
  },
);

/** Remove a playbook's routine. */
app.delete<{ Params: { id: string } }>("/api/playbooks/:id/routine", async (req, reply) => {
  const deleted = deleteRoutine(req.params.id);
  if (!deleted) {
    reply.code(404);
    return { error: `no routine for playbook: ${req.params.id}` };
  }
  return { deleted: true };
});

/** Manual "Run now" for a scheduled playbook — same headless path as the ticker,
 *  recorded in the history as trigger:"manual". */
app.post<{ Params: { id: string } }>("/api/playbooks/:id/run-now", async (req, reply) => {
  if (!getPlaybook(req.params.id)) {
    reply.code(404);
    return { error: `unknown playbook: ${req.params.id}` };
  }
  const routine = getRoutineByPlaybook(req.params.id);
  const dossier = await executeRoutineRun(routine?.id ?? `rt_${req.params.id}`, req.params.id, "manual");
  return { ran: Boolean(dossier), dossier };
});

// --- Per-node AI explanation (SSE) — grounded in the node's real neighbourhood
// Same stream protocol as /narrate: token / citations / done{isFallback}. The
// explanation may ONLY reference the node + its 1-hop neighbours we supply; an
// off-list citation is refused and a deterministic templated fallback is streamed.
app.post<{ Body: { nodeId?: string } }>(
  "/api/explain-node",
  {
    schema: {
      body: {
        type: "object",
        required: ["nodeId"],
        properties: { nodeId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
  const nodeId = req.body?.nodeId?.trim();
  const ch = sse(reply);
  if (!nodeId) {
    ch.send({ type: "token", text: "nodeId required." });
    ch.send({ type: "done", isFallback: true, reason: "empty-output" });
    ch.end();
    return;
  }
  await explainNode(nodeId, (e) => ch.send(e));
  ch.end();
  }
);

// --- Terminology: SKOS synonyms + hierarchy (honest doc-gap surface) --------
app.get("/api/terminology", async () => ({ concepts: getTerminology() }));

// --- Entity resolution: external code -> canonical node id -> cross-refs -----
app.get<{ Querystring: { code?: string } }>("/api/resolve-entity", async (req, reply) => {
  const code = req.query.code?.trim();
  if (!code) {
    reply.code(400);
    return { error: "code required" };
  }
  const result = await resolveEntity(code);
  if (!result) {
    reply.code(404);
    return { error: "no node carries that code", code };
  }
  return result;
});

// --- Beat 1: readiness radar + HITL gate -----------------------------------
app.get("/api/risk", async () => {
  // Augment the reasoner's FAIR report with the HITL "human-reviewed" node ids
  // (nodes carrying an applied, non-reverted governed change) so the canvas marks
  // every reviewer-approved node with the verified stamp — not only edge-adding
  // approvals. Reverting a change set drops the node from this set on the next read.
  const report = await getRiskReport();
  return { ...report, humanReviewed: [...humanReviewedNodeIds()] };
});
app.get("/api/gated", async () => getGatedConclusions());

// --- UC4: subject-safety radar (dedicated safety reasoner + Neo4j inventory) --
// The brief's Data-Quality & Patient-Safety Risk Radar, on the REAL stack: SHACL
// over a SEPARATE canonical-built safety reasoner (so the FAIR radar above is
// byte-identical untouched) flags the relationship gaps and builds each finding's
// evidence path, while the assessed-subject inventory is read from the Neo4j
// projection — so this fails closed if Neo4j is down, like every live surface.
app.get("/api/safety", async () => getSafetyReport());

// The reproducible audit behind "readiness N/100": assessed set (Neo4j), unsafe
// set, per-subject fired shapes + raw SHACL messages, and the formula — so QA can
// recompute the score independently instead of trusting the headline number.
app.get("/api/safety/audit", async () => getSafetyAudit());

// F1 — the subject-safety subgraph for the safety canvas: ONLY the :Safety nodes/
// edges (the mirror of getFullGraph's exclusion). A separate read; the FAIR canvas
// (/api/graph) is untouched. This finally puts the projected subject graph on screen.
app.get("/api/safety/graph", async () => getSafetyGraph());

// F2 · Agentic Remediate — draft the propose-only remediation for every finding
// (deterministic; grounded in SAFETY_POLICY + the finding). NO mutation: this is a
// plan. `routed` reflects whether an identical governed task is already queued/applied.
app.get("/api/safety/remediation", async () => {
  const report = await getSafetyReport();
  const routedIds = appliedItemIds();
  const queued = new Set(getEnqueued().map((i) => i.id));
  const correctedFindings = await appliedFindingIds();
  const items = planRemediations(report.findings).map((r) => ({
    ...r,
    routed: routedIds.has(r.pendingItemId) || queued.has(r.pendingItemId),
    applied: correctedFindings.has(r.findingId),
  }));
  return { items };
});

// The readiness TREND — the persisted score history (:SafetyScoreSnapshot). A
// governed correction/revert writes a forced point, so the line bends when a
// finding is actually cleared. Reads fail closed if Neo4j is down, like every
// live surface.
app.get("/api/safety/trend", async () => ({ points: await getTrend() }));

// F2 — route ONE finding's agent-drafted remediation into the HITL pending queue.
// The item is PROPOSE-ONLY (empty ops): approving it later via /api/hitl/apply records
// a governed, reversible decision through the AUTHORIZED writer — it never mutates
// patient data and adds NO new write path. Idempotent (deduped by item id).
app.post<{ Body: { findingId?: string } }>(
  "/api/safety/remediation/route",
  {
    schema: {
      body: {
        type: "object",
        required: ["findingId"],
        properties: { findingId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const findingId = req.body?.findingId?.trim();
    const report = await getSafetyReport();
    const finding = report.findings.find((f) => f.id === findingId);
    if (!finding) {
      reply.code(404);
      return { error: "no such finding", findingId };
    }
    const item = enqueueItem(remediationPendingItem(finding));
    return { routed: true, item };
  }
);

// F2 — APPLY one finding's governed correction. The authorized safety-writer
// applies the finding's reversible corrective ops to the ISOLATED safety substrate
// (safety reasoner + :Safety Neo4j), which CLEARS the finding and moves the score;
// a forced trend point records the movement. This closes the loop. Idempotent. The
// FAIR canvas + read-only agent/MCP path are untouched.
app.post<{ Body: { findingId?: string } }>(
  "/api/safety/remediation/apply",
  {
    schema: {
      body: {
        type: "object",
        required: ["findingId"],
        properties: { findingId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const findingId = req.body?.findingId?.trim();
    const report = await getSafetyReport();
    const finding = report.findings.find((f) => f.id === findingId);
    if (!finding) {
      reply.code(404);
      return { error: "no such finding (already corrected?)", findingId };
    }
    if (!finding.correction.forwardOps.length) {
      reply.code(422);
      return { error: "no defined correction for this finding", findingId };
    }
    const changeSet = await applyCorrection(finding);
    const after = await getSafetyReport();
    return { applied: true, changeSet, report: after };
  }
);

// F2 — REVERT a previously-applied correction by finding id: replay its inverse
// ops (byte-identical restore) and record a trend point. Idempotent.
app.post<{ Body: { findingId?: string } }>(
  "/api/safety/remediation/revert",
  {
    schema: {
      body: {
        type: "object",
        required: ["findingId"],
        properties: { findingId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const findingId = req.body?.findingId?.trim();
    if (!findingId) {
      reply.code(400);
      return { error: "findingId required" };
    }
    const reverted = await revertCorrection(findingId);
    if (!reverted) {
      reply.code(404);
      return { error: "no applied correction for this finding", findingId };
    }
    const after = await getSafetyReport();
    return { reverted: true, changeSet: reverted, report: after };
  }
);

// Grounded LLM explanation of ONE safety finding (SSE; token/citations/done).
// Reuses the explain-node discipline: the model may ONLY cite the subject, its
// 1-hop Neo4j neighbours, and nodes on the evidence path; an off-list citation is
// refused and a deterministic templated explanation is streamed instead.
app.post<{ Body: { subjectId?: string } }>(
  "/api/safety/explain",
  {
    schema: {
      body: {
        type: "object",
        required: ["subjectId"],
        properties: { subjectId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const subjectId = req.body?.subjectId?.trim();
    const ch = sse(reply);
    if (!subjectId) {
      ch.send({ type: "token", text: "subjectId required." });
      ch.send({ type: "done", isFallback: true, reason: "empty-output" });
      ch.end();
      return;
    }
    await explainSafetyFinding(subjectId, (e) => ch.send(e));
    ch.end();
  }
);

// --- Beat 3: multimodal resolve (real vector kNN) --------------------------
app.get<{ Querystring: { nodeId: string } }>("/api/resolve", async (req, reply) => {
  if (!req.query.nodeId) {
    reply.code(400);
    return { error: "nodeId required" };
  }
  return resolveNode(req.query.nodeId);
});

// --- Ask the graph anything (SSE) — Agent SDK + Neo4j MCP (read-only) -------
app.post<{ Body: AskRequest }>(
  "/api/ask",
  {
    schema: {
      body: {
        type: "object",
        // question is the free-text query; beatId tags the turn. Both required so
        // a malformed/empty POST is a 400 rather than a silent empty-question run.
        required: ["beatId", "question"],
        properties: {
          beatId: { type: "string" },
          question: { type: "string", minLength: 1 },
        },
      },
    },
  },
  async (req, reply) => {
  const ch = sse(reply);
  await askGraph(req.body.question ?? "", (e) => ch.send(e));
  ch.end();
  }
);

// --- AG-UI bridge (SSE) — CopilotKit's prebuilt chat drives the grounded /ask
// agent over the AG-UI protocol; no second LLM, agent untouched (Phase 2 spike).
app.post("/api/agui", aguiBridge);

// --- Generative Studio: refine ONE tile by chat (Phase 5) -------------------
// Read-only and grounded-preserving: it re-binds the datasets from the tile's OWN
// cited node set (tile.provenance.nodeIds) — never a new grounding selection — and
// runs exactly one LLM round through the same trusted schema/critic/compiler chain
// as compose. On any failure the model produced nothing acceptable, so `tile:null`
// is returned and the client leaves the prior tile standing. NO graph write.
app.post<{ Body: { tile?: GenerativeTile; instruction?: string } }>(
  "/api/generative/refine",
  {
    schema: {
      body: {
        type: "object",
        required: ["tile", "instruction"],
        properties: { tile: { type: "object" }, instruction: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const tile = req.body?.tile;
    const instruction = req.body?.instruction ?? "";
    const nodeIds = tile?.provenance?.nodeIds ?? [];
    if (!tile || !tile.id || nodeIds.length === 0) {
      reply.code(400);
      return { error: "a tile with provenance.nodeIds and an instruction are required" };
    }
    // Re-bind from the tile's own cited set (read-only). Same datasets the client
    // needs to render the refined tile; the fieldMenu gates the refine schema.
    const { datasets, fieldMenu } = await bindDatasets(nodeIds);
    const refined = await refineTile(tile, instruction, fieldMenu, {
      nodeIds,
      rowCount: datasets[tile.dataset]?.length ?? 0,
    });
    return { tile: refined, datasets, fieldMenu };
  }
);

// --- "More dashboards" — compose ANOTHER grounded board over the SAME cited evidence.
// This is the honest home for a product request like "I need more dashboards" (which the
// grounded-Q&A chat correctly refuses as NOT_IN_GRAPH — the graph holds no Dashboard node).
// It re-runs the trusted orchestrator over an EXISTING cited set (no new grounding selection,
// no graph write, read-only), nudged AND deterministically rotated away from the previous
// archetype so each call yields a visibly DIFFERENT board. Never throws (orchestrator falls
// back to the template board), so the client can only ever ADD a board.
app.post<{ Body: { citedNodeIds?: string[]; question?: string; avoidArchetype?: string } }>(
  "/api/generative/board",
  {
    schema: {
      body: {
        type: "object",
        required: ["citedNodeIds"],
        properties: {
          citedNodeIds: { type: "array", items: { type: "string" } },
          question: { type: "string" },
          avoidArchetype: { type: "string" },
        },
      },
    },
  },
  async (req, reply) => {
    const citedNodeIds = req.body?.citedNodeIds ?? [];
    if (citedNodeIds.length === 0) {
      reply.code(400);
      return { error: "citedNodeIds (the evidence to re-visualize) is required" };
    }
    const question = req.body?.question?.trim() || "Compose another dashboard of this evidence — a different view.";
    const avoidArchetype = req.body?.avoidArchetype as LayoutArchetype | undefined;
    // No streaming over REST — collect the final board and return it whole.
    return composeBoardOrchestrated({ question, answerText: "", citedNodeIds }, () => {}, { avoidArchetype });
  }
);

// --- Copilot Runtime (Phase 2 slice 2a) — full v2 Runtime as the chat transport.
// A transparent AG-UI proxy at /api/copilotkit whose single `default` agent is an
// HttpAgent pointed at the UNTOUCHED /api/agui bridge above. NO LLM key, NO model,
// NO serviceAdapter on the Runtime — grounding stays 100% server-side.
await registerCopilotRuntime(app);

// --- Conversation persistence (Phase 5) — thread store for Beat 4 ----------
// History-only, file-backed store keyed by threadId: messages + the per-turn
// grounding state (citedNodeIds/isFallback) the bridge already produced. These
// routes NEVER touch Neo4j, run no Cypher, and do NOT change the grounded
// /api/agui bridge — grounding stays 100% server-side. Persistence is layered
// AROUND the bridge so a reload / thread-switch restores chat + citation chips.
app.get("/api/threads", async () => ({ threads: listThreads() }));

app.post<{ Body: { title?: string } }>(
  "/api/threads",
  {
    schema: {
      body: {
        // title is optional (createThread supplies a default), but the body must
        // be a JSON object — a non-object/array payload is a 400, not a default.
        type: "object",
        properties: { title: { type: "string" } },
        additionalProperties: false,
      },
    },
  },
  async (req) => ({
    thread: createThread(req.body?.title),
  })
);

app.get<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
  const thread = getThread(req.params.id);
  if (!thread) {
    reply.code(404);
    return { error: "no such thread", id: req.params.id };
  }
  return { thread };
});

app.put<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
  try {
    const body = saveThreadSchema.parse(req.body ?? {});
    return { thread: saveThread(req.params.id, body) };
  } catch (err) {
    if (err instanceof ZodError) {
      reply.code(400);
      return { error: "invalid thread snapshot", issues: err.issues };
    }
    throw err;
  }
});

app.delete<{ Params: { id: string } }>("/api/threads/:id", async (req, reply) => {
  const ok = deleteThread(req.params.id);
  if (!ok) reply.code(404);
  return { deleted: ok, id: req.params.id };
});

// --- Generative dashboards (@rnd/dashboards) — publish/save/share + schedules -
// Feature 10 (CRUD) + Feature 9 (snapshot schedules). Both are file-backed stores
// that persist the INERT DashboardSpec + TRUSTED audit and the pure orchestration
// config for headless recomposition. NEITHER writes a graph triple: the saved spec
// is re-validated by the SAME grounding schema used at compose time, and a schedule
// only decides WHEN a board recomposes (via the unchanged grounded composer). The
// "Send → Review" governance wrap routes a review request through the EXISTING HITL
// queue (record-decision-only, empty ops) — reversible + reviewer-stamped, no write.

// F10 — saved dashboards CRUD.
app.get("/api/dashboards", async () => ({ dashboards: listDashboards() }));

app.get<{ Params: { id: string } }>("/api/dashboards/:id", async (req, reply) => {
  const dashboard = getDashboard(req.params.id);
  if (!dashboard) {
    reply.code(404);
    return { error: "no such dashboard", id: req.params.id };
  }
  return { dashboard };
});

app.post("/api/dashboards", async (req, reply) => {
  try {
    const body = saveDashboardSchema.parse(req.body ?? {});
    return { dashboard: saveDashboard(body) };
  } catch (err) {
    if (err instanceof ZodError) {
      reply.code(400);
      return { error: "invalid dashboard", issues: err.issues };
    }
    throw err;
  }
});

app.delete<{ Params: { id: string } }>("/api/dashboards/:id", async (req, reply) => {
  const ok = deleteDashboard(req.params.id);
  if (!ok) reply.code(404);
  return { deleted: ok, id: req.params.id };
});

// F10 — "Send → Review" governance wrap. Routes a published board into the HITL
// review queue as a record-decision-only pending item (NO graph ops), reusing the
// exact enqueueFromConclusion path Beat-4 "Send → Review" uses. Reversible + reviewer
// -stamped on approval; never mutates the graph.
app.post<{ Body: { id?: string; title?: string; citedNodeIds?: string[] } }>(
  "/api/dashboards/review",
  {
    schema: {
      body: {
        type: "object",
        required: ["citedNodeIds"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          citedNodeIds: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  async (req) => {
    const { id, title, citedNodeIds } = req.body ?? {};
    const ids = citedNodeIds ?? [];
    const summary = `Review published dashboard "${title ?? id ?? "untitled"}" over ${ids.length} cited node(s).`;
    return { item: enqueueFromConclusion({ summary, citedNodeIds: ids }) };
  }
);

// F9 — dashboard snapshot schedules (list / upsert / delete) + snapshot history.
app.get("/api/dashboards/schedules", async () => ({ schedules: listSchedules() }));

app.get("/api/dashboards/snapshots", async (req) => {
  const scheduleId = (req.query as { scheduleId?: string })?.scheduleId;
  return { snapshots: listSnapshots(scheduleId) };
});

app.get<{ Params: { key: string } }>("/api/dashboards/schedules/:key", async (req, reply) => {
  const schedule = getSchedule(req.params.key);
  if (!schedule) {
    reply.code(404);
    return { error: "no such schedule", key: req.params.key };
  }
  return { schedule };
});

app.put<{ Params: { key: string } }>("/api/dashboards/schedules/:key", async (req, reply) => {
  try {
    const body = scheduleInputSchema.parse((req.body as { schedule?: unknown })?.schedule ?? req.body ?? {});
    const createdBy = (req.body as { reviewer?: { name?: string } })?.reviewer?.name;
    return { schedule: upsertSchedule(req.params.key, body, createdBy) };
  } catch (err) {
    if (err instanceof ZodError) {
      reply.code(400);
      return { error: "invalid schedule", issues: err.issues };
    }
    throw err;
  }
});

app.delete<{ Params: { key: string } }>("/api/dashboards/schedules/:key", async (req, reply) => {
  const ok = deleteSchedule(req.params.key);
  if (!ok) reply.code(404);
  return { deleted: ok, key: req.params.key };
});

// F9 — manual "Run now": recompose a scheduled board immediately (same headless
// path the ticker uses, trigger:"manual").
app.post<{ Params: { key: string } }>("/api/dashboards/schedules/:key/run-now", async (req, reply) => {
  const schedule = getSchedule(req.params.key);
  if (!schedule) {
    reply.code(404);
    return { error: "no such schedule", key: req.params.key };
  }
  const snapshot = await composeSnapshot(
    schedule.id,
    schedule.key,
    schedule.question,
    schedule.title,
    schedule.citedNodeIds,
    "manual"
  );
  return { snapshot };
});

// --- Admin config (Phase 3a) — live-editable prompts / marker / thresholds ---
// GET returns the editable config PLUS a read-only `enforced` block listing the
// structural guarantees the UI must show as LOCKED. PUT validates + persists +
// hot-applies (effective on the very next request; no restart). The enforced
// guarantees are NOT in the writable schema, so a PUT can never enable writes.
app.get("/api/admin/config", async () => ({
  config: getConfig(),
  enforced: enforcedGuarantees(),
}));

app.put("/api/admin/config", async (req, reply) => {
  try {
    const updated = setConfig(req.body);
    return { config: updated, enforced: enforcedGuarantees() };
  } catch (err) {
    if (err instanceof ZodError) {
      reply.code(400);
      return { error: "invalid config", issues: err.issues };
    }
    throw err;
  }
});

// --- FinOps (token observability) — OBSERVABILITY ONLY -----------------------
// These routes expose recorded LLM token usage + cost. They do NOT touch the
// grounding/refusal paths and cannot change what the LLM may answer. The price
// table + budget are edited through the admin config GET/PUT above (finops.*),
// so the dashboard's editable form writes back through that same hot-apply path.
app.get("/api/finops/summary", async () => finopsSummary());

app.get<{ Querystring: { limit?: string } }>("/api/finops/ledger", async (req) => {
  const raw = Number(req.query.limit ?? 100);
  // Clamp to [1, 1000] — guard against negative/NaN/absurd values from the query.
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.floor(raw)), 1000) : 100;
  return { entries: recentEntries(limit) };
});

// --- Eval scorecard (answer-quality observability) — OBSERVABILITY ONLY -------
// Mirrors the FinOps routes: per-answer faithfulness (F1), deterministic
// context-recall, and optional answer-relevancy (F2) recorded after each grounded
// answer. These routes only READ that ledger; nothing here gates the LLM or
// weakens grounding (same rule as FinOps).
app.get<{ Querystring: { limit?: string } }>("/api/eval/summary", async (req) => {
  const raw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.floor(raw)), 1000) : 50;
  return evalSummary(limit);
});

// --- HITL mutate + revert (governance) — GOVERNED, REVERSIBLE writes ----------
// These routes apply reviewer-approved changes through the AUTHORIZED writer
// (Neo4j write() + reasoner.update()), NEVER the read-only agent/MCP path. The
// agent has no tool that can reach the writer, so /api/sparql's write-guard, the
// MCP --read-only flag and ask/enforced.ts all stay untouched. SHACL flag
// resolutions are a reversible runtime overlay — the static ETL TTL is unchanged.
app.get("/api/hitl/pending", async () => {
  // Hide items that are currently applied (an approved item drops out of the
  // queue); reverting its change set brings it back. Derived from the audit log.
  const applied = appliedItemIds();
  return { items: getPendingItems().filter((i) => !applied.has(i.id)) };
});

app.post<{
  Body: {
    itemId?: string;
    decision?: "approve" | "reject" | "escalate";
    reviewer?: { name?: string; role?: string };
    purpose?: string;
  };
}>(
  "/api/hitl/apply",
  {
    schema: {
      body: {
        type: "object",
        // itemId identifies the pending item; decision gates the write (only
        // "approve" mutates). Both required so a malformed POST is a 400.
        // reviewer/purpose (F6) are optional audit metadata stamped on the change set.
        required: ["itemId", "decision"],
        properties: {
          itemId: { type: "string" },
          decision: { type: "string", enum: ["approve", "reject", "escalate"] },
          reviewer: {
            type: "object",
            properties: { name: { type: "string" }, role: { type: "string" } },
          },
          purpose: { type: "string" },
        },
      },
    },
  },
  async (req, reply) => {
    const { itemId, decision } = req.body ?? {};
    const item = itemId ? getPendingItem(itemId) : undefined;
    if (!item) {
      reply.code(404);
      return { error: "no such pending item", itemId };
    }
    // Only APPROVE mutates the graph. reject/escalate are recorded as a decision
    // by the caller (the UI's audit log) — the server makes no mutation for them.
    if (decision !== "approve") {
      return { decision: decision ?? "reject", mutated: false, itemId };
    }
    const changeSet = await hitlApply({
      title: item.title,
      description: item.description,
      targetNodeId: item.targetNodeId,
      itemId: item.id,
      forwardOps: item.forwardOps,
      inverseOps: item.inverseOps,
      reviewer: reviewerFrom(req.body?.reviewer),
      purpose: req.body?.purpose,
    });
    return { decision: "approve", mutated: true, changeSet };
  }
);

// Raise (or clear) a MANUAL reviewer flag on any node — applied immediately as a
// governed, reversible changeset through the AUTHORIZED writer (overlay-only: no
// graph data is touched, so the baseline TTL stays byte-identical). The node then
// carries the flag in /api/risk and it shows in the audit log; Revert (or
// remove:true) undoes it. The read-only agent/MCP path is never involved.
app.post<{
  Body: {
    nodeId?: string;
    flag?: string;
    reason?: string;
    remove?: boolean;
    reviewer?: { name?: string; role?: string };
    purpose?: string;
  };
}>(
  "/api/hitl/flag",
  {
    schema: {
      body: {
        type: "object",
        required: ["nodeId", "flag"],
        properties: {
          nodeId: { type: "string", minLength: 1 },
          flag: {
            type: "string",
            enum: [
              "missing-cross-source-link",
              "dangling-reference",
              "conflicting-annotation",
              "missing-provenance",
              "stale-ontology-version",
              "duplicate-record",
              "missing-followup",
            ],
          },
          reason: { type: "string" },
          remove: { type: "boolean" },
          reviewer: {
            type: "object",
            properties: { name: { type: "string" }, role: { type: "string" } },
          },
          purpose: { type: "string" },
        },
      },
    },
  },
  async (req) => {
    const { nodeId, flag, reason, remove } = req.body ?? {};
    const id = nodeId!;
    const f = flag as RiskFlag;
    const reviewer = reviewerFrom(req.body?.reviewer);
    const purpose = req.body?.purpose;
    const add: ChangeOp = { op: "addManualFlag", nodeId: id, flag: f, reason };
    const rem: ChangeOp = { op: "removeManualFlag", nodeId: id, flag: f };
    const changeSet = await hitlApply(
      remove
        ? {
            title: `Clear reviewer flag (${id})`,
            description: `A reviewer cleared the manual "${f}" flag on ${id}.`,
            targetNodeId: id,
            forwardOps: [rem],
            inverseOps: [add],
            reviewer,
            purpose,
          }
        : {
            title: `Raise reviewer flag (${id})`,
            description:
              `A reviewer flagged ${id} as "${f}"` + (reason ? `: ${reason}` : "") + ".",
            targetNodeId: id,
            forwardOps: [add],
            inverseOps: [rem],
            reviewer,
            purpose,
          },
    );
    return { flagged: !remove, changeSet };
  }
);

// Attach (or remove) a REVIEWER TAG on an edge — applied immediately as a governed,
// reversible changeset through the AUTHORIZED writer (overlay-only: no Neo4j data is
// touched, so the baseline stays byte-identical). The tag then rides on the edge in
// /api/graph and shows in the audit log; Revert (or remove:true) undoes it. Mirror of
// /api/hitl/flag, keyed on the edge triple (source, kind, target).
app.post<{
  Body: {
    source?: string;
    target?: string;
    kind?: string;
    tag?: string;
    reason?: string;
    remove?: boolean;
    reviewer?: { name?: string; role?: string };
    purpose?: string;
  };
}>(
  "/api/hitl/edge-tag",
  {
    schema: {
      body: {
        type: "object",
        required: ["source", "target", "kind", "tag"],
        properties: {
          source: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 },
          kind: { type: "string", minLength: 1 },
          tag: { type: "string", minLength: 1, maxLength: 60 },
          reason: { type: "string" },
          remove: { type: "boolean" },
          reviewer: {
            type: "object",
            properties: { name: { type: "string" }, role: { type: "string" } },
          },
          purpose: { type: "string" },
        },
      },
    },
  },
  async (req) => {
    const { source, target, kind, tag, reason, remove } = req.body ?? {};
    const s = source!;
    const t = target!;
    const k = kind as EdgeKind;
    const g = tag!;
    const reviewer = reviewerFrom(req.body?.reviewer);
    const purpose = req.body?.purpose;
    const edge = `${s} -[${k}]-> ${t}`;
    const add: ChangeOp = { op: "addEdgeTag", source: s, target: t, kind: k, tag: g, reason };
    const rem: ChangeOp = { op: "removeEdgeTag", source: s, target: t, kind: k, tag: g };
    const changeSet = await hitlApply(
      remove
        ? {
            title: `Remove edge tag (${g})`,
            description: `A reviewer removed the "${g}" tag on ${edge}.`,
            targetNodeId: s,
            forwardOps: [rem],
            inverseOps: [add],
            reviewer,
            purpose,
          }
        : {
            title: `Tag edge (${g})`,
            description:
              `A reviewer tagged ${edge} as "${g}"` + (reason ? `: ${reason}` : "") + ".",
            targetNodeId: s,
            forwardOps: [add],
            inverseOps: [rem],
            reviewer,
            purpose,
          },
    );
    return { tagged: !remove, changeSet };
  }
);

// Enqueue a grounded conclusion as a human-review request. This records a review
// REQUEST only — it carries NO graph ops (forwardOps/inverseOps are empty), so it
// can never mutate the graph; the authorized writer is untouched. The new item is
// appended to the pending queue (GET /api/hitl/pending).
app.post<{ Body: { summary?: string; confidence?: number; citedNodeIds?: string[] } }>(
  "/api/hitl/enqueue",
  {
    schema: {
      body: {
        type: "object",
        required: ["summary", "citedNodeIds"],
        properties: {
          summary: { type: "string", minLength: 1 },
          citedNodeIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
      },
    },
  },
  async (req) => {
    const { summary, confidence, citedNodeIds } = req.body ?? {};
    return {
      item: enqueueFromConclusion({
        summary: summary!,
        confidence,
        citedNodeIds: citedNodeIds ?? [],
      }),
    };
  }
);

app.get("/api/hitl/changesets", async () => ({ changeSets: listChangeSets() }));

// Suggested follow-up questions for a governed change (audit-log "ask about this
// change"). Returns 3-4 SHORT reviewer questions, each answerable by the EXISTING
// grounded agent from the live read-only graph (the change is already reflected
// there once applied). Live LLM with a deterministic templated fallback — this
// route adds NO new answer path, only prompts. Never mutates anything.
app.post<{ Body: { changeSetId?: string } }>(
  "/api/hitl/suggest-questions",
  {
    schema: {
      body: {
        type: "object",
        required: ["changeSetId"],
        properties: { changeSetId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const id = req.body?.changeSetId;
    const cs = listChangeSets().find((c) => c.id === id);
    if (!cs) {
      reply.code(404);
      return { error: "no such change set", changeSetId: id };
    }
    return await suggestChangeQuestions(cs);
  }
);

app.post<{ Body: { changeSetId?: string } }>(
  "/api/hitl/revert",
  {
    schema: {
      body: {
        type: "object",
        required: ["changeSetId"],
        properties: { changeSetId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
  const id = req.body?.changeSetId;
  if (!id) {
    reply.code(400);
    return { error: "changeSetId required" };
  }
  const reverted = await hitlRevert(id);
  if (!reverted) {
    reply.code(404);
    return { error: "no such change set", changeSetId: id };
  }
  return { changeSet: reverted };
  }
);

// --- Public config slice — the single configured refusal marker the web UI uses
// to detect refusals (same source the agent emits + the bridge gates on). ------
app.get("/api/config/public", async () => ({
  notInGraphMarker: getConfig().notInGraphMarker,
  // F6 — the review-purpose vocabulary the reviewer selector offers + stamps.
  purposes: getConfig().purposePolicies.purposes,
}));

// --- Competitive-pipeline overlay (F8) — SYNTHETIC, grounding-safe -----------
// A separate, clearly-labelled overlay payload (every node synthetic:true) merged
// CLIENT-SIDE only. These ids are NEVER written to Neo4j, so they can never be in
// loadValidNodeIds() and the grounded agent can never cite one. Baseline untouched.
app.get("/api/overlay/competitive", async () => getCompetitiveOverlay());

const start = async () => {
  try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(
      `BFF on :${config.port} · provider=${config.narrator.provider} · model=${config.narrator.model}`
    );
    // Warm the canonical RDF reasoner (load + entail + first SHACL) at boot so
    // the first inference request is fast and a reasoner misconfig is loud, not
    // silent. Non-fatal: log and continue (the lazy singleton retries per request).
    try {
      const r = await getCanonicalReasoner();
      app.log.info(`reasoner: canonical store warmed · backend=${r.backend}`);
      // Rebuild the HITL resolved-flag overlay from any persisted, applied
      // changesets so a restart restores suppressed flags (data ops already live
      // durably in Neo4j + the RDF store).
      hitlRefreshFromDisk();
    } catch (err) {
      app.log.warn(`reasoner warm-up failed (will retry lazily): ${err instanceof Error ? err.message : String(err)}`);
    }
    // One-shot live-readiness self-check so a misconfigured demo is loud, not silent.
    const diag = await getLiveStatus();
    const line = `live-readiness: ${diag.live ? "READY" : "NOT READY"} · ${diag.detail}`;
    if (diag.live) app.log.info(line);
    else app.log.warn(line);
    // Start the routine scheduler — runs due playbook schedules on their cadence
    // while the server is up (unchanged grounded runner; non-blocking HITL).
    startScheduler();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Process-level safety nets so nothing dies silently. Located logs pinpoint the
// origin; an uncaught exception leaves the process in an unknown state, so we log
// and exit (matching the boot-failure path); a rejection is logged and survived.
process.on("unhandledRejection", (reason) => {
  log.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  log.error("uncaughtException:", err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await closeDriver();
    process.exit(0);
  });
}

start().catch((e) => {
  // A rejection outside start()'s own try/catch (e.g. before listen) would
  // otherwise be an unhandled promise rejection — fail loud instead.
  app.log.error(e);
  process.exit(1);
});
