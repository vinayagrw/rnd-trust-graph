import type {
  CompetitiveOverlay,
  Playbook,
  PlaybookDraft,
  PlaybookDraftResponse,
  PlaybookEvent,
  PlaybookRoutine,
  RoutineRun,
  GraphPayload,
  ExplanationPath,
  Provenance,
  RiskReport,
  SafetyReport,
  SafetyAudit,
  SafetyRemediation,
  SafetyTrendPoint,
  ResolveResult,
  GatedConclusion,
  StreamEvent,
  LiveStatus,
  HitlPendingItem,
  ChangeSet,
  RiskFlag,
  EdgeKind,
  FinOpsConfig,
  FinOpsEntry,
  FinOpsSummary,
  EvalSummary,
  DashboardSpec,
  DashboardAudit,
  SavedDashboard,
  DashboardSchedule,
  DashboardSnapshot,
} from "@rnd/shared";
import { log } from "./lib/log.js";

// Re-export the FinOps wire types so existing consumers can keep importing them
// from "../api.js". The single source of truth is @rnd/shared — these used to be
// re-declared here and had already drifted (FinOpsSurface was widened to `string`).
export type {
  FinOpsModelPrice,
  FinOpsConfig,
  FinOpsSurface,
  FinOpsEntry,
  FinOpsBreakdownRow,
  FinOpsSummary,
  EvalEntry,
  EvalSummary,
} from "@rnd/shared";

const base = "/api";

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

// --- Admin config (Phase 3a API consumed by the Phase 3b admin panel) -------
// FinOpsConfig / FinOpsModelPrice come from @rnd/shared (imported + re-exported
// at the top of this file) — the single source of truth for the wire contract.

/** EDITABLE config — prompts, refusal marker, risk thresholds, and FinOps. */
export interface AdminConfig {
  narratorSystemPrompt: string;
  askInstruction: string;
  notInGraphMarker: string;
  risk: {
    readinessBase: number;
    penaltyPerFlag: number;
    staleBeforeYear: number;
    statisticalConfidence: number;
  };
  reasonerBackend?: "oxigraph" | "fuseki";
  finops: FinOpsConfig;
  /** Model card (responsible-AI disclosure) — display-only, never gates the LLM.
   *  Optional so older saved configs (predating this field) still parse. */
  modelCard?: {
    name: string;
    version: string;
    provider: string;
    intendedUse: string;
    evaluation: string;
    limitations: string;
    trainingCutoff: string;
  };
}

/** READ-ONLY structural guarantees — display-only, NEVER editable. */
export interface EnforcedGuarantees {
  neo4jReadOnly: boolean;
  allowedTools: string[];
  excludedWriteTool: string;
  groundingRefusalEnforced: boolean;
  note: string;
}

export interface AdminConfigResponse {
  config: AdminConfig;
  enforced: EnforcedGuarantees;
}

/** A single zod issue surfaced by a 400 on PUT (path → message, per field). */
export interface ZodIssue {
  path: (string | number)[];
  message: string;
  code?: string;
}

/** Discriminated result so the panel can render inline field errors on 400. */
export type SaveConfigResult =
  | { ok: true; data: AdminConfigResponse }
  | { ok: false; status: number; error: string; issues: ZodIssue[] };

export const adminApi = {
  get: () => getJSON<AdminConfigResponse>("/admin/config"),
  /** PARTIAL patch. On 400 returns the zod issues (not thrown) for inline use. */
  async put(patch: Partial<AdminConfig>): Promise<SaveConfigResult> {
    const res = await fetch(`${base}/admin/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      return { ok: true, data: (await res.json()) as AdminConfigResponse };
    }
    let error = `PUT /admin/config -> ${res.status}`;
    let issues: ZodIssue[] = [];
    try {
      const body = (await res.json()) as { error?: string; issues?: ZodIssue[] };
      if (body.error) error = body.error;
      if (Array.isArray(body.issues)) issues = body.issues;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    return { ok: false, status: res.status, error, issues };
  },
};

// --- Conversation persistence (Phase 5) — Beat-4 thread store --------------
// History-only store on the BFF (messages + per-turn grounding). These calls
// NEVER touch Neo4j and do NOT change the grounded /api/agui bridge; they just
// let a reload / thread-switch restore the chat + citation chips.

/** Per-turn grounding the bridge published (drives chips + canvas highlight). */
export interface ThreadGrounding {
  citedNodeIds: string[];
  isFallback: boolean;
}

/** A persisted chat message (AG-UI/CopilotKit shape, kept loose for round-trip). */
export interface ThreadMessage {
  id: string;
  role: string;
  content?: string;
  [k: string]: unknown;
}

export interface ThreadRecord {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ThreadMessage[];
  grounding: ThreadGrounding;
}

export interface ThreadSummary {
  threadId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export const threadsApi = {
  list: () => getJSON<{ threads: ThreadSummary[] }>("/threads").then((r) => r.threads),
  get: (id: string) =>
    getJSON<{ thread: ThreadRecord }>(`/threads/${encodeURIComponent(id)}`).then((r) => r.thread),
  async create(title?: string): Promise<ThreadRecord> {
    const res = await fetch(`${base}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`POST /threads -> ${res.status}`);
    return ((await res.json()) as { thread: ThreadRecord }).thread;
  },
  async save(
    id: string,
    snapshot: { title?: string; messages: ThreadMessage[]; grounding: ThreadGrounding }
  ): Promise<ThreadRecord> {
    const res = await fetch(`${base}/threads/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    if (!res.ok) throw new Error(`PUT /threads/${id} -> ${res.status}`);
    return ((await res.json()) as { thread: ThreadRecord }).thread;
  },
  async remove(id: string): Promise<boolean> {
    const res = await fetch(`${base}/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
    // 404 means "already gone" — treat as success and do NOT parse the body (a
    // 404 may have an empty/non-JSON body, which would make res.json() reject).
    if (res.status === 404) return true;
    if (!res.ok) throw new Error(`DELETE /threads/${id} -> ${res.status}`);
    return ((await res.json()) as { deleted: boolean }).deleted;
  },
};

// --- FinOps (token observability) — read-only summary + ledger --------------
// The FinOps wire types (FinOpsSurface/Entry/BreakdownRow/Summary/Config/
// ModelPrice) live in @rnd/shared and are imported + re-exported at the top of
// this file — single source of truth, no local re-declaration. These calls NEVER
// change what the LLM may answer; they only read recorded usage. The price-table
// + budget are EDITED through adminApi.put({ finops }), the same hot-apply path.

export const finopsApi = {
  summary: () => getJSON<FinOpsSummary>("/finops/summary"),
  ledger: (limit = 100) =>
    getJSON<{ entries: FinOpsEntry[] }>(`/finops/ledger?limit=${limit}`).then((r) => r.entries),
};

// --- Eval scorecard (answer-quality observability) — read-only summary -------
// Per-answer faithfulness (F1) + deterministic context-recall + optional
// answer-relevancy (F2), recorded after each grounded answer. Read-only; like
// FinOps it never changes what the LLM may answer.
export const evalApi = {
  summary: (limit = 50) => getJSON<EvalSummary>(`/eval/summary?limit=${limit}`),
};

// --- HITL mutate + revert (governed, reversible writes) ---------------------
// The pending queue + audit log for the human-in-the-loop governance surface.
// Approving an item mutates the graph via the AUTHORIZED writer on the BFF
// (Neo4j write() + RDF store update) — NEVER the read-only agent/MCP path —
// and returns the resulting ChangeSet. Revert replays its inverse ops to restore
// exact prior state. The web client just drives the queue + renders the audit.

export type HitlDecision = "approve" | "reject" | "escalate";

/** Result of POST /api/hitl/apply. Only `approve` mutates (and returns a changeSet). */
export interface HitlApplyResult {
  decision: HitlDecision;
  mutated: boolean;
  itemId?: string;
  changeSet?: ChangeSet;
}

/** Active reviewer identity + purpose (F6), set by the ReviewerProvider. Stamped
 *  onto every governed HITL write (apply / flag) so the audit trail records who/why
 *  without threading the identity through each call site. Empty by default → the
 *  server falls back to the legacy "demo-reviewer" actor. */
let reviewerCtx: { reviewer?: { name: string; role: string }; purpose?: string } = {};
export function setReviewerContext(ctx: {
  reviewer?: { name: string; role: string };
  purpose?: string;
}): void {
  reviewerCtx = ctx;
}

export const hitlApi = {
  pending: () => getJSON<{ items: HitlPendingItem[] }>("/hitl/pending").then((r) => r.items),
  changesets: () =>
    getJSON<{ changeSets: ChangeSet[] }>("/hitl/changesets").then((r) => r.changeSets),
  async apply(itemId: string, decision: HitlDecision): Promise<HitlApplyResult> {
    const res = await fetch(`${base}/hitl/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, decision, ...reviewerCtx }),
    });
    if (!res.ok) throw new Error(`POST /hitl/apply -> ${res.status}`);
    return (await res.json()) as HitlApplyResult;
  },
  async revert(changeSetId: string): Promise<ChangeSet> {
    const res = await fetch(`${base}/hitl/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changeSetId }),
    });
    if (!res.ok) throw new Error(`POST /hitl/revert -> ${res.status}`);
    return ((await res.json()) as { changeSet: ChangeSet }).changeSet;
  },
  /** Raise (or clear with `remove`) a MANUAL reviewer flag on a node. Applied
   *  immediately as a governed, reversible changeset (overlay-only — no graph data
   *  touched); the node then carries the flag in /api/risk and it lists in the
   *  audit log. Returns the resulting ChangeSet (revertable by id). */
  async flag(input: {
    nodeId: string;
    flag: RiskFlag;
    reason?: string;
    remove?: boolean;
  }): Promise<ChangeSet> {
    const res = await fetch(`${base}/hitl/flag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, ...reviewerCtx }),
    });
    if (!res.ok) throw new Error(`POST /hitl/flag -> ${res.status}`);
    return ((await res.json()) as { changeSet: ChangeSet }).changeSet;
  },
  /** Attach (or clear with `remove`) a REVIEWER TAG on an edge, keyed by its triple
   *  (source, kind, target). Applied immediately as a governed, reversible changeset
   *  (overlay-only — no Neo4j data touched); the tag then rides on the edge in
   *  /api/graph and lists in the audit log. Returns the resulting ChangeSet. */
  async edgeTag(input: {
    source: string;
    target: string;
    kind: EdgeKind;
    tag: string;
    reason?: string;
    remove?: boolean;
  }): Promise<ChangeSet> {
    const res = await fetch(`${base}/hitl/edge-tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, ...reviewerCtx }),
    });
    if (!res.ok) throw new Error(`POST /hitl/edge-tag -> ${res.status}`);
    return ((await res.json()) as { changeSet: ChangeSet }).changeSet;
  },
  /** Suggested follow-up questions for a governed change (audit-log "ask about
   *  this change"). Returns 3-4 short, grounded-answerable reviewer questions
   *  (live LLM, with a deterministic templated fallback). `grounded` is false
   *  when the templates were used. These are only prompts — the existing grounded
   *  agent answers them; no new answer path. */
  async suggestQuestions(
    changeSetId: string
  ): Promise<{ questions: string[]; grounded: boolean }> {
    const res = await fetch(`${base}/hitl/suggest-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changeSetId }),
    });
    if (!res.ok) throw new Error(`POST /hitl/suggest-questions -> ${res.status}`);
    return (await res.json()) as { questions: string[]; grounded: boolean };
  },
  /** Enqueue a grounded conclusion as a human-review request. Records a review
   *  request only (no graph ops) and returns the appended pending item. */
  async enqueue(input: {
    summary: string;
    confidence?: number;
    citedNodeIds: string[];
  }): Promise<HitlPendingItem> {
    const res = await fetch(`${base}/hitl/enqueue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`POST /hitl/enqueue -> ${res.status}`);
    return ((await res.json()) as { item: HitlPendingItem }).item;
  },
};

export const api = {
  health: () => getJSON<{ ok: boolean; liveMode: boolean; model: string }>("/health"),
  // Public config slice: the single configured refusal marker (same one the agent
  // emits + the bridge gates on) so the UI's refusal detection never desyncs.
  publicConfig: () =>
    getJSON<{
      notInGraphMarker: string;
      purposes?: { id: string; label: string; description: string }[];
    }>("/config/public"),
  diag: () => getJSON<LiveStatus>("/diag"),
  graph: (scope: "hero" | "all" = "all") =>
    getJSON<GraphPayload>(`/graph?scope=${scope}`),
  // F8 — synthetic competitive-pipeline overlay (merged client-side; never citable).
  competitiveOverlay: () => getJSON<CompetitiveOverlay>("/overlay/competitive"),
  explain: () => getJSON<ExplanationPath>("/explain"),
  provenance: (id: string) => getJSON<Provenance>(`/provenance/${encodeURIComponent(id)}`),
  risk: () => getJSON<RiskReport>("/risk"),
  gated: () => getJSON<GatedConclusion[]>("/gated"),
  // UC4 — subject-safety radar (dedicated safety reasoner + Neo4j inventory).
  safety: () => getJSON<SafetyReport>("/safety"),
  // The reproducible audit behind the readiness score (assessed/unsafe/perSubject).
  safetyAudit: () => getJSON<SafetyAudit>("/safety/audit"),
  // F1 — the subject-safety subgraph (:Safety nodes/edges) for the safety canvas.
  safetyGraph: () => getJSON<GraphPayload>("/safety/graph"),
  // F2 — agent-drafted, propose-only remediations for every finding (no mutation).
  safetyRemediation: () =>
    getJSON<{ items: SafetyRemediation[] }>("/safety/remediation").then((r) => r.items),
  // F2 — route ONE finding's remediation into the HITL queue (propose-only item).
  async routeRemediation(findingId: string): Promise<{ routed: boolean }> {
    const res = await fetch(`${base}/safety/remediation/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findingId }),
    });
    if (!res.ok) throw new Error(`POST /safety/remediation/route -> ${res.status}`);
    return (await res.json()) as { routed: boolean };
  },
  // Readiness TREND — persisted score history; a correction/revert bends the line.
  safetyTrend: () =>
    getJSON<{ points: SafetyTrendPoint[] }>("/safety/trend").then((r) => r.points),
  // F2 — APPLY one finding's governed correction (clears the finding, moves the
  // score). Returns the fresh report so the caller can re-render the whole beat.
  async applyRemediation(findingId: string): Promise<{ applied: boolean; report: SafetyReport }> {
    const res = await fetch(`${base}/safety/remediation/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findingId }),
    });
    if (!res.ok) throw new Error(`POST /safety/remediation/apply -> ${res.status}`);
    return (await res.json()) as { applied: boolean; report: SafetyReport };
  },
  // F2 — REVERT a previously-applied correction (byte-identical restore).
  async revertRemediation(findingId: string): Promise<{ reverted: boolean; report: SafetyReport }> {
    const res = await fetch(`${base}/safety/remediation/revert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ findingId }),
    });
    if (!res.ok) throw new Error(`POST /safety/remediation/revert -> ${res.status}`);
    return (await res.json()) as { reverted: boolean; report: SafetyReport };
  },
  resolve: (nodeId: string) =>
    getJSON<ResolveResult>(`/resolve?nodeId=${encodeURIComponent(nodeId)}`),
  // W3C/RDF cameo — live hero subgraph as Turtle text (NOT JSON).
  rdf: () =>
    fetch(`${base}/rdf`).then((r) => {
      if (!r.ok) throw new Error(`/rdf -> ${r.status}`);
      return r.text();
    }),
};

/**
 * Per-node AI explanation (SSE). Streams a grounded explanation of one node —
 * token / citations / done{isFallback} events, same shape as /narrate. Returns
 * an unsubscribe fn. The BFF enforces grounding + falls back to a templated
 * explanation; the caller just renders the stream + the grounded/fallback badge.
 */
export function explainNode(
  nodeId: string,
  onEvent: (e: StreamEvent) => void
): () => void {
  return stream("/explain-node", { nodeId }, onEvent);
}

/**
 * Grounded AI explanation of ONE subject-safety finding (SSE, UC4). Same
 * token/citations/done{isFallback,reason} shape as /explain-node, but scoped to
 * the finding's evidence path: the BFF lets the model cite ONLY the subject, its
 * 1-hop Neo4j neighbours, and nodes on the path, refusing any drift to a
 * deterministic template. Returns an unsubscribe fn.
 */
export function explainSafetyFinding(
  subjectId: string,
  onEvent: (e: StreamEvent) => void
): () => void {
  return stream("/safety/explain", { subjectId }, onEvent);
}

/**
 * F4 — grounded "Ask the radar" (SSE). Reuses the read-only /ask agent (Agent SDK
 * + Neo4j MCP, `--read-only`) now that subjects are projected into Neo4j: the
 * answer is grounded on returned rows, cites only real node ids, and refuses with
 * the configured NOT_IN_GRAPH marker when the graph can't support it. Same event
 * shape as /ask (route/step/cypher/rows/citations/faithfulness/token/done). Returns
 * an unsubscribe fn — the beat also caps it with its own timeout since the local
 * `claude` CLI can stall.
 */
export function askSafety(
  question: string,
  onEvent: (e: StreamEvent) => void
): () => void {
  return stream("/ask", { beatId: "uc4-safety", question }, onEvent);
}

/**
 * Literature synthesis (SSE, F7). Streams a source-ranked, inline-cited synthesis
 * over the graph's LiteratureAbstract nodes — `ranked` (sources) then
 * token/citations/done, same shape as /narrate. The BFF enforces every inline
 * [LIT-PMID-…] ⊆ the supplied ids and falls back to a deterministic template; the
 * caller renders the stream + the grounded/fallback badge. Returns an unsubscribe fn.
 */
export function litsynth(
  input: { focusNodeId?: string; topic?: string },
  onEvent: (e: StreamEvent) => void
): () => void {
  return stream("/litsynth", input, onEvent);
}

/** F5 — playbooks. `listPlaybooks` returns the curated definitions; `runPlaybook`
 *  streams step progress (`step-started` / `step-result` / `done` with the
 *  assembled dossier). The stream uses the same SSE parser as /ask; the events are
 *  a different shape (PlaybookEvent), so we cast at this boundary. */
/** POST/PUT/DELETE a playbook mutation; throws with the server's error message
 *  (incl. Zod issues shape) so the authoring UI can surface a real reason. */
async function mutate<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `${method} ${path} -> ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export const playbookApi = {
  list: () => getJSON<{ playbooks: Playbook[] }>("/playbooks").then((r) => r.playbooks),
  run: (playbookId: string, onEvent: (e: PlaybookEvent) => void): (() => void) =>
    stream("/playbooks/run", { playbookId }, onEvent as unknown as (e: StreamEvent) => void),
  /** AI-assisted authoring: draft a playbook from a natural-language goal. */
  draft: (goal: string) => mutate<PlaybookDraftResponse>("/playbooks/draft", "POST", { goal }),
  /** Refine an existing draft from a free-text instruction. */
  refine: (draft: PlaybookDraft, instruction: string) =>
    mutate<PlaybookDraftResponse>("/playbooks/refine", "POST", { draft, instruction }),
  /** Persist a new custom playbook. `playbook` = { id, title, description, steps }. */
  create: (playbook: Pick<Playbook, "id" | "title" | "description" | "steps">, reviewer?: string) =>
    mutate<{ playbook: Playbook }>("/playbooks", "POST", { playbook, reviewer: { name: reviewer } }).then(
      (r) => r.playbook,
    ),
  /** Update an existing custom playbook. */
  update: (
    id: string,
    playbook: Pick<Playbook, "title" | "description" | "steps">,
    reviewer?: string,
  ) =>
    mutate<{ playbook: Playbook }>(`/playbooks/${encodeURIComponent(id)}`, "PUT", {
      playbook,
      reviewer: { name: reviewer },
    }).then((r) => r.playbook),
  /** Delete a custom playbook (curated ids are rejected server-side). */
  remove: (id: string) => mutate<{ deleted: boolean }>(`/playbooks/${encodeURIComponent(id)}`, "DELETE"),
};

/** Routines — schedule a playbook to run on a cadence (in-process scheduler). */
export const routineApi = {
  list: () => getJSON<{ routines: PlaybookRoutine[] }>("/routines").then((r) => r.routines),
  /** Run history, optionally scoped to one routine. */
  runs: (routineId?: string) =>
    getJSON<{ runs: RoutineRun[] }>(
      `/routines/runs${routineId ? `?routineId=${encodeURIComponent(routineId)}` : ""}`,
    ).then((r) => r.runs),
  /** Create-or-update the routine for a playbook. */
  save: (
    playbookId: string,
    routine: { cadence: PlaybookRoutine["cadence"]; cron: string; enabled: boolean },
    reviewer?: string,
  ) =>
    mutate<{ routine: PlaybookRoutine }>(
      `/playbooks/${encodeURIComponent(playbookId)}/routine`,
      "PUT",
      { routine, reviewer: { name: reviewer } },
    ).then((r) => r.routine),
  /** Remove a playbook's routine. */
  remove: (playbookId: string) =>
    mutate<{ deleted: boolean }>(`/playbooks/${encodeURIComponent(playbookId)}/routine`, "DELETE"),
  /** Manual "Run now" — same headless path as the scheduler (trigger:"manual"). */
  runNow: (playbookId: string) =>
    mutate<{ ran: boolean }>(`/playbooks/${encodeURIComponent(playbookId)}/run-now`, "POST"),
};

/** Summary row for the saved-dashboard list (without the heavy spec/audit). */
export interface SavedDashboardSummary {
  id: string;
  title: string;
  savedAt: number;
  updatedAt: number;
  widgetCount: number;
  savedBy?: string;
}

/**
 * Generative dashboards (@rnd/dashboards) — publish/save/share (F10) + snapshot
 * schedules (F9). The `save` payload is the INERT DashboardSpec + the TRUSTED audit
 * that rode alongside it on the `render_dashboard` tool call; the server re-validates
 * the spec with the same grounding schema. NONE of these calls write a graph triple.
 * `review` routes a published board into the EXISTING HITL queue (record-decision-only)
 * — the same "Send → Review" governance path Beat 4 uses.
 */
export const dashboardsApi = {
  list: () =>
    getJSON<{ dashboards: SavedDashboardSummary[] }>("/dashboards").then((r) => r.dashboards),
  get: (id: string) =>
    getJSON<{ dashboard: SavedDashboard }>(`/dashboards/${encodeURIComponent(id)}`).then(
      (r) => r.dashboard,
    ),
  save: (input: { id?: string; title: string; spec: DashboardSpec; audit?: DashboardAudit; savedBy?: string }) =>
    mutate<{ dashboard: SavedDashboard }>("/dashboards", "POST", input).then((r) => r.dashboard),
  remove: (id: string) =>
    mutate<{ deleted: boolean }>(`/dashboards/${encodeURIComponent(id)}`, "DELETE").then(
      (r) => r.deleted,
    ),
  /** "Send → Review": route a published board into the HITL queue (no graph write). */
  sendToReview: (input: { id?: string; title?: string; citedNodeIds: string[] }) =>
    mutate<{ item: HitlPendingItem }>("/dashboards/review", "POST", input).then((r) => r.item),
  // --- F9 snapshot schedules -------------------------------------------------
  schedules: () =>
    getJSON<{ schedules: DashboardSchedule[] }>("/dashboards/schedules").then((r) => r.schedules),
  snapshots: (scheduleId?: string) =>
    getJSON<{ snapshots: DashboardSnapshot[] }>(
      `/dashboards/snapshots${scheduleId ? `?scheduleId=${encodeURIComponent(scheduleId)}` : ""}`,
    ).then((r) => r.snapshots),
  saveSchedule: (
    key: string,
    schedule: {
      title: string;
      question: string;
      citedNodeIds: string[];
      cadence: DashboardSchedule["cadence"];
      cron: string;
      enabled: boolean;
    },
    reviewer?: string,
  ) =>
    mutate<{ schedule: DashboardSchedule }>(
      `/dashboards/schedules/${encodeURIComponent(key)}`,
      "PUT",
      { schedule, reviewer: { name: reviewer } },
    ).then((r) => r.schedule),
  removeSchedule: (key: string) =>
    mutate<{ deleted: boolean }>(
      `/dashboards/schedules/${encodeURIComponent(key)}`,
      "DELETE",
    ).then((r) => r.deleted),
  /** Manual "Run now" — recompose immediately (same headless path as the scheduler). */
  runNow: (key: string) =>
    mutate<{ snapshot: DashboardSnapshot | null }>(
      `/dashboards/schedules/${encodeURIComponent(key)}/run-now`,
      "POST",
    ).then((r) => r.snapshot),
};

/**
 * Subscribe to an SSE endpoint (/narrate, /ask). Returns an unsubscribe fn.
 * Falls through to onEvent with {type:'error'} if the stream dies — the caller
 * decides whether to show the cached fallback.
 */
export function stream(
  path: string,
  body: Record<string, unknown>,
  onEvent: (e: StreamEvent) => void
): () => void {
  const controller = new AbortController();
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.body) throw new Error("no stream body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      // Track whether a terminal event (done/error) actually reached the caller, so
      // we can guarantee the UI leaves its "streaming" state even if the terminal
      // frame never parsed (see synthetic flush after the loop).
      let sawTerminal = false;
      const emit = (e: StreamEvent) => {
        if (e.type === "done" || e.type === "error") sawTerminal = true;
        onEvent(e);
      };
      // Parse one SSE frame defensively — a single malformed frame must not abort
      // the whole stream (it would surface as one generic error and drop the rest).
      const emitFrame = (frame: string) => {
        const line = frame.replace(/^data:\s?/, "").trim();
        if (!line) return;
        try {
          emit(JSON.parse(line) as StreamEvent);
        } catch (e) {
          log.warn("[stream] skipped malformed SSE frame", e);
        }
      };
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) emitFrame(frame);
      }
      // Flush any trailing buffered frame — the terminal event (e.g.
      // done{isFallback}) may not be followed by a "\n\n" delimiter, and would
      // otherwise be lost, leaving the UI stuck in its "streaming" state.
      if (buf.trim()) emitFrame(buf);
      // Safety net: the connection closed but no done/error ever reached the caller
      // (e.g. a corrupted terminal frame was swallowed above). Synthesise a terminal
      // event so the UI un-sticks and shows the safe cached fallback rather than
      // spinning forever.
      if (!sawTerminal) emit({ type: "done", isFallback: true });
    })
    .catch((err) => onEvent({ type: "error", message: String(err) }));
  return () => controller.abort();
}
