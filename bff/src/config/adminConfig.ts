/**
 * Admin config — live-editable prompts, the refusal marker, and risk thresholds.
 *
 * Phase 3a goal: move the values that a presenter might want to tune (narration
 * prompt, /ask instruction, the "not in graph" refusal marker, and the risk
 * scoring constants) out of hardcoded literals and into a PERSISTED, HOT-APPLIED
 * config behind GET/PUT /api/admin/config — so they can be edited live with no
 * redeploy.
 *
 * DEFENCE-IN-DEPTH (non-negotiable): prompts are *advisory*. The structural
 * trust guarantees — Neo4j MCP read-only enforcement (`--read-only`), the
 * read-only tool allow-list (only get_neo4j_schema + read_neo4j_cypher; the
 * write tool is NEVER allowed), and the off-path-citation refusal in
 * `validateGrounding` — are ENFORCED IN CODE and are deliberately NOT part of
 * this editable schema. Even a maliciously weakened prompt cannot make the agent
 * write to the graph or cite an off-graph entity, because those gates do not
 * read from this config. The `enforced` block below is exposed read-only so the
 * admin UI can DISPLAY the locked guarantees, but nothing here can toggle them.
 *
 * Hot-apply: the effective config is read at REQUEST time. The on-disk JSON is
 * the source of truth; we cache the parsed value and invalidate the cache on
 * every successful PUT, so an edit takes effect on the very next request with no
 * BFF restart.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NOT_IN_GRAPH_MARKER } from "@rnd/shared";

const here = dirname(fileURLToPath(import.meta.url));
/** Persisted overrides live at bff/admin-config.json (gitignore-safe, created on
 *  first write). Deleting it falls back to byte-identical DEFAULTS.
 *  An `ADMIN_CONFIG_PATH` env override lets the test harness point each worker at
 *  its own throwaway file so concurrent `node --test` processes (and a live dev
 *  server) never share/clobber the real config file. Unset in normal runs → the
 *  default path is byte-identical to before. */
export const ADMIN_CONFIG_PATH =
  process.env.ADMIN_CONFIG_PATH ?? join(here, "../../admin-config.json");

// --- Editable schema -------------------------------------------------------
// Every field here is a value that was previously a hardcoded literal in
// narrator.ts / agent.ts / risk.ts. allowedTools is INTENTIONALLY absent — the
// read-only tool allow-list is enforced in code and must never be writable.
export const adminConfigSchema = z
  .object({
    /** Narration system prompt (the plain prose-grounded prompt). */
    narratorSystemPrompt: z.string().min(1),
    /** /ask tool-loop instruction prefix (the marker is appended structurally). */
    askInstruction: z.string().min(1),
    /** The refusal marker the agent emits, the bridge gates on, and the UI
     *  detects. SINGLE SOURCE OF TRUTH — editing it here updates every consumer. */
    notInGraphMarker: z.string().min(1),
    risk: z
      .object({
        /** Base readiness score before per-flag penalties. */
        readinessBase: z.number().min(0).max(100),
        /** Points deducted per readiness flag. */
        penaltyPerFlag: z.number().min(0).max(100),
        /** Ontology versions stamped before this year are flagged stale. */
        staleBeforeYear: z.number().int().min(1900).max(3000),
        /** Confidence reported for the sample statistical (HITL-gated) conclusion. */
        statisticalConfidence: z.number().min(0).max(1),
      })
      .strict(),
    /**
     * Faithfulness scoring (F1/F4) — answer-quality observability. The deterministic
     * coverage core ALWAYS runs; `enabled` only turns on the optional LLM judge.
     * `threshold` is the gate cutoff (0..1): a grounded answer scoring below it gets
     * a VISIBLE low-confidence stamp (never a silent suppression). This is scoring,
     * not a trust guarantee — it cannot weaken grounding — so it lives here, editable.
     */
    faithfulness: z
      .object({
        /** Turn on the optional LLM judge (deterministic core is always on). */
        enabled: z.boolean(),
        /** Gate cutoff 0..1 — below this, show the low-confidence stamp. */
        threshold: z.number().min(0).max(1),
        /** Model id for the optional judge (used only when enabled). */
        judgeModel: z.string().min(1),
      })
      .strict(),

    /**
     * Which RDF reasoner backend the BFF uses: the in-process oxigraph WASM store
     * (default, zero-ops) or an external Apache Jena Fuseki sidecar. Editable so a
     * presenter can flip backends live; an env override (REASONER_BACKEND) wins at
     * load time for ops-driven deployments. This is a routing choice, NOT a trust
     * guarantee, so it belongs in the editable config, not enforced.ts.
     */
    reasonerBackend: z.enum(["oxigraph", "fuseki"]),

    /**
     * UC4 subject-safety score weights. The REPRODUCIBLE score (safe/assessed %)
     * is unweighted by contract; this block only tunes the SEVERITY-WEIGHTED risk
     * index shown alongside it, so a presenter can make a P0 clearing move the
     * index more or less. Pure scoring — nothing here gates the LLM or weakens
     * grounding, so it lives in the editable config. `weightP*` are the points a
     * finding of that severity subtracts from 100 in the weighted index.
     */
    safety: z
      .object({
        weightP0: z.number().min(0).max(100),
        weightP1: z.number().min(0).max(100),
        weightP2: z.number().min(0).max(100),
      })
      .strict(),

    /**
     * FinOps price-table + budget (token observability). Hot-editable so a
     * presenter can correct prices or tighten the budget live. This is purely an
     * OBSERVABILITY config: nothing here gates the LLM or weakens grounding — it
     * only scales the displayed cost and the budget meter. `prices` is keyed by
     * model id; `defaultPrice` covers any model not in the table so cost is never
     * NaN. Prices are USD per 1,000,000 tokens.
     */
    finops: z
      .object({
        prices: z.record(
          z.string(),
          z
            .object({
              inputPerMTok: z.number().min(0),
              outputPerMTok: z.number().min(0),
            })
            .strict()
        ),
        defaultPrice: z
          .object({
            inputPerMTok: z.number().min(0),
            outputPerMTok: z.number().min(0),
          })
          .strict(),
        budgetUsd: z.number().min(0),
        warnThresholdPct: z.number().min(0).max(100),
      })
      .strict(),

    /**
     * Model card (responsible-AI disclosure). Pure DISPLAY metadata so the admin
     * UI can surface what model is in use, its intended use, and its limits. It
     * does NOT gate the LLM or weaken grounding — nothing here is read by the
     * agent/MCP path. Hot-editable so a presenter can correct the disclosure live.
     */
    modelCard: z
      .object({
        name: z.string(),
        version: z.string(),
        provider: z.string(),
        intendedUse: z.string(),
        evaluation: z.string(),
        limitations: z.string(),
        trainingCutoff: z.string(),
      })
      .strict(),

    /**
     * Purpose policies (F6) — the selectable review-purpose vocabulary shown in
     * the reviewer selector and stamped on HITL change sets for the audit trail.
     * This is DISCLOSURE/affordance config, NOT a hard data ACL: it labels and
     * records intent; it does not (and must not) gate the read-only agent path or
     * weaken grounding. Hot-editable so a presenter can tailor the purposes live.
     */
    purposePolicies: z
      .object({
        purposes: z
          .array(
            z
              .object({
                id: z.string().min(1),
                label: z.string().min(1),
                description: z.string(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
  })
  .strict();

export type AdminConfig = z.infer<typeof adminConfigSchema>;

/** Strict PARTIAL schema for PUT bodies: every field optional, but unknown keys
 *  (e.g. a smuggled `allowedTools`) and out-of-range values are still REJECTED.
 *  This is what makes "a PUT cannot enable writes" a 400, not a silent strip. */
export const adminConfigPatchSchema = adminConfigSchema
  .partial()
  .extend({
    risk: adminConfigSchema.shape.risk.partial().optional(),
    // faithfulness is patched as a WHOLE object (all 3 fields together) so a
    // partial PUT can't drop the threshold or the judge model.
    faithfulness: adminConfigSchema.shape.faithfulness.optional(),
    // finops is patched as a WHOLE object (price table + budget together); its
    // own fields stay required so a partial PUT can't drop the price table.
    finops: adminConfigSchema.shape.finops.optional(),
    // modelCard is patched as a WHOLE object (all 7 fields together) so a partial
    // PUT can't drop any disclosure field.
    modelCard: adminConfigSchema.shape.modelCard.optional(),
    // purposePolicies is patched as a WHOLE object so a partial PUT can't leave an
    // empty purpose vocabulary.
    purposePolicies: adminConfigSchema.shape.purposePolicies.optional(),
    // safety weights patch as a partial object (any of the three weights).
    safety: adminConfigSchema.shape.safety.partial().optional(),
  })
  .strict();

/** The valid REASONER_BACKEND values (single source of truth for env parsing). */
const REASONER_BACKENDS = ["oxigraph", "fuseki"] as const;
/** Default backend when neither env nor persisted config specifies one. */
const DEFAULT_REASONER_BACKEND: AdminConfig["reasonerBackend"] = "oxigraph";

/** Read REASONER_BACKEND from the env, ignoring unknown/empty values. */
function reasonerBackendFromEnv(): AdminConfig["reasonerBackend"] | undefined {
  const v = process.env.REASONER_BACKEND;
  return (REASONER_BACKENDS as readonly string[]).includes(v ?? "")
    ? (v as AdminConfig["reasonerBackend"])
    : undefined;
}

// --- DEFAULTS --------------------------------------------------------------
// narratorSystemPrompt: the advisory lead-in for buildPrompt()/buildStructuredPrompt()
//   in narrator.ts (scenario + path + allow-list are appended structurally at
//   request time; the grounding enforcement is in code, not this text).
// askInstruction: the advisory lead-in for buildAskPrompt() in agent.ts; the
//   refusal-marker sentence and "Question:" are appended structurally so the
//   marker stays a single source of truth. Tells the agent to read the schema
//   first (text2Cypher accuracy) and to ground every claim in retrieved rows.
// notInGraphMarker: the exact "NOT_IN_GRAPH:" string emitted/gated/detected. The
//   literal lives in `@rnd/shared` (`NOT_IN_GRAPH_MARKER`) so the web's refusal
//   detection shares the same single source; this config remains the runtime
//   override point.
// risk.*: STALE_BEFORE_YEAR (2023), the readiness formula 100 - 25 * flags,
//   and getGatedConclusions() statistical confidence 0.78 from risk.ts.
export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  narratorSystemPrompt: [
    "You are the narrator of a graph-validated reasoning path in a pharmacovigilance / R&D safety review.",
    "The graph has already done the reasoning — put it into words faithfully, adding phrasing but never new facts.",
    "Write 2-3 tight sentences for an R&D data-science audience: follow the path in order, name the mechanism or",
    "safety signal it establishes, and state what it lets the reader conclude.",
    "Reference ONLY the nodes and edges below — never invent, rename, merge, or generalize an entity.",
    "If the path is too thin to support a claim, say so plainly rather than guess.",
  ].join("\n"),
  askInstruction:
    "You are a careful pharmacovigilance and R&D knowledge-graph analyst. Answer the question using ONLY the " +
    "Neo4j graph, reached through the provided read-only MCP tools — never from prior knowledge.\n" +
    "Work in this order:\n" +
    "1. Call get_neo4j_schema FIRST to see the real node labels, relationship types, and properties — do not assume the schema.\n" +
    "2. Write the smallest read-only Cypher that retrieves what the question needs; prefer specific MATCH patterns and add LIMIT to open-ended queries.\n" +
    "3. Ground every statement in rows you actually retrieved — do not infer, extrapolate, or fill gaps with outside facts.\n" +
    "Then answer: lead with the direct answer in 1-3 sentences, follow with the key figures and relationships that " +
    "support it, and cite the node ids/labels you used. Be precise and neutral.",
  notInGraphMarker: NOT_IN_GRAPH_MARKER,
  risk: {
    readinessBase: 100,
    penaltyPerFlag: 25,
    staleBeforeYear: 2023,
    statisticalConfidence: 0.78,
  },
  reasonerBackend: DEFAULT_REASONER_BACKEND,
  // Safety weighted-index defaults — P0 (patient-safety) subtracts most, P2 least.
  // With the seeded findings (4×P0 + 2×P1) the baseline weighted index is
  // 100 − (4·15 + 2·8) = 24, next to the reproducible 30; clearing a P0 lifts it 15.
  safety: {
    weightP0: 15,
    weightP1: 8,
    weightP2: 4,
  },
  // Faithfulness defaults — deterministic core always on; the LLM judge is OFF by
  // default so the demo scoring stays deterministic + zero-latency. threshold 0.6
  // means an answer with <60% of its evidence-bearing claims traceable to cited
  // nodes gets a visible low-confidence stamp. Judge model is a cheap Haiku tier.
  faithfulness: {
    enabled: false,
    threshold: 0.6,
    judgeModel: "claude-haiku-4-5-20251001",
  },
  // FinOps defaults — public Claude list prices (USD per 1M tokens) as of the
  // 2026-06 demo build. Editable live; defaultPrice catches any unlisted model.
  finops: {
    prices: {
      "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
      "claude-opus-4-1-20250805": { inputPerMTok: 15, outputPerMTok: 75 },
      "claude-sonnet-4-5-20250929": { inputPerMTok: 3, outputPerMTok: 15 },
      "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
    },
    defaultPrice: { inputPerMTok: 3, outputPerMTok: 15 },
    budgetUsd: 5,
    warnThresholdPct: 80,
  },
  // Model card — responsible-AI disclosure for THIS demo: a grounded, read-only
  // pharmacovigilance KG copilot. Display-only; tuned to what the app actually is.
  modelCard: {
    name: "Grounded KG Copilot",
    version: "demo",
    provider: "Anthropic Claude (via local Claude Code / API)",
    intendedUse:
      "Read-only, grounded Q&A over the trust graph: answers are derived ONLY " +
      "from the knowledge graph via read-only Cypher, and the model refuses " +
      "(NOT_IN_GRAPH) any question it cannot answer from the graph.",
    evaluation:
      "Grounding-refusal is enforced in code (off-path citations are rejected), " +
      "and every surface has a deterministic cached fallback so the demo never " +
      "fabricates an answer when the live path is unavailable.",
    limitations:
      "Answers come ONLY from the graph, not from model memory — it cannot " +
      "answer off-graph questions. NOT a medical device and NOT for clinical " +
      "or treatment decisions.",
    trainingCutoff: "n/a (answers are graph-grounded, not from model memory)",
  },
  // Purpose policies (F6) — the review-purpose vocabulary. Disclosure metadata
  // only; recorded on each HITL change set so the audit trail shows the stated
  // intent of every governed write. Not an ACL.
  purposePolicies: {
    purposes: [
      {
        id: "safety-review",
        label: "Safety signal review",
        description: "Pharmacovigilance signal assessment, triage, and conclusion sign-off.",
      },
      {
        id: "data-curation",
        label: "Data curation",
        description: "Resolving provenance gaps, duplicate records, and readiness flags.",
      },
      {
        id: "regulatory-prep",
        label: "Regulatory preparation",
        description: "Assembling and approving evidence for a regulatory submission.",
      },
    ],
  },
};

/**
 * READ-ONLY enforced guarantees, surfaced so the admin UI can DISPLAY them as
 * locked. These are NOT editable and are NOT read from the persisted config —
 * they are computed from the in-code structural settings. Mutating this object
 * has no effect on enforcement; it exists purely to inform the UI.
 */
export interface EnforcedGuarantees {
  /** Neo4j MCP read-only flag (`--read-only`) — write access is impossible. */
  readonly neo4jReadOnly: boolean;
  /** The ONLY tools the agent may call. The write tool is never present. */
  readonly allowedTools: readonly string[];
  /** The write tool that is deliberately never in the allow-list. */
  readonly excludedWriteTool: string;
  /** Off-path-citation refusal stays on regardless of any prompt edit. */
  readonly groundingRefusalEnforced: boolean;
}

// --- Cache + load/persist --------------------------------------------------
let cache: AdminConfig | null = null;
/** Source signature of the on-disk file the cache was built from (mtime+size, or
 *  null when no file). Lets getConfig() detect an external edit/deletion and
 *  re-read, so a directly-edited or deleted admin-config.json hot-applies too. */
let cacheSig: string | null = null;

/** Current on-disk signature: "" when absent, else `${mtimeMs}:${size}`. */
function diskSig(): string {
  if (!existsSync(ADMIN_CONFIG_PATH)) return "";
  try {
    const s = statSync(ADMIN_CONFIG_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

/** Deep-merge persisted partial overrides onto DEFAULTS so a partial file (or a
 *  schema that gained fields later) still yields a complete, valid config. */
function mergeWithDefaults(raw: unknown): AdminConfig {
  const o = (raw ?? {}) as Partial<AdminConfig> & { risk?: Partial<AdminConfig["risk"]> };
  // Env override (REASONER_BACKEND) takes precedence over the persisted file for
  // this single field, so ops can pin a backend regardless of what was saved.
  const envBackend = reasonerBackendFromEnv();
  return {
    narratorSystemPrompt: o.narratorSystemPrompt ?? DEFAULT_ADMIN_CONFIG.narratorSystemPrompt,
    askInstruction: o.askInstruction ?? DEFAULT_ADMIN_CONFIG.askInstruction,
    notInGraphMarker: o.notInGraphMarker ?? DEFAULT_ADMIN_CONFIG.notInGraphMarker,
    risk: { ...DEFAULT_ADMIN_CONFIG.risk, ...(o.risk ?? {}) },
    // Faithfulness merges whole-object onto defaults so a config file predating
    // this field still yields the full default (judge off, threshold 0.6).
    faithfulness:
      (o as { faithfulness?: AdminConfig["faithfulness"] }).faithfulness ??
      DEFAULT_ADMIN_CONFIG.faithfulness,
    reasonerBackend: envBackend ?? o.reasonerBackend ?? DEFAULT_ADMIN_CONFIG.reasonerBackend,
    // Safety weights merge whole-object onto defaults so a config file predating
    // this field still yields the full default weighted-index tuning.
    safety: (o as { safety?: AdminConfig["safety"] }).safety ?? DEFAULT_ADMIN_CONFIG.safety,
    // FinOps merges whole-object onto defaults so a config file predating this
    // field still yields the full default price table + budget.
    finops: (o as { finops?: AdminConfig["finops"] }).finops ?? DEFAULT_ADMIN_CONFIG.finops,
    // Model card merges whole-object onto defaults so a config file predating this
    // field still yields the full default disclosure.
    modelCard: (o as { modelCard?: AdminConfig["modelCard"] }).modelCard ?? DEFAULT_ADMIN_CONFIG.modelCard,
    // Purpose policies merge whole-object onto defaults so a config file predating
    // this field still yields the full default purpose vocabulary.
    purposePolicies:
      (o as { purposePolicies?: AdminConfig["purposePolicies"] }).purposePolicies ??
      DEFAULT_ADMIN_CONFIG.purposePolicies,
  };
}

/**
 * Effective config, read at request time. Cached after first read; the cache is
 * invalidated on every successful setConfig(), so PUT edits hot-apply with no
 * restart. A missing or unparseable file → byte-identical DEFAULTS.
 */
export function getConfig(): AdminConfig {
  const sig = diskSig();
  // Reuse the cache only if the on-disk source is unchanged. A direct edit or a
  // deletion of admin-config.json changes the signature → we re-read (or fall
  // back to defaults), so even an out-of-band change hot-applies with no restart.
  if (cache && sig === cacheSig) return cache;
  // Start from defaults BUT honor an env REASONER_BACKEND even when no file exists.
  let merged: AdminConfig = mergeWithDefaults({});
  if (sig !== "") {
    try {
      const raw = JSON.parse(readFileSync(ADMIN_CONFIG_PATH, "utf-8"));
      // Validate the merged result; a corrupt file must never weaken the marker
      // or thresholds into an invalid state — fall back to defaults instead.
      merged = adminConfigSchema.parse(mergeWithDefaults(raw));
    } catch {
      merged = mergeWithDefaults({});
    }
  }
  cache = merged;
  cacheSig = sig;
  return cache;
}

/**
 * Validate a (possibly partial) config update, merge onto the current effective
 * config, persist to disk, and invalidate the cache so it hot-applies. Throws a
 * ZodError on invalid input (the route maps that to a 400). allowedTools and the
 * other enforced guarantees are NOT accepted here — they are not in the schema,
 * and `.strict()` rejects any attempt to smuggle them in.
 */
export function setConfig(partial: unknown): AdminConfig {
  const current = getConfig();
  // Validate the RAW patch first: this rejects unknown keys (e.g. a smuggled
  // `allowedTools`) and out-of-range values with a ZodError → 400 at the route,
  // BEFORE we merge — so a PUT can never enable writes or weaken a threshold.
  const incoming = adminConfigPatchSchema.parse(partial ?? {});
  const candidate = {
    narratorSystemPrompt: incoming.narratorSystemPrompt ?? current.narratorSystemPrompt,
    askInstruction: incoming.askInstruction ?? current.askInstruction,
    notInGraphMarker: incoming.notInGraphMarker ?? current.notInGraphMarker,
    risk: { ...current.risk, ...(incoming.risk ?? {}) },
    faithfulness: incoming.faithfulness ?? current.faithfulness,
    reasonerBackend: incoming.reasonerBackend ?? current.reasonerBackend,
    safety: { ...current.safety, ...(incoming.safety ?? {}) },
    finops: incoming.finops ?? current.finops,
    modelCard: incoming.modelCard ?? current.modelCard,
    purposePolicies: incoming.purposePolicies ?? current.purposePolicies,
  };
  // Final full-shape validation of the merged result (belt-and-braces).
  const validated = adminConfigSchema.parse(candidate);
  writeFileSync(ADMIN_CONFIG_PATH, JSON.stringify(validated, null, 2), "utf-8");
  // Hot-apply: cache the new value AND record the just-written file's signature
  // so the next getConfig() serves it without a redundant re-read/parse.
  cache = validated;
  cacheSig = diskSig();
  return validated;
}

/** Test/maintenance hook: drop the cache so the next getConfig() re-reads disk. */
export function invalidateConfigCache(): void {
  cache = null;
  cacheSig = null;
}
