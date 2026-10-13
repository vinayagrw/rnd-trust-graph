/**
 * In-process reasoner backend.
 *
 * SPARQL / SPARQL-Update / entailment: the oxigraph WASM store (no JVM, no ops).
 * SHACL: shacl-engine + rdf-ext + @rdfjs/parser-n3 (parse the shapes and the
 * loaded data into rdf-ext datasets, then run the Validator).
 *
 * This backend is the demo default: zero infrastructure, deterministic, and the
 * data, the shapes, and the entailment rules all live in-memory in one Store.
 */
import { Readable } from "node:stream";
import * as oxi from "oxigraph";
import rdf from "rdf-ext";
import ParserN3 from "@rdfjs/parser-n3";
import { Validator } from "shacl-engine";
import type {
  Reasoner,
  ReasonerBackend,
  ShaclReport,
  ShaclViolation,
  SparqlRow,
} from "./index.js";
import { toRuleArray } from "./index.js";

const TURTLE = "text/turtle";

/** A single RDF term as shacl-engine surfaces it on a validation result. */
interface ShaclTerm {
  value: string;
}

/** The raw shape of one entry in shacl-engine's `report.results`. shacl-engine
 *  types these loosely; this captures only the fields we read. `path` is the
 *  engine's internal ordered step list — each step exposes a `predicates` array
 *  whose first IRI is the property path for the common path-scoped case. */
interface ShaclEngineResult {
  focusNode?: { term?: ShaclTerm; value?: string };
  message?: ShaclTerm[];
  path?: Array<{ predicates?: ShaclTerm[] }>;
}

/** Index of the property-path step / predicate we report for path-scoped
 *  violations (the first step's first predicate IRI). */
const PRIMARY_PATH_STEP = 0;
const PRIMARY_PREDICATE = 0;

/** Parse a Turtle string into an rdf-ext dataset (for shacl-engine). */
async function turtleToDataset(ttl: string): Promise<ReturnType<typeof rdf.dataset>> {
  const parser = new ParserN3({ factory: rdf });
  const stream = parser.import(Readable.from(ttl));
  return rdf.dataset().import(stream);
}

export class OxigraphReasoner implements Reasoner {
  readonly backend: ReasonerBackend = "oxigraph";
  /** The single in-memory triple store: data + materialized inferences. */
  private readonly store = new oxi.Store();
  /** Turtle accumulated so far — re-parsed into a dataset for SHACL validation. */
  private loadedTurtle = "";

  load(ttl: string): void {
    this.store.load(ttl, { format: TURTLE });
    // Keep the raw Turtle so validateShacl() can build a data dataset that also
    // reflects later entailment (entailed triples are dumped back from the store).
    this.loadedTurtle += (this.loadedTurtle ? "\n" : "") + ttl;
  }

  sparqlSelect(query: string): SparqlRow[] {
    const out = this.store.query(query);
    if (!Array.isArray(out)) {
      throw new Error("sparqlSelect: query did not return SELECT bindings");
    }
    // SELECT → Map<string, Term>[]; ASK → boolean; CONSTRUCT → Quad[].
    return (out as Array<Map<string, oxi.Term>>).map((row) => {
      const obj: SparqlRow = {};
      for (const [name, term] of row) {
        if (term) obj[name] = term.value;
      }
      return obj;
    });
  }

  sparqlAsk(query: string): boolean {
    const out = this.store.query(query);
    if (typeof out !== "boolean") {
      throw new Error("sparqlAsk: query did not return an ASK boolean");
    }
    return out;
  }

  entail(rules: string[] | string): void {
    for (const rule of toRuleArray(rules)) {
      this.store.update(rule);
    }
  }

  /** Apply a single governed SPARQL Update to the in-memory store (HITL writer). */
  update(sparql: string): void {
    this.store.update(sparql);
  }

  /** Serialize the live store back to Turtle (datatypes preserved). Lets the
   *  safety radar run its sh:sparql SHACL over the CURRENT graph — including any
   *  governed corrective update() — instead of the static file. */
  dump(): string {
    return this.store.dump({ format: TURTLE, from_graph_name: oxi.defaultGraph() });
  }

  async validateShacl(shapesTtl: string): Promise<ShaclReport> {
    // Validate against the CURRENT store contents (raw + any entailed triples),
    // so dump the store back to Turtle rather than reusing only the input text.
    const dataTtl = this.store.dump({
      format: TURTLE,
      from_graph_name: oxi.defaultGraph(),
    });
    const [shapesDs, dataDs] = await Promise.all([
      turtleToDataset(shapesTtl),
      turtleToDataset(dataTtl),
    ]);

    const validator = new Validator(shapesDs, { factory: rdf });
    const report = await validator.validate({ dataset: dataDs });

    const violations: ShaclViolation[] = (report.results as ShaclEngineResult[]).map((r) => {
      const focusNode = r.focusNode?.term?.value ?? r.focusNode?.value ?? "";
      const message =
        Array.isArray(r.message) && r.message.length > 0
          ? r.message.map((m) => m.value).join(" ")
          : "";
      // r.path is shacl-engine's internal step list; the first step's single
      // predicate IRI is the property path for the common path-scoped case.
      const path: string | undefined =
        r.path?.[PRIMARY_PATH_STEP]?.predicates?.[PRIMARY_PREDICATE]?.value;
      const v: ShaclViolation = { focusNode, message };
      if (path) v.path = path;
      return v;
    });

    return { conforms: report.conforms, violations };
  }
}
