/**
 * Read-only graph queries. The deterministic explanation path is the hero —
 * its node ORDER is pinned (so the wow always fires the same way) while the
 * node/edge DATA is read live from Neo4j ("all-real, but rehearsed").
 */
import { read } from "../neo4j.js";
import { edgeTagsFor } from "../hitl/overlay.js";
import type {
  GraphNode,
  GraphEdge,
  GraphPayload,
  Provenance,
  EdgeKind,
} from "@rnd/shared";

/** Human-friendly labels for each relationship type, rendered on the canvas edges.
 *  Falls back to the raw kind for any type not listed. Kept beside the query that
 *  builds edges so it stays in step with the EdgeKind union. */
const EDGE_LABEL: Record<EdgeKind, string> = {
  REPORTS: "reports",
  SUSPECTED_IN: "suspected in",
  TARGETS: "targets",
  IN_PATHWAY: "in pathway",
  HAS_STAT: "has stat",
  SUPPORTED_BY: "supported by",
  RESOLVES_TO: "resolves to",
  MENTIONS: "mentions",
  STUDIES: "studies",
  IN_ONTOLOGY: "in ontology",
  HAS_LABEL: "labels",
  GENETIC_EVIDENCE: "genetic evidence",
  HUMAN_APPROVED: "human-approved",
  COMPETES_WITH: "competes with",
};

/** Attr keys that are genuinely numeric and safe to coerce with Number().
 *  Kept in lock-step with `DECIMAL_ATTRS` in etl/rdf/generate.ts (the keys the
 *  generator emits as xsd:decimal). Everything else stays a string — a blanket
 *  Number() would corrupt id-like values (code=0001 → 1, efo=1e3 → 1000). */
const NUMERIC_ATTR_KEYS = new Set(["prr", "ror", "chi2", "cases", "records", "otScore"]);

/** Parse "k=v;k2=v2" attrsRaw into a typed-ish record. Exported for unit testing
 *  the numeric-coercion allow-list. */
export function parseAttrs(raw?: string): Record<string, string | number> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string | number> = {};
  for (const pair of raw.split(";")) {
    // Split on the FIRST '=' only — a blanket split("=") truncates any value that
    // itself contains '=' (e.g. a source URL with a query string).
    const eq = pair.indexOf("=");
    const key = (eq < 0 ? pair : pair.slice(0, eq)).trim();
    if (!key) continue;
    const v = eq < 0 ? undefined : pair.slice(eq + 1).trim(); // trim to match the key
    const num = Number(v);
    const coerce = NUMERIC_ATTR_KEYS.has(key) && v !== undefined && v !== "" && !Number.isNaN(num);
    out[key] = coerce ? num : (v ?? "");
  }
  return Object.keys(out).length ? out : undefined;
}

function provenanceFrom(props: Record<string, unknown>): Provenance | undefined {
  if (!props.sourceSystem && !props.license) return undefined;
  return {
    sourceSystem: String(props.sourceSystem ?? "unknown"),
    code: props.code ? String(props.code) : undefined,
    ontologyVersion: props.ontologyVersion ? String(props.ontologyVersion) : undefined,
    ruleVersion: props.ruleVersion ? String(props.ruleVersion) : undefined,
    timestamp: String(props.timestamp ?? ""),
    license: String(props.license ?? "unknown"),
  };
}

function mapNode(n: { labels: string[]; props: Record<string, unknown> }): GraphNode {
  const p = n.props;
  return {
    id: String(p.id),
    kind: (n.labels[0] as GraphNode["kind"]) ?? "Concept",
    label: String(p.label ?? p.id),
    attrs: parseAttrs(p.attrsRaw as string | undefined),
    provenance: provenanceFrom(p),
  };
}

/** Full hero subgraph for the canvas. scope='hero' hides the radar noise nodes. */
export async function getFullGraph(scope: "hero" | "all" = "all"): Promise<GraphPayload> {
  const noise = ["DRUG-ORPHAN", "CON-STALE", "TGT-NOPROV", "AE-CONFLICT"];
  // Exclude UC4 subject-safety nodes (tagged :Safety) — they live in the same
  // Neo4j but belong to the separate safety radar, so the FAIR canvas is unchanged.
  const rows = await read<{
    n: { labels: string[]; properties: Record<string, unknown> };
  }>(`MATCH (n) WHERE NOT n:Safety RETURN n`);
  let nodes: GraphNode[] = rows.map((r) =>
    mapNode({ labels: r.n.labels, props: r.n.properties })
  );

  const edgeRows = await read<{
    src: string;
    dst: string;
    type: string;
    props: Record<string, unknown>;
  }>(
    // ORDER BY makes the row order — and therefore the index-suffixed edge id
    // below — STABLE across reads. Without it Neo4j may return edges in a
    // different order each call (esp. after a HITL mutation), so the same logical
    // edge would get a new id on refetch and the force-graph would re-simulate
    // the whole layout. The `-${i}` suffix is kept as a uniqueness guard for any
    // parallel (same src/type/dst) edge; the sort just pins it.
    `MATCH (a)-[r]->(b)
     WHERE NOT a:Safety AND NOT b:Safety
     RETURN a.id AS src, b.id AS dst, type(r) AS type, properties(r) AS props
     ORDER BY src, type, dst`
  );
  let edges: GraphEdge[] = edgeRows.map((r, i) => {
    const kind = r.type as GraphEdge["kind"];
    const tags = edgeTagsFor(r.src, r.type, r.dst);
    return {
      id: `${r.src}-${r.type}-${r.dst}-${i}`,
      source: r.src,
      target: r.dst,
      kind,
      // Human-friendly type label (Part 1) + any reviewer overlay tags (Part 3).
      label: EDGE_LABEL[kind] ?? r.type,
      ...(tags.length ? { tags } : {}),
      provenance: provenanceFrom({ ...r.props }),
    };
  });

  if (scope === "hero") {
    nodes = nodes.filter((n) => !noise.includes(n.id));
    const keep = new Set(nodes.map((n) => n.id));
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }
  return { nodes, edges };
}

/** Humanise a raw Neo4j relationship type for the safety canvas edges
 *  (e.g. HAS_PRESCRIPTION -> "has prescription"). Safety edge types are not in the
 *  FAIR `EdgeKind` union, so we deliberately do NOT use `EDGE_LABEL` here. */
function humaniseRel(type: string): string {
  return type.toLowerCase().replace(/_/g, " ");
}

/**
 * F1 — the UC4 subject-safety subgraph for the dedicated safety canvas: ONLY the
 * nodes/edges tagged `:Safety` (the exact mirror of `getFullGraph`'s exclusion).
 * This is a SEPARATE view; the FAIR canvas (`getFullGraph`) is untouched and stays
 * byte-identical — the two never share a query. The evidence-path node ids each
 * `SafetyFinding` already carries line up with the `id`s returned here, so the beat
 * can flow a finding's path across this graph.
 */
export async function getSafetyGraph(): Promise<GraphPayload> {
  const rows = await read<{
    n: { labels: string[]; properties: Record<string, unknown> };
    // Exclude the readiness trend snapshots (also tagged :Safety, so the FAIR
    // canvas query stays byte-identical) — they are score history, not subjects.
  }>(`MATCH (n:Safety) WHERE NOT n:SafetyScoreSnapshot RETURN n`);
  // Drop the `:Safety` marker so `kind` is the domain label (Subject, Prescription,
  // Drug, …), not the marker — mapNode keys `kind` off labels[0].
  const nodes: GraphNode[] = rows.map((r) =>
    mapNode({
      labels: r.n.labels.filter((l) => l !== "Safety"),
      props: r.n.properties,
    })
  );

  const edgeRows = await read<{
    src: string;
    dst: string;
    type: string;
    props: Record<string, unknown>;
  }>(
    // ORDER BY pins row order → stable index-suffixed edge ids across refetches
    // (same reasoning as getFullGraph).
    `MATCH (a:Safety)-[r]->(b:Safety)
     RETURN a.id AS src, b.id AS dst, type(r) AS type, properties(r) AS props
     ORDER BY src, type, dst`
  );
  const edges: GraphEdge[] = edgeRows.map((r, i) => ({
    id: `${r.src}-${r.type}-${r.dst}-${i}`,
    source: r.src,
    target: r.dst,
    kind: r.type as GraphEdge["kind"],
    label: humaniseRel(r.type),
    provenance: provenanceFrom({ ...r.props }),
  }));
  return { nodes, edges };
}

/**
 * The hero explanation path is now built by the canonical reasoner (SPARQL over
 * the RDF graph), not by hand-assembling Neo4j rows. queries.ts re-exports the
 * reasoner's getHeroPath() under the same names server.ts already imports, so
 * the §11 "path returns empty" guard and every downstream consumer are unchanged.
 * The node order stays pinned, each hop's existence is confirmed by SPARQL ASK,
 * and the conclusion stays deductive/auto-accept.
 */
export { HERO_PATH_ID, getHeroPath as getExplanationPath } from "../reasoner/service.js";

/** Result of resolving an external code to its canonical node + cross-refs. */
export interface EntityResolution {
  inputCode: string;
  canonicalId: string;
  kind: string;
  label: string;
  vocab?: string;
  ontologyVersion?: string;
  /** Other identifiers/cross-references carried on the same node. */
  crossRefs: { vocab?: string; code?: string; ontologyVersion?: string }[];
}

/**
 * Entity resolution (GET /api/resolve-entity): given an external code that
 * appears in node provenance (PMID, NCT, ChEMBL, RxNorm, UniProt, MONDO, MeSH,
 * MedDRA, Ensembl, FDA application number, …), return input code -> canonical
 * node id -> the cross-references already on that node. This is a REAL lookup
 * over the provenance we hold — not an inference engine.
 */
export async function resolveEntity(code: string): Promise<EntityResolution | null> {
  const rows = await read<{ labels: string[]; props: Record<string, unknown> }>(
    `MATCH (n)
     WHERE n.code = $code OR n.id = $code
     RETURN labels(n) AS labels, properties(n) AS props
     LIMIT 1`,
    { code }
  );
  if (!rows[0]) return null;
  const p = rows[0].props;
  // attrsRaw may carry secondary codes (e.g. rxnorm=…, efo=…, setid=…).
  const attrs = parseAttrs(p.attrsRaw as string | undefined) ?? {};
  const crossRefs: EntityResolution["crossRefs"] = [];
  if (p.vocab || p.code) {
    crossRefs.push({
      vocab: p.vocab ? String(p.vocab) : undefined,
      code: p.code ? String(p.code) : undefined,
      ontologyVersion: p.ontologyVersion ? String(p.ontologyVersion) : undefined,
    });
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (["rxnorm", "efo", "setid", "ensembl"].includes(k)) {
      crossRefs.push({ vocab: k, code: String(v) });
    }
  }
  return {
    inputCode: code,
    canonicalId: String(p.id),
    kind: rows[0].labels[0] ?? "Concept",
    label: String(p.label ?? p.id),
    vocab: p.vocab ? String(p.vocab) : undefined,
    ontologyVersion: p.ontologyVersion ? String(p.ontologyVersion) : undefined,
    crossRefs,
  };
}

/** A 1-hop neighbour of a node, with the relationship that connects them and its
 *  direction — the real graph neighbourhood the explanation may ground itself on. */
export interface Neighbor {
  node: GraphNode;
  relKind: string;
  /** "out" = (node)-[rel]->(neighbor); "in" = (neighbor)-[rel]->(node). */
  direction: "in" | "out";
}

/** Full grounded context for a single node: the node itself plus its 1-hop
 *  neighbourhood (relationship types + direction). This is the ONLY set of facts
 *  the per-node explanation is allowed to reference (see explain/explainNode.ts).
 *  Reuses mapNode/provenanceFrom so the node + provenance match exactly what the
 *  ProvenanceDrawer (GET /api/provenance) and the canvas already show. */
export interface NodeContext {
  node: GraphNode;
  provenance: Provenance | null;
  neighbors: Neighbor[];
}

export async function getNodeContext(id: string): Promise<NodeContext | null> {
  const self = await read<{ labels: string[]; props: Record<string, unknown> }>(
    `MATCH (n { id: $id }) RETURN labels(n) AS labels, properties(n) AS props`,
    { id }
  );
  if (!self[0]) return null;
  const node = mapNode({ labels: self[0].labels, props: self[0].props });
  const provenance = provenanceFrom(self[0].props) ?? null;

  // 1-hop neighbours in BOTH directions, carrying the relationship type + which
  // way it points. Distinct on (neighbour id, rel type, direction).
  const rows = await read<{
    labels: string[];
    props: Record<string, unknown>;
    relKind: string;
    direction: string;
  }>(
    `MATCH (n { id: $id })-[r]-(m)
     RETURN labels(m) AS labels, properties(m) AS props, type(r) AS relKind,
            CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS direction`,
    { id }
  );
  const seen = new Set<string>();
  const neighbors: Neighbor[] = [];
  for (const r of rows) {
    const nb = mapNode({ labels: r.labels, props: r.props });
    const key = `${nb.id}|${r.relKind}|${r.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    neighbors.push({ node: nb, relKind: r.relKind, direction: r.direction === "in" ? "in" : "out" });
  }
  return { node, provenance, neighbors };
}

/** Per-node provenance for the drill-down drawer. */
export async function getProvenance(id: string): Promise<Provenance | null> {
  const rows = await read<{ props: Record<string, unknown> }>(
    `MATCH (n { id: $id }) RETURN properties(n) AS props`,
    { id }
  );
  if (!rows[0]) return null;
  return provenanceFrom(rows[0].props) ?? null;
}
