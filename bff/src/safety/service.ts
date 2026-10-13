/**
 * UC4 subject-safety radar service (ISOLATED).
 *
 * Builds the source brief's "Data-Quality & Patient-Safety Risk Radar" from a SEPARATE
 * data + shapes graph so the canonical FAIR radar is byte-identical untouched:
 *   - loads data/rdf/safety.ttl into its OWN oxigraph store (never the canonical
 *     reasoner), for the SPARQL path look-ups;
 *   - validates that same data against data/shacl/safety-shapes.ttl with the
 *     shacl-engine sparql extension (same technique as reasoner/service.ts), so a
 *     finding fires ONLY when a real relationship gap exists — never invented;
 *   - turns each SHACL violation into a SafetyFinding carrying the source brief's seven
 *     attributes PLUS a multi-hop evidence PATH (Subject → relationship → gap →
 *     safety rule → risk → source systems), read live from the store.
 *
 * Read-only after boot: the store is built once and every call issues read-only
 * SPARQL / a side-effect-free SHACL validation. A shared singleton is safe.
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
import { read } from "../neo4j.js";
import type { Reasoner } from "../reasoner/index.js";
import { getSafetyReasoner, resetSafetyReasoner } from "../reasoner/service.js";
import type {
  SafetyReport,
  SafetyFinding,
  SafetyPathStep,
  SafetyRiskType,
  SafetyAudit,
  SafetySubjectAudit,
  SafetyChangeOp,
} from "@rnd/shared";
import { SAFETY_POLICY } from "@rnd/shared";
import { getConfig } from "../config/adminConfig.js";
import { getTerminologyResolver } from "./terminology.js";
import { captureSnapshot } from "./history.js";

/** A fresh, deterministic id for a governed corrective node (allergy stub, booked
 *  appointment). Stable across calls so apply/route stay idempotent. */
const remediatedId = (prefix: string, subjectId: string): string =>
  `${prefix}-${subjectId}-REMEDIATED`;

/** A recent-enough lab timestamp for the re-ordered-lab correction (inside the
 *  recency window the LabRecencyShape checks). */
const RECENT_LAB_TS = "2026-01-06T08:00:00Z";

const NS = "https://vinayagrw.github.io/rnd-trust-graph#";
const PREFIXES = `
PREFIX rtg:  <${NS}>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>
`;

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "..", "..", "data");
// Data now comes from the LIVE safety reasoner (dumped to Turtle) so corrections
// are reflected; only the (static) shapes are still read from disk.
const SAFETY_SHAPES_PATH = join(DATA_DIR, "shacl", "safety-shapes.ttl");

/** Short-form an IRI back to its rtg: local id. */
const short = (iri: string): string => (iri.startsWith(NS) ? iri.slice(NS.length) : iri);

// ---------------------------------------------------------------------------
// Store — the dedicated, canonical-built safety reasoner (reasoner/service.ts).
// The SAME reasoner backs the Neo4j projection (etl/project.ts), so the graph the
// radar reasons on and the graph stored in Neo4j come from one committed source.
// ---------------------------------------------------------------------------

/** Test hook: drop the safety reasoner singleton + SHACL cache so the next call
 *  rebuilds from disk. (Name kept for the existing service tests.) */
export function resetSafetyStore(): void {
  resetSafetyReasoner();
  shaclCache = null;
}

/** Drop ONLY the SHACL violation cache — NOT the reasoner singleton. The safety
 *  writer (safety/ops.ts) calls this after a governed corrective update() so the
 *  next validation runs over the MUTATED reasoner (whose in-memory triples the
 *  update changed), while KEEPING that mutation (resetSafetyReasoner would reload
 *  the static TTL and silently discard the correction). This is what lets a
 *  cleared finding actually disappear and the score move. */
export function invalidateSafetyShacl(): void {
  shaclCache = null;
}

// ---------------------------------------------------------------------------
// SHACL validation (sparql extension) — same approach as reasoner/service.ts.
// ---------------------------------------------------------------------------

async function turtleToDataset(ttl: string): Promise<ReturnType<typeof rdf.dataset>> {
  const parser = new ParserN3({ factory: rdf });
  return rdf.dataset().import(parser.import(Readable.from(ttl)));
}

interface ShaclTerm {
  value: string;
}
interface ShaclEngineResult {
  focusNode?: { term?: ShaclTerm; value?: string };
  message?: ShaclTerm[];
}

let shaclCache: Map<string, string[]> | null = null;

/** subjectId → all its safety-shape violation messages.
 *
 *  Validates over the LIVE safety reasoner (dumped to Turtle), NOT the static TTL
 *  file — so a governed corrective update() applied by safety/ops.ts is reflected
 *  the next time this runs (after invalidateSafetyShacl clears the cache). At the
 *  baseline (no corrections) the reasoner was loaded from safety.ttl, so the dump
 *  yields the SAME violations as reading the file — the seeded findings are
 *  unchanged. Cached until a mutation invalidates it. */
async function getSafetyViolations(): Promise<Map<string, string[]>> {
  if (shaclCache) return shaclCache;
  const reasoner = await getSafetyReasoner();
  const dataTtl = await reasoner.dump();
  const shapesTtl = readFileSync(SAFETY_SHAPES_PATH, "utf-8");
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
    const fnIri = r.focusNode?.term?.value ?? r.focusNode?.value;
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
  shaclCache = flagged;
  return flagged;
}

/** Map a SHACL message to its SafetyRiskType (messages are unambiguous by design). */
function riskFromMessage(msg: string): SafetyRiskType | null {
  if (/missing allergy status/i.test(msg)) return "missing-allergy-status";
  if (/conflicting medication/i.test(msg)) return "conflicting-medication";
  if (/stale lab result/i.test(msg)) return "stale-lab-result";
  if (/referral without follow-up/i.test(msg)) return "referral-without-followup";
  if (/duplicate subject/i.test(msg)) return "duplicate-subject";
  if (/unmapped local code/i.test(msg)) return "unmapped-local-code";
  return null;
}

/** Expected-vs-actual sentence per risk type (the WHY's quantitative half). */
const EXPECTED: Record<SafetyRiskType, string> = {
  "missing-allergy-status": "expected ≥1 rtg:HAS_ALLERGY_RECORD for a subject on an active prescription, found 0",
  "conflicting-medication": "expected no active prescription pair on rtg:CONTRAINDICATES drugs, found one",
  "stale-lab-result": "expected the required lab dated ≥ 2025-01-01, found an older result",
  "referral-without-followup": "expected an open referral to have a rtg:FOLLOWED_BY appointment, found 0",
  "duplicate-subject": "expected rtg:enrolmentId to be unique per subject, found it on another record",
  "unmapped-local-code": "expected every local code to have a rtg:MAPS_TO concept, found 0",
};

// ---------------------------------------------------------------------------
// Path builders — read the concrete hop nodes live from the store.
// ---------------------------------------------------------------------------

const one = (rows: Record<string, string>[]): Record<string, string> => rows[0] ?? {};
const uniq = (xs: (string | undefined)[]): string[] =>
  [...new Set(xs.filter((x): x is string => !!x))];

async function label(r: Reasoner, id: string): Promise<string> {
  const rows = await r.sparqlSelect(`${PREFIXES}
    SELECT ?l WHERE { rtg:${id} rdfs:label ?l } LIMIT 1`);
  return one(rows).l ?? id;
}

/** The closing rule → risk → source triad shared by every finding's path. */
function tail(riskType: SafetyRiskType, sourceSystems: string[]): SafetyPathStep[] {
  const p = SAFETY_POLICY[riskType];
  return [
    { label: `safety rule requires: ${p.obligation}`, tone: "rule" },
    { label: "→ patient-safety risk raised", detail: `${p.severity} · ${p.label}`, tone: "risk" },
    {
      label: "source systems affected",
      detail: sourceSystems.join(" · ") || "—",
      tone: "source",
    },
  ];
}

/** Build the full finding (path + attributes) for one (subject, riskType). */
async function buildFinding(
  r: Reasoner,
  subjectId: string,
  subjectLabel: string,
  subjectSource: string,
  riskType: SafetyRiskType,
  reason: string,
): Promise<SafetyFinding> {
  const policy = SAFETY_POLICY[riskType];
  const head: SafetyPathStep = {
    label: "Trial subject",
    detail: subjectLabel,
    nodeId: subjectId,
    tone: "fact",
  };
  let mid: SafetyPathStep[] = [];
  let sources: string[] = [subjectSource];
  let affected: string[] = [subjectId];
  // The reversible corrective change set — built from the SAME rows as the path,
  // so it is grounded. Each branch fills it with the ops that clear its SHACL shape.
  let correction: SafetyFinding["correction"] = { forwardOps: [], inverseOps: [] };

  if (riskType === "missing-allergy-status") {
    const row = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?rx ?drugLabel ?rxSrc WHERE {
          rtg:${subjectId} rtg:HAS_PRESCRIPTION ?rx .
          OPTIONAL { ?rx rtg:PRESCRIBES ?drug . OPTIONAL { ?drug rdfs:label ?drugLabel } }
          OPTIONAL { ?rx rtg:sourceSystem ?rxSrc }
        } LIMIT 1`),
    );
    sources.push(row.rxSrc);
    mid = [
      {
        label: "has an active prescription",
        detail: row.drugLabel,
        nodeId: row.rx ? short(row.rx) : undefined,
        relation: "HAS_PRESCRIPTION",
        tone: "fact",
      },
      { label: "but has no allergy record on file", tone: "gap" },
    ];
    // Correction: capture the allergy status — add a governed allergy record and
    // link it. Clears AllergyStatusShape (the FILTER NOT EXISTS now binds).
    const alg = remediatedId("ALG", subjectId);
    correction = {
      forwardOps: [
        { op: "ensureNode", nodeId: alg, label: "AllergyRecord", nodeLabel: "Allergy record (captured on review)" },
        { op: "addEdge", source: subjectId, kind: "HAS_ALLERGY_RECORD", target: alg },
      ],
      inverseOps: [
        { op: "removeEdge", source: subjectId, kind: "HAS_ALLERGY_RECORD", target: alg },
        { op: "deleteNode", nodeId: alg, label: "AllergyRecord", nodeLabel: "Allergy record (captured on review)" },
      ],
    };
  } else if (riskType === "conflicting-medication") {
    const row = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?rx1 ?d1l ?rx2 ?d2l ?s1 ?s2 WHERE {
          rtg:${subjectId} rtg:HAS_PRESCRIPTION ?rx1 , ?rx2 .
          ?rx1 rtg:PRESCRIBES ?d1 . ?rx2 rtg:PRESCRIBES ?d2 .
          ?d1 rtg:CONTRAINDICATES ?d2 .
          FILTER (?rx1 != ?rx2)
          OPTIONAL { ?d1 rdfs:label ?d1l } OPTIONAL { ?d2 rdfs:label ?d2l }
          OPTIONAL { ?rx1 rtg:sourceSystem ?s1 } OPTIONAL { ?rx2 rtg:sourceSystem ?s2 }
        } LIMIT 1`),
    );
    sources.push(row.s1, row.s2);
    mid = [
      { label: "has an active prescription for", detail: row.d1l, nodeId: row.rx1 ? short(row.rx1) : undefined, relation: "PRESCRIBES", tone: "fact" },
      { label: "and a second active prescription for", detail: row.d2l, nodeId: row.rx2 ? short(row.rx2) : undefined, relation: "PRESCRIBES", tone: "fact" },
      { label: "the two drugs are contraindicated (bleed risk)", tone: "gap" },
    ];
    // Correction: deconflict — discontinue the second (contraindicated) prescription
    // by removing its HAS_PRESCRIPTION link. Clears MedicationConflictShape (needs
    // two active prescriptions). Reversible: re-link to reinstate.
    const rx2 = row.rx2 ? short(row.rx2) : undefined;
    if (rx2) {
      correction = {
        forwardOps: [{ op: "removeEdge", source: subjectId, kind: "HAS_PRESCRIPTION", target: rx2 }],
        inverseOps: [{ op: "addEdge", source: subjectId, kind: "HAS_PRESCRIPTION", target: rx2 }],
      };
    }
  } else if (riskType === "stale-lab-result") {
    const row = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?rx ?rxl ?lab ?labl ?ts ?labSrc WHERE {
          rtg:${subjectId} rtg:HAS_PRESCRIPTION ?rx . ?rx rtg:requiresRecentLab true .
          rtg:${subjectId} rtg:HAS_LAB_RESULT ?lab . ?lab rtg:timestamp ?ts .
          OPTIONAL { ?rx rdfs:label ?rxl } OPTIONAL { ?lab rdfs:label ?labl }
          OPTIONAL { ?lab rtg:sourceSystem ?labSrc }
        } LIMIT 1`),
    );
    sources.push(row.labSrc);
    mid = [
      { label: "has a dosing decision on", detail: row.rxl, nodeId: row.rx ? short(row.rx) : undefined, relation: "HAS_PRESCRIPTION", tone: "fact" },
      { label: "that requires a recent lab result", tone: "fact" },
      { label: "but the latest lab is stale", detail: `${row.labl ?? "lab"} — ${(row.ts ?? "").slice(0, 10)}`, nodeId: row.lab ? short(row.lab) : undefined, tone: "gap" },
    ];
    // Correction: re-order the lab — refresh the result's timestamp into the recency
    // window. Clears LabRecencyShape (ts no longer < cutoff). Reversible: restore the
    // original (stale) timestamp read live from the store.
    const lab = row.lab ? short(row.lab) : undefined;
    if (lab && row.ts) {
      correction = {
        forwardOps: [{ op: "setProp", nodeId: lab, prop: "timestamp", value: RECENT_LAB_TS, datatype: "dateTime" }],
        inverseOps: [{ op: "setProp", nodeId: lab, prop: "timestamp", value: row.ts, datatype: "dateTime" }],
      };
    }
  } else if (riskType === "referral-without-followup") {
    const row = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?ref ?refl ?refSrc WHERE {
          rtg:${subjectId} rtg:HAS_REFERRAL ?ref . ?ref rtg:status "open" .
          OPTIONAL { ?ref rdfs:label ?refl } OPTIONAL { ?ref rtg:sourceSystem ?refSrc }
        } LIMIT 1`),
    );
    sources.push(row.refSrc);
    mid = [
      { label: "has an open referral", detail: row.refl, nodeId: row.ref ? short(row.ref) : undefined, relation: "HAS_REFERRAL", tone: "fact" },
      { label: "but no follow-up appointment was ever booked", tone: "gap" },
    ];
    // Correction: book the follow-up — add a governed appointment and link it to the
    // open referral. Clears ReferralFollowupShape (the FILTER NOT EXISTS now binds).
    const ref = row.ref ? short(row.ref) : undefined;
    if (ref) {
      const appt = remediatedId("APPT", subjectId);
      correction = {
        forwardOps: [
          { op: "ensureNode", nodeId: appt, label: "Appointment", nodeLabel: "Follow-up appointment (booked on review)" },
          { op: "addEdge", source: ref, kind: "FOLLOWED_BY", target: appt },
        ],
        inverseOps: [
          { op: "removeEdge", source: ref, kind: "FOLLOWED_BY", target: appt },
          { op: "deleteNode", nodeId: appt, label: "Appointment", nodeLabel: "Follow-up appointment (booked on review)" },
        ],
      };
    }
  } else if (riskType === "duplicate-subject") {
    const row = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?other ?otherl ?enr ?otherSrc WHERE {
          rtg:${subjectId} rtg:enrolmentId ?enr .
          ?other rtg:enrolmentId ?enr . FILTER (?other != rtg:${subjectId})
          OPTIONAL { ?other rdfs:label ?otherl } OPTIONAL { ?other rtg:sourceSystem ?otherSrc }
        } LIMIT 1`),
    );
    sources.push(row.otherSrc);
    if (row.other) affected = [subjectId, short(row.other)];
    mid = [
      { label: `shares enrolment id "${row.enr ?? ""}" with`, detail: row.otherl, nodeId: row.other ? short(row.other) : undefined, tone: "gap" },
    ];
    // Correction: merge under one golden identity — re-key the duplicate record's
    // enrolmentId so it no longer collides. Clears DuplicateSubjectShape. Reversible:
    // restore the shared enrolment id read live from the store.
    const other = row.other ? short(row.other) : undefined;
    if (other && row.enr) {
      correction = {
        forwardOps: [{ op: "setProp", nodeId: other, prop: "enrolmentId", value: `${row.enr}#merged-into-${subjectId}` }],
        inverseOps: [{ op: "setProp", nodeId: other, prop: "enrolmentId", value: row.enr }],
      };
    }
  } else {
    // unmapped-local-code
    const row = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?lc ?lcl ?code ?lcSrc WHERE {
          rtg:${subjectId} rtg:USES_CODE ?lc . ?lc a rtg:LocalCode .
          FILTER NOT EXISTS { ?lc rtg:MAPS_TO ?concept }
          OPTIONAL { ?lc rdfs:label ?lcl } OPTIONAL { ?lc rtg:code ?code }
          OPTIONAL { ?lc rtg:sourceSystem ?lcSrc }
        } LIMIT 1`),
    );
    sources.push(row.lcSrc);
    mid = [
      { label: "uses local code", detail: row.code ?? row.lcl, nodeId: row.lc ? short(row.lc) : undefined, relation: "USES_CODE", tone: "fact" },
      { label: "which maps to no current terminology concept", tone: "gap" },
    ];
    // Correction: resolve the local code to a current MedDRA/SNOMED concept via the
    // terminology service and add the rtg:MAPS_TO mapping. Clears LocalCodeMappingShape.
    // Reversible: remove the mapping + the concept node it created.
    const lc = row.lc ? short(row.lc) : undefined;
    const resolved = row.code ? getTerminologyResolver().resolve(row.code) : null;
    if (lc && resolved) {
      correction = {
        forwardOps: [
          { op: "ensureNode", nodeId: resolved.conceptId, label: "Concept", nodeLabel: resolved.label },
          { op: "setProp", nodeId: resolved.conceptId, prop: "code", value: resolved.code },
          { op: "addEdge", source: lc, kind: "MAPS_TO", target: resolved.conceptId },
        ],
        inverseOps: [
          { op: "removeEdge", source: lc, kind: "MAPS_TO", target: resolved.conceptId },
          { op: "unsetProp", nodeId: resolved.conceptId, prop: "code", value: resolved.code },
          { op: "deleteNode", nodeId: resolved.conceptId, label: "Concept", nodeLabel: resolved.label },
        ],
      };
    }
  }

  const sourceSystems = uniq(sources);
  return {
    id: `${riskType}:${subjectId}`,
    riskType,
    subjectId,
    subjectLabel,
    affectedSubjects: affected,
    severity: policy.severity,
    owner: policy.owner,
    sourceSystems,
    reason: reason || policy.obligation,
    rule: policy.rule,
    expected: EXPECTED[riskType],
    path: [head, ...mid, ...tail(riskType, sourceSystems)],
    remediation: policy.remediation,
    correction,
  };
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { P0: 0, P1: 1, P2: 2 };

const AI_SAFETY_NOTE =
  'The 8th risk in the brief — "AI answer attempted without sufficient evidence" — ' +
  "is enforced in Beat 4 (the grounded agent): a faithfulness check + ungrounded-citation " +
  "refusal stop the AI answering past the evidence. It is a live guardrail, not a radar finding.";

/**
 * The pure SHACL → findings computation (dedicated safety reasoner; NO Neo4j).
 * Returns the findings plus the set of DISTINCT subject records that fired ≥1
 * safety shape (the unsafe numerator of the score). duplicate-subject collapses
 * to ONE finding per enrolment group but BOTH records count as unsafe. Hermetic —
 * the fast unit tests exercise this directly without a live database.
 */
export async function computeSafetyFindings(): Promise<{
  findings: SafetyFinding[];
  unsafeSubjects: Set<string>;
}> {
  const r = await getSafetyReasoner();
  const violations = await getSafetyViolations();

  const findings: SafetyFinding[] = [];
  const seenDuplicateEnrolment = new Set<string>();
  const unsafeSubjects = new Set<string>();

  // Iterate in SORTED subject order so the computation is independent of the
  // reasoner-dump triple order (a duplicate pair collapses to a finding attributed
  // to the lexicographically-first record, e.g. SUBJ-205A, deterministically).
  const sortedViolations = [...violations.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [subjectId, msgs] of sortedViolations) {
    const subjectLabel = await label(r, subjectId);
    const subjRow = one(
      await r.sparqlSelect(`${PREFIXES}
        SELECT ?src WHERE { rtg:${subjectId} rtg:sourceSystem ?src } LIMIT 1`),
    );
    const subjectSource = subjRow.src ?? "";
    // A subject may (in principle) violate more than one shape — emit one finding
    // per DISTINCT risk type.
    const seenType = new Set<SafetyRiskType>();
    for (const msg of msgs) {
      const riskType = riskFromMessage(msg);
      if (!riskType || seenType.has(riskType)) continue;
      seenType.add(riskType);
      unsafeSubjects.add(subjectId);

      if (riskType === "duplicate-subject") {
        // Collapse the pair to one finding keyed on the shared enrolment id.
        const enrRow = one(
          await r.sparqlSelect(`${PREFIXES}
            SELECT ?enr WHERE { rtg:${subjectId} rtg:enrolmentId ?enr } LIMIT 1`),
        );
        const enr = enrRow.enr ?? subjectId;
        if (seenDuplicateEnrolment.has(enr)) continue;
        seenDuplicateEnrolment.add(enr);
      }

      findings.push(
        await buildFinding(r, subjectId, subjectLabel, subjectSource, riskType, msg),
      );
    }
  }

  findings.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      a.subjectId.localeCompare(b.subjectId),
  );
  return { findings, unsafeSubjects };
}

/** COUNT(DISTINCT Subject) from the Neo4j projection — the assessed inventory.
 *  This is what makes the safety radar a REAL Neo4j-backed feature: if Neo4j is
 *  unreachable the endpoint fails closed, exactly like every other live surface. */
async function countAssessedSubjects(): Promise<number> {
  const rows = await read<{ n: number }>(
    `MATCH (s:Subject) RETURN count(DISTINCT s) AS n`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Every assessed subject id from Neo4j (sorted) — for the audit. */
async function listAssessedSubjects(): Promise<string[]> {
  const rows = await read<{ id: string }>(
    `MATCH (s:Subject) RETURN s.id AS id ORDER BY id`,
  );
  return rows.map((row) => row.id);
}

/** The readiness score: percent of assessed subjects with no safety flag. The
 *  REPRODUCIBLE headline (unweighted, audit contract) — unchanged. */
const score = (assessed: number, unsafe: number): number =>
  assessed > 0 ? Math.round((100 * (assessed - unsafe)) / assessed) : 100;

/** The severity-WEIGHTED risk index 0..100 (100 = clean). Each finding subtracts
 *  its severity's configured weight, so clearing a P0 moves it more than a P2.
 *  Shown alongside the reproducible score, never replacing it. */
export function weightedIndexFor(findings: SafetyFinding[]): number {
  const { weightP0, weightP1, weightP2 } = getConfig().safety;
  const weightOf = (sev: string): number =>
    sev === "P0" ? weightP0 : sev === "P1" ? weightP1 : weightP2;
  const penalty = findings.reduce((sum, f) => sum + weightOf(f.severity), 0);
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

/**
 * Build the subject-safety report on the REAL stack: SHACL (over the dedicated
 * safety reasoner) flags the relationship gaps and builds each finding's evidence
 * path, while the assessed-subject inventory is read from the Neo4j projection.
 */
export async function getSafetyReport(): Promise<SafetyReport> {
  const [{ findings, unsafeSubjects }, subjectsAssessed] = await Promise.all([
    computeSafetyFindings(),
    countAssessedSubjects(),
  ]);
  const overall = score(subjectsAssessed, unsafeSubjects.size);
  const weightedIndex = weightedIndexFor(findings);
  // Append a trend snapshot (deduped by minute) so the readiness line has a
  // baseline point; a governed correction/revert writes its own forced point.
  // Best-effort — a snapshot write must never break the report read.
  void captureSnapshot(
    { overall, weightedIndex, assessed: subjectsAssessed, unsafe: unsafeSubjects.size },
    { dedupeByMinute: true },
  ).catch(() => {});
  return {
    overall,
    weightedIndex,
    subjectsAssessed,
    findings,
    aiSafetyNote: AI_SAFETY_NOTE,
  };
}

/**
 * The reproducible audit behind "Patient-safety readiness N/100". Exposes the
 * assessed set (from Neo4j), the unsafe set, the per-subject fired shapes + raw
 * SHACL messages, and the exact formula — so a validator can recompute the score
 * independently instead of trusting the headline number.
 */
export async function getSafetyAudit(): Promise<SafetyAudit> {
  const [{ unsafeSubjects }, assessed, violations] = await Promise.all([
    computeSafetyFindings(),
    listAssessedSubjects(),
    getSafetyViolations(),
  ]);
  const perSubject: SafetySubjectAudit[] = [...violations.entries()]
    .map(([id, msgs]) => ({
      id,
      firedShapes: uniq(
        msgs.map((m) => {
          const rt = riskFromMessage(m);
          return rt ? SAFETY_POLICY[rt].rule : undefined;
        }),
      ),
      shaclMessages: msgs,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const unsafe = [...unsafeSubjects].sort();
  return {
    overall: score(assessed.length, unsafe.length),
    formula: "round(100 * (assessedCount - unsafeCount) / assessedCount)",
    assessedCount: assessed.length,
    unsafeCount: unsafe.length,
    assessed,
    unsafe,
    perSubject,
  };
}
