/**
 * Canonical reasoner service (slice 1c).
 *
 * This module makes "the graph reasons, the LLM narrates" literally true: the
 * demo's inference no longer lives in hand-coded Cypher/JS — it is materialized
 * by the native RDF reasoner from `data/rdf/*.ttl` plus an explicit, ordered
 * entailment rule set, and read back out with SPARQL / SHACL.
 *
 * What it builds:
 *   - loads dataset.generated.ttl (A-Box) + ontology.ttl (T-Box) into a single
 *     reasoner store (oxigraph by default; fuseki if configured);
 *   - runs the entailment rule set to fixpoint (single pass — the rules are
 *     non-recursive) via `reasoner.entail(...)`, so BOTH backends produce
 *     identical materialization even though oxigraph has no OWL engine. The
 *     CANDIDATE_SIGNAL property-chain axiom is reproduced operationally, exactly
 *     as bff/src/etl/rdf/verify.mjs does it.
 *
 * Concurrency / isolation: the canonical graph is READ-MOSTLY after boot — it is
 * built once, entailment is materialized once, and every caller below issues
 * read-only SPARQL SELECT/ASK or a (side-effect-free) SHACL validation. A shared
 * singleton store is therefore safe; there is no per-request mutation to isolate.
 * The one writing operation (entailment) happens inside the single build promise
 * before the singleton is handed out, so it can never interleave with a read.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import rdf from "rdf-ext";
import ParserN3 from "@rdfjs/parser-n3";
import { Validator } from "shacl-engine";
import {
  validations as sparqlValidations,
  targetResolvers as sparqlTargetResolvers,
} from "shacl-engine/sparql.js";
import { getReasoner, type Reasoner, type ReasonerBackend } from "./index.js";
import type {
  ExplanationPath,
  PathHop,
  GraphNode,
  GraphEdge,
  EdgeKind,
  Provenance,
  RiskReport,
  RiskFinding,
  RiskFlag,
  RiskReason,
  GatedConclusion,
} from "@rnd/shared";
import { getConfig } from "../config/adminConfig.js";
import { isSuppressed, manualFlagsFor } from "../hitl/overlay.js";

/** The single namespace the whole dataset/ontology speaks. */
export const NS = "https://vinayagrw.github.io/rnd-trust-graph#";
/** Common SPARQL prefix block. */
const PREFIXES = `
PREFIX rtg:  <${NS}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX dcterms: <http://purl.org/dc/terms/>
`;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "..", "..", "data");
const DATASET_TTL_PATH = join(DATA_DIR, "rdf", "dataset.generated.ttl");
const ONTOLOGY_TTL_PATH = join(DATA_DIR, "rdf", "ontology.ttl");
const SHAPES_TTL_PATH = join(DATA_DIR, "shacl", "shapes.ttl");
/** UC4 subject-safety A-Box — the canonical committed source for the safety
 *  radar (the analog of dataset.generated.ttl for the FAIR radar). Loaded into a
 *  SEPARATE reasoner (buildSafetyReasoner) so the canonical store above never sees
 *  a Subject triple and its exact-flag invariants stay byte-identical. */
const SAFETY_TTL_PATH = join(DATA_DIR, "rdf", "safety.ttl");

/** Short-form an IRI back to its local node id (rtg: local name). */
const short = (iri: string): string => (iri.startsWith(NS) ? iri.slice(NS.length) : iri);

// ---------------------------------------------------------------------------
// Entailment rule set
//
// Ordered list of SPARQL INSERT…WHERE rules applied once each. They are
// non-recursive (no rule's WHERE reads a predicate a later rule INSERTs), so a
// single pass IS the fixpoint. Defining them as SPARQL UPDATE (rather than
// relying on an OWL engine) is what makes oxigraph and fuseki agree byte-for-byte.
// ---------------------------------------------------------------------------

/**
 * Rule R1 — CANDIDATE_SIGNAL (the OWL property-chain axiom, operationalized).
 * Ontology declares: rtg:CANDIDATE_SIGNAL owl:propertyChainAxiom (rtg:TARGETS rtg:IN_PATHWAY).
 * Oxigraph runs no OWL reasoner, so we materialize the chain exactly as
 * verify.mjs does: a Drug that TARGETS a Target that is IN_PATHWAY of a Pathway
 * is a candidate signal for that Pathway. This is the deductive 🟦 conclusion
 * surfaced as an auto-accept gated conclusion below.
 */
export const RULE_CANDIDATE_SIGNAL = `${PREFIXES}
INSERT { ?drug rtg:CANDIDATE_SIGNAL ?pathway }
WHERE {
  ?drug   rtg:TARGETS    ?target .
  ?target rtg:IN_PATHWAY ?pathway .
}`;

/** The ordered rule set applied to the canonical store, once, in order. */
export const ENTAILMENT_RULES: ReadonlyArray<{ id: string; sparql: string; comment: string }> = [
  {
    id: "R1-candidate-signal",
    sparql: RULE_CANDIDATE_SIGNAL,
    comment:
      "OWL property chain (TARGETS o IN_PATHWAY) ⟹ CANDIDATE_SIGNAL — materialized operationally.",
  },
];

// ---------------------------------------------------------------------------
// Singleton build
// ---------------------------------------------------------------------------

let canonicalPromise: Promise<Reasoner> | null = null;

/** Build the canonical reasoner: load T-Box + A-Box, then entail to fixpoint. */
export async function buildCanonicalReasoner(backend?: ReasonerBackend): Promise<Reasoner> {
  const reasoner = await getReasoner(backend);
  const ontologyTtl = readFileSync(ONTOLOGY_TTL_PATH, "utf-8");
  const datasetTtl = readFileSync(DATASET_TTL_PATH, "utf-8");
  // Load the schema (T-Box) first, then the instance data (A-Box) — additive.
  await reasoner.load(ontologyTtl);
  await reasoner.load(datasetTtl);
  // Materialize every entailment rule, in order, once (single-pass fixpoint).
  for (const rule of ENTAILMENT_RULES) {
    await reasoner.entail(rule.sparql);
  }
  return reasoner;
}

/**
 * Lazily-initialized singleton accessor. The first caller triggers the build
 * (load + entail); every subsequent caller awaits the SAME promise and shares
 * the one materialized store. Read-only after build (see module header).
 */
export async function getCanonicalReasoner(): Promise<Reasoner> {
  if (!canonicalPromise) canonicalPromise = buildCanonicalReasoner();
  return canonicalPromise;
}

/** Test/maintenance hook: drop the singleton so the next get rebuilds. */
export function resetCanonicalReasoner(): void {
  canonicalPromise = null;
}

// ---------------------------------------------------------------------------
// UC4 subject-safety reasoner — a SECOND canonical-built store (isolated)
//
// The safety radar (Use Case 4) runs on its OWN reasoner, built the same way the
// canonical one is — loaded from a committed A-Box (safety.ttl) — but kept in a
// SEPARATE oxigraph store. Because the canonical reasoner never loads a safety
// triple, the FAIR radar's "exactly 7 noise nodes" flag set and its readiness
// score are byte-identical by construction. No entailment rules apply here (the
// safety shapes are pure sh:sparql relationship checks), so this is load-only.
// The SAME builder feeds both the SHACL detection (safety/service.ts) and the
// Neo4j projection (etl/project.ts), so the graph the app reasons on and the
// graph it stores in Neo4j come from one source.
// ---------------------------------------------------------------------------

let safetyPromise: Promise<Reasoner> | null = null;

/** Build the safety reasoner: load the subject-safety A-Box (no entailment). */
export async function buildSafetyReasoner(backend?: ReasonerBackend): Promise<Reasoner> {
  const reasoner = await getReasoner(backend);
  await reasoner.load(readFileSync(SAFETY_TTL_PATH, "utf-8"));
  return reasoner;
}

/** Lazily-initialized singleton for the safety store (read-only after build). */
export async function getSafetyReasoner(): Promise<Reasoner> {
  if (!safetyPromise) safetyPromise = buildSafetyReasoner();
  return safetyPromise;
}

/** Test/maintenance hook: drop the safety singleton so the next get rebuilds. */
export function resetSafetyReasoner(): void {
  safetyPromise = null;
}

// ---------------------------------------------------------------------------
// SHACL validation (with the sh:sparql extension registered)
//
// The slice-1b adapter's validateShacl() runs the core shacl-engine WITHOUT the
// sparql extension, so it cannot evaluate the ConflictingAnnotationShape's
// sh:sparql constraint (which is what catches AE-CONFLICT). To flag EXACTLY the
// 4 noise nodes we register the extension here, exactly as verify.mjs does, and
// validate the canonical A-Box+T-Box Turtle. SHACL is read-only and none of the
// entailed triples (CANDIDATE_SIGNAL) affect these shapes, so validating the
// loaded Turtle is equivalent to validating the live store.
// ---------------------------------------------------------------------------

async function turtleToDataset(ttl: string): Promise<ReturnType<typeof rdf.dataset>> {
  const parser = new ParserN3({ factory: rdf });
  return rdf.dataset().import(parser.import(Readable.from(ttl)));
}

/** A single RDF term as shacl-engine surfaces it on a validation result. */
interface ShaclTerm {
  value: string;
}

/** The raw shape of one entry in shacl-engine's `report.results` (only the
 *  fields we read; shacl-engine types these loosely). */
interface ShaclEngineResult {
  focusNode?: { term?: ShaclTerm; value?: string };
  message?: ShaclTerm[];
}

let shaclFlaggedCache: Map<string, string[]> | null = null;

/**
 * Run SHACL with the sparql extension over the canonical data and return a map
 * of focusNode local-id → ALL its violation messages. A node can violate more
 * than one shape, so we keep every message (not just the first) — the radar
 * derives a distinct flag per shape from them. Cached (data is static).
 */
async function getShaclFlags(): Promise<Map<string, string[]>> {
  if (shaclFlaggedCache) return shaclFlaggedCache;
  const dataTtl = readFileSync(DATASET_TTL_PATH, "utf-8");
  const shapesTtl = readFileSync(SHAPES_TTL_PATH, "utf-8");
  const [shapesDs, dataDs] = await Promise.all([
    turtleToDataset(shapesTtl),
    turtleToDataset(dataTtl),
  ]);
  const validator = new Validator(shapesDs, {
    factory: rdf,
    validations: sparqlValidations,
    targetResolvers: sparqlTargetResolvers,
  });
  const report = await validator.validate({ dataset: dataDs });
  const flagged = new Map<string, string[]>();
  for (const r of report.results as ShaclEngineResult[]) {
    const fnIri: string | undefined = r.focusNode?.term?.value ?? r.focusNode?.value;
    if (!fnIri) continue;
    const id = short(fnIri);
    const msg =
      Array.isArray(r.message) && r.message.length > 0
        ? r.message.map((m) => m.value).join(" ")
        : "";
    const list = flagged.get(id);
    if (list) list.push(msg);
    else flagged.set(id, [msg]);
  }
  shaclFlaggedCache = flagged;
  return flagged;
}

/** Which SHACL message ⟹ which Beat-1 RiskFlag. Drives the radar from SHACL.
 *  Order matters: the more specific sh:sparql messages (duplicate / follow-up)
 *  are tested BEFORE the generic "Integrity" provenance/conflict patterns. */
function flagFromShaclMessage(message: string): RiskFlag {
  if (/duplicate record/i.test(message)) return "duplicate-record";
  if (/referral without follow-up|without follow-up|REVIEWED_BY/i.test(message))
    return "missing-followup";
  if (/conflicting annotation/i.test(message)) return "conflicting-annotation";
  if (/Currency|stale|2023 or later/i.test(message)) return "stale-ontology-version";
  if (/Interoperable|at least one biological target|FAIR/i.test(message))
    return "missing-cross-source-link";
  if (/Attributable|source system|provenance|Contemporaneous|license/i.test(message))
    return "missing-provenance";
  // Default: a missing-provenance-style defect is the safest structural reading.
  return "missing-provenance";
}

/** The SHACL shape name that owns each flag (for the "why" rule field). */
const RULE_FOR_FLAG: Record<RiskFlag, string> = {
  "missing-provenance": "NodeProvenanceShape",
  "stale-ontology-version": "OntologyVersionShape",
  "missing-cross-source-link": "DrugShape",
  "conflicting-annotation": "ConflictingAnnotationShape",
  "duplicate-record": "DuplicateRecordShape",
  "missing-followup": "MissingFollowupShape",
  "dangling-reference": "DanglingReferenceShape",
};

/** Deterministic expected-vs-actual sentence per flag — derived from the shape's
 *  constraint, never invented (the WHY's quantitative half). */
const EXPECTED_FOR_FLAG: Record<RiskFlag, string> = {
  "missing-provenance":
    "expected rtg:sourceSystem / rtg:timestamp / dcterms:license minCount 1, found 0",
  "stale-ontology-version": "expected rtg:ontologyVersion ≥ 2023, found a pre-2023 version",
  "missing-cross-source-link": "expected rtg:TARGETS minCount 1, found 0",
  "conflicting-annotation":
    "expected a code to be held by exactly one node, found the same code on a refuted twin",
  "duplicate-record":
    "expected rtg:code to be unique per SignalStat, found the same code on another SignalStat",
  "missing-followup":
    "expected an escalated signal to have a rtg:REVIEWED_BY follow-up edge, found 0",
  "dangling-reference": "expected every reference to resolve to an existing node, found a dangling one",
};

/** Build the full RiskReason (why) for a flag from its SHACL message. */
function reasonFor(flag: RiskFlag, message: string): RiskReason {
  return {
    flag,
    reason: message || EXPECTED_FOR_FLAG[flag],
    rule: RULE_FOR_FLAG[flag],
    expected: EXPECTED_FOR_FLAG[flag],
  };
}

// ---------------------------------------------------------------------------
// Provenance / node shaping helpers (SPARQL → @rnd/shared shapes)
// ---------------------------------------------------------------------------

/** Build a Provenance from the per-node datatype properties we hold. */
function provenanceFromRow(row: Record<string, string>): Provenance | undefined {
  if (!row.sourceSystem && !row.license) return undefined;
  return {
    sourceSystem: row.sourceSystem ?? "unknown",
    code: row.code || undefined,
    ontologyVersion: row.ontologyVersion || undefined,
    ruleVersion: undefined,
    timestamp: row.timestamp ?? "",
    license: row.license ?? "unknown",
  };
}

/** Fetch one node (id, kind, label, provenance) from the canonical store. */
async function getNode(r: Reasoner, id: string): Promise<GraphNode | undefined> {
  const rows = await r.sparqlSelect(`${PREFIXES}
    SELECT ?kind ?label ?code ?sourceSystem ?ontologyVersion ?timestamp ?license WHERE {
      rtg:${id} a ?kindIri .
      FILTER(STRSTARTS(STR(?kindIri), "${NS}"))
      BIND(STRAFTER(STR(?kindIri), "${NS}") AS ?kind)
      OPTIONAL { rtg:${id} rdfs:label ?label }
      OPTIONAL { rtg:${id} rtg:code ?code }
      OPTIONAL { rtg:${id} rtg:sourceSystem ?sourceSystem }
      OPTIONAL { rtg:${id} rtg:ontologyVersion ?ontologyVersion }
      OPTIONAL { rtg:${id} rtg:timestamp ?timestamp }
      OPTIONAL { rtg:${id} dcterms:license ?license }
    } LIMIT 1`);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id,
    kind: (row.kind as GraphNode["kind"]) ?? "Concept",
    label: row.label ?? id,
    provenance: provenanceFromRow(row),
  };
}

// ---------------------------------------------------------------------------
// Hero path — now a SPARQL query against the canonical reasoner
// ---------------------------------------------------------------------------

/** The pinned hero ordering (node id + the edge kind that reaches it). Same
 *  sequence the former queries.ts HERO_SEQUENCE pinned, so the reveal is
 *  byte-identical — but each hop's existence is now confirmed by SPARQL ASK. */
const HERO_SEQUENCE: { nodeId: string; viaEdgeKind?: EdgeKind; from?: string }[] = [
  { nodeId: "AE-MYOCARDITIS" },
  { nodeId: "DRUG-CPI", viaEdgeKind: "SUSPECTED_IN", from: "AE-MYOCARDITIS" },
  { nodeId: "TGT-PDCD1", viaEdgeKind: "TARGETS", from: "DRUG-CPI" },
  { nodeId: "PW-CHECKPOINT", viaEdgeKind: "IN_PATHWAY", from: "TGT-PDCD1" },
  { nodeId: "STAT-MYO-CPI", viaEdgeKind: "HAS_STAT", from: "AE-MYOCARDITIS" },
  { nodeId: "EV-FAERS", viaEdgeKind: "SUPPORTED_BY", from: "STAT-MYO-CPI" },
  { nodeId: "EV-PMID", viaEdgeKind: "SUPPORTED_BY", from: "STAT-MYO-CPI" },
];

export const HERO_PATH_ID = "hero-onco-myocarditis-cpi";

/**
 * Build the deterministic explanation path from the canonical reasoner. The node
 * ORDER is pinned (so the wow always fires identically); each node's DATA and
 * each edge's EXISTENCE are read live via SPARQL. A missing edge surfaces the
 * node without an edge (never blanks the reveal), matching the old behaviour.
 */
export async function getHeroPath(): Promise<ExplanationPath> {
  const r = await getCanonicalReasoner();
  const hops: PathHop[] = [];
  for (const step of HERO_SEQUENCE) {
    const node = await getNode(r, step.nodeId);
    if (!node) continue; // skip missing rather than break the reveal
    let edge: GraphEdge | undefined;
    if (step.from && step.viaEdgeKind) {
      const exists = await r.sparqlAsk(`${PREFIXES}
        ASK { rtg:${step.from} rtg:${step.viaEdgeKind} rtg:${step.nodeId} }`);
      if (exists) {
        edge = {
          id: `${step.from}-${step.viaEdgeKind}-${step.nodeId}`,
          source: step.from,
          target: step.nodeId,
          kind: step.viaEdgeKind,
        };
      }
    }
    hops.push({ index: hops.length, node, edge });
  }
  return {
    pathId: HERO_PATH_ID,
    scenario:
      "Oncology PV signal: anti-PD-1 checkpoint inhibitor → immune-related myocarditis",
    hops,
    deductive: true, // a path that exists in the graph = certain, auto-accept
  };
}

// ---------------------------------------------------------------------------
// FAIR / ALCOA+ readiness — now derived from SHACL + SPARQL
// ---------------------------------------------------------------------------

/**
 * FAIR / ALCOA+ readiness report, derived from the reasoner: SHACL (with the
 * sparql extension) flags the defects, SPARQL enumerates every node. The
 * readiness formula (base − penalty·flags) is unchanged from the former
 * hand-coded version, but the flags now come from the SHACL conformance report
 * rather than ad-hoc JS — the reasoner decides what's wrong, not the BFF.
 */
export async function getFairConformance(): Promise<RiskReport> {
  const { readinessBase, penaltyPerFlag } = getConfig().risk;
  const r = await getCanonicalReasoner();
  const shaclFlags = await getShaclFlags();

  // Enumerate every typed node (the rdf:type'd subjects). Patients included.
  const rows = await r.sparqlSelect(`${PREFIXES}
    SELECT DISTINCT ?id WHERE {
      ?s a ?kind .
      FILTER(STRSTARTS(STR(?s), "${NS}"))
      FILTER(STRSTARTS(STR(?kind), "${NS}"))
      BIND(STRAFTER(STR(?s), "${NS}") AS ?id)
    } ORDER BY ?id`);

  const findings: RiskFinding[] = rows.map((row) => {
    const id = row.id;
    const flags: RiskFlag[] = [];
    const reasons: RiskReason[] = [];
    // A node may violate MULTIPLE distinct shapes; surface every DISTINCT flag so
    // the readiness penalty and the "why" list reflect ALL defects, not just the
    // first. Several properties of one shape map to one flag → deduped by flag.
    for (const msg of shaclFlags.get(id) ?? []) {
      const flag = flagFromShaclMessage(msg);
      if (flags.includes(flag)) continue;
      // HITL runtime overlay: a reviewer-resolved (node, flag) pair is suppressed
      // here ONLY. The static TTL/SHACL cache is untouched, so an empty overlay ⇒
      // the exact baseline flag set, and a revert re-exposes the flag.
      if (isSuppressed(id, flag)) continue;
      flags.push(flag);
      // The "why was this flagged?" evidence path — the SHACL message itself,
      // never invented (Item 1). Parallel to flags[] (same order).
      reasons.push(reasonFor(flag, msg));
    }
    // Manual reviewer flags (additive overlay) — a human asserting a defect on any
    // node, even one SHACL doesn't catch. Deduped against SHACL flags already
    // present so the same flag is never doubled; the reason is the reviewer's note.
    for (const { flag, reason } of manualFlagsFor(id)) {
      if (flags.includes(flag)) continue;
      flags.push(flag);
      reasons.push({
        flag,
        reason: reason || "Flagged manually by a reviewer for follow-up.",
        rule: "Manual reviewer flag",
        expected: "raised by a human reviewer (governed, reversible)",
      });
    }
    const readiness = Math.max(0, readinessBase - penaltyPerFlag * flags.length);
    return { nodeId: id, flags, readiness, reasons };
  });

  const overall = Math.round(
    findings.reduce((s, f) => s + f.readiness, 0) / Math.max(1, findings.length)
  );

  // SHACL conformance is now LIVE (the reasoner says so), not a stub path.
  const conforms = shaclFlags.size === 0;
  return {
    overall,
    findings,
    shacl: { conforms, reportPath: "data/shacl/conformance-report.txt" },
  };
}

// ---------------------------------------------------------------------------
// Inference trace — the actual derivation chain ("why the rule fires")
// ---------------------------------------------------------------------------

/** One step of a human-readable derivation chain behind a gated conclusion. */
export interface InferenceStep {
  /** A ground triple (subject predicate object) read from the store. */
  premise: string;
  /** Why this premise matters in the chain. */
  note: string;
}

/** The materialized derivation behind a gated conclusion. */
export interface InferenceTrace {
  /** The rule/axiom that fired. */
  rule: string;
  /** The ordered premises (ground triples) that satisfied the rule body. */
  steps: InferenceStep[];
  /** The conclusion triple the rule entailed (for deductive conclusions). */
  conclusion?: string;
}

// ---------------------------------------------------------------------------
// HITL gate — deductive (entailment) vs statistical (threshold) conclusions
//
// Deductive 🟦 (auto-accept): CANDIDATE_SIGNAL is an OWL/rule ENTAILMENT — the
//   reasoner materialized it, so it is certain and needs no human. Its trace is
//   the actual chain of ground triples that fired RULE_CANDIDATE_SIGNAL.
// Statistical 🟩 (human-review): a disproportionality signal whose confidence is
//   a THRESHOLD — but now reasoner-REPORTED data (the PRR is read out of the
//   store with SPARQL), routed to a human because it is probabilistic.
// ---------------------------------------------------------------------------

/** A gated conclusion plus its (possibly empty) inference trace. */
export interface GatedConclusionWithTrace extends GatedConclusion {
  trace?: InferenceTrace;
}

export async function getGatedConclusions(): Promise<GatedConclusionWithTrace[]> {
  const { statisticalConfidence } = getConfig().risk;
  const r = await getCanonicalReasoner();

  // --- Deductive: read the ENTAILED candidate-signal chain for the hero drug.
  const csRows = await r.sparqlSelect(`${PREFIXES}
    SELECT ?drug ?target ?pathway WHERE {
      rtg:DRUG-CPI rtg:TARGETS ?target .
      ?target rtg:IN_PATHWAY ?pathway .
      rtg:DRUG-CPI rtg:CANDIDATE_SIGNAL ?pathway .
      BIND(rtg:DRUG-CPI AS ?drug)
    } LIMIT 1`);
  const cs = csRows[0];
  const deductiveTrace: InferenceTrace | undefined = cs
    ? {
        rule: "CANDIDATE_SIGNAL ← (TARGETS ∘ IN_PATHWAY)  [OWL propertyChainAxiom, entailed]",
        steps: [
          {
            premise: `${short(cs.drug)} TARGETS ${short(cs.target)}`,
            note: "drug acts on a biological target (asserted)",
          },
          {
            premise: `${short(cs.target)} IN_PATHWAY ${short(cs.pathway)}`,
            note: "target participates in a pathway (asserted)",
          },
        ],
        conclusion: `${short(cs.drug)} CANDIDATE_SIGNAL ${short(cs.pathway)}  (materialized by the reasoner)`,
      }
    : undefined;

  // --- Statistical: the disproportionality stat, now read FROM the store.
  const statRows = await r.sparqlSelect(`${PREFIXES}
    SELECT ?prr WHERE { rtg:STAT-MYO-CPI rtg:prr ?prr } LIMIT 1`);
  const prr = statRows[0]?.prr;
  const prrText = prr ? `PRR ${prr}` : "PRR (disproportionality)";

  return [
    {
      id: "gc-path-exists",
      summary: "Deterministic path AE→Drug→Target→Pathway exists",
      kind: "deductive",
      routedToHuman: false,
      trace: deductiveTrace,
    },
    {
      id: "gc-disproportionality",
      summary: `Disproportionality signal ${prrText} suggests causal link (statistical)`,
      kind: "statistical",
      confidence: statisticalConfidence,
      routedToHuman: true,
      trace: {
        rule: "statistical threshold (probabilistic — NOT an entailment)",
        steps: [
          {
            premise: `STAT-MYO-CPI ${prrText}`,
            note: "reasoner-reported disproportionality statistic (read from the store)",
          },
        ],
      },
    },
  ];
}
