/**
 * JVM-sidecar reasoner backend: an HTTP client to an Apache Jena Fuseki SPARQL
 * endpoint (FUSEKI_URL, default http://localhost:3030/rtg).
 *
 * This is the "real triplestore" option for environments that already run Jena.
 * It speaks the SPARQL 1.1 Protocol:
 *   - query  (SELECT/ASK) → POST  {FUSEKI_URL}            application/sparql-query
 *   - update (INSERT…)    → POST  {FUSEKI_URL}/update     application/sparql-update
 *   - data   (load TTL)   → POST  {FUSEKI_URL}/data       text/turtle  (GSP)
 *
 * It is INTERFACE-COMPLETE: every Reasoner method is implemented. When no sidecar
 * is reachable it throws a clear, fast error ("fuseki backend unavailable …")
 * rather than hanging — every request is wrapped in a short AbortController
 * timeout and connection failures are surfaced as that single message.
 *
 * SHACL: Fuseki does not expose a standard SHACL-validation HTTP endpoint, so
 * validateShacl is implemented portably by detecting sh:NodeShape targets whose
 * required properties are missing via a SPARQL ASK/SELECT over the same dataset.
 * (A Jena `shacl validate` CLI / fuseki-geosparql build could replace this; the
 * adapter boundary is the point — the rest of the BFF does not change.)
 */
import type {
  Reasoner,
  ReasonerBackend,
  ShaclReport,
  ShaclViolation,
  SparqlRow,
} from "./index.js";
import { toRuleArray } from "./index.js";

const DEFAULT_URL = "http://localhost:3030/rtg";
/** Per-request timeout so an absent sidecar fails fast instead of hanging. */
const REQUEST_TIMEOUT_MS = 4000;

function fusekiBaseUrl(): string {
  return (process.env.FUSEKI_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

/**
 * Optional HTTP Basic auth header. Real Jena/Fuseki deployments protect the
 * update + Graph-Store (data load) endpoints, so credentials are supplied via
 * FUSEKI_USER / FUSEKI_PASSWORD env. Absent → no header (open/dev dataset).
 */
function authHeaders(): Record<string, string> {
  const user = process.env.FUSEKI_USER;
  const pass = process.env.FUSEKI_PASSWORD;
  if (!user || !pass) return {};
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

/** Wrap any connection/timeout failure in one clear, actionable message. */
function unavailable(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `fuseki backend unavailable (no sidecar running at ${fusekiBaseUrl()}): ${detail}`,
  );
}

async function fusekiFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return res;
  } catch (err) {
    throw unavailable(err);
  } finally {
    clearTimeout(timer);
  }
}

export class FusekiReasoner implements Reasoner {
  readonly backend: ReasonerBackend = "fuseki";

  async load(ttl: string): Promise<void> {
    // SPARQL Graph Store Protocol: POST Turtle to the default graph of the dataset.
    await fusekiFetch(`${fusekiBaseUrl()}/data?default`, {
      method: "POST",
      headers: { "content-type": "text/turtle", ...authHeaders() },
      body: ttl,
    });
  }

  async sparqlSelect(query: string): Promise<SparqlRow[]> {
    const res = await fusekiFetch(fusekiBaseUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/sparql-query",
        accept: "application/sparql-results+json",
        ...authHeaders(),
      },
      body: query,
    });
    const json = (await res.json()) as {
      results?: { bindings?: Array<Record<string, { value: string }>> };
    };
    const bindings = json.results?.bindings ?? [];
    return bindings.map((b) => {
      const row: SparqlRow = {};
      for (const [k, v] of Object.entries(b)) row[k] = v.value;
      return row;
    });
  }

  async sparqlAsk(query: string): Promise<boolean> {
    const res = await fusekiFetch(fusekiBaseUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/sparql-query",
        accept: "application/sparql-results+json",
        ...authHeaders(),
      },
      body: query,
    });
    const json = (await res.json()) as { boolean?: boolean };
    return Boolean(json.boolean);
  }

  async entail(rules: string[] | string): Promise<void> {
    for (const rule of toRuleArray(rules)) {
      await fusekiFetch(`${fusekiBaseUrl()}/update`, {
        method: "POST",
        headers: { "content-type": "application/sparql-update", ...authHeaders() },
        body: rule,
      });
    }
  }

  /** Apply a single governed SPARQL Update to the Fuseki dataset (HITL writer). */
  async update(sparql: string): Promise<void> {
    await fusekiFetch(`${fusekiBaseUrl()}/update`, {
      method: "POST",
      headers: { "content-type": "application/sparql-update", ...authHeaders() },
      body: sparql,
    });
  }

  /** Serialize the whole dataset back to Turtle via a CONSTRUCT (accept turtle),
   *  so the safety radar can run its sh:sparql SHACL over the live Fuseki graph. */
  async dump(): Promise<string> {
    const res = await fusekiFetch(fusekiBaseUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/sparql-query",
        accept: "text/turtle",
        ...authHeaders(),
      },
      body: "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }",
    });
    return res.text();
  }

  async validateShacl(shapesTtl: string): Promise<ShaclReport> {
    // Portable fallback: derive sh:NodeShape (targetClass + minCount-1 path)
    // constraints from the shapes Turtle, then run a SPARQL SELECT per constraint
    // to find focus nodes that lack the required property. This keeps the method
    // interface-complete against a vanilla Fuseki that has no SHACL endpoint.
    const constraints = parseMinCountShapes(shapesTtl);
    const violations: ShaclViolation[] = [];
    for (const c of constraints) {
      const rows = await this.sparqlSelect(
        `SELECT ?focus WHERE {
           ?focus a <${c.targetClass}> .
           FILTER NOT EXISTS { ?focus <${c.path}> ?v }
         }`,
      );
      for (const row of rows) {
        violations.push({
          focusNode: row.focus,
          message: c.message ?? `Missing required property <${c.path}>`,
          path: c.path,
        });
      }
    }
    return { conforms: violations.length === 0, violations };
  }
}

interface MinCountConstraint {
  targetClass: string;
  path: string;
  message?: string;
}

/**
 * Minimal shapes parser for the Fuseki fallback: pulls (sh:targetClass, sh:path,
 * sh:minCount ≥ 1, sh:message?) out of a shapes Turtle document. Deliberately
 * lightweight — the oxigraph backend uses the full shacl-engine; this only needs
 * to cover the "required-provenance" style shapes the demo uses.
 */
function parseMinCountShapes(shapesTtl: string): MinCountConstraint[] {
  const out: MinCountConstraint[] = [];
  const expand = (qname: string): string => {
    // Resolve prefixed names against @prefix declarations in the document.
    const m = qname.match(/^(\w+):(.*)$/);
    if (!m) return qname.replace(/^<|>$/g, "");
    const pfx = new RegExp(`@prefix\\s+${m[1]}:\\s*<([^>]+)>`).exec(shapesTtl);
    return pfx ? pfx[1] + m[2] : qname;
  };
  // Split into shape blocks on a blank line or `.` terminator, then scan each.
  const blocks = shapesTtl.split(/\n\s*\n/);
  for (const block of blocks) {
    if (!/sh:property|sh:targetClass/.test(block)) continue;
    const tc = /sh:targetClass\s+(\S+)\s*[;,.]/.exec(block);
    const path = /sh:path\s+(\S+)\s*[;,.]/.exec(block);
    const min = /sh:minCount\s+(\d+)/.exec(block);
    const msg = /sh:message\s+"([^"]*)"/.exec(block);
    if (tc && path && min && Number(min[1]) >= 1) {
      out.push({
        targetClass: expand(tc[1]),
        path: expand(path[1]),
        message: msg ? msg[1] : undefined,
      });
    }
  }
  return out;
}
