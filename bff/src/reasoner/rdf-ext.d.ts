/**
 * Minimal ambient declarations for the RDF/JS packages that ship no own types:
 * rdf-ext, @rdfjs/parser-n3, and shacl-engine. We type only the small surface
 * the reasoner adapter uses (dataset + import, the N3 parser sink, and the SHACL
 * Validator), enough for `tsc --strict` without pulling in @types we don't have.
 */
declare module "rdf-ext" {
  interface RdfExtDataset {
    add(quad: unknown): this;
    import(stream: unknown): Promise<RdfExtDataset>;
    [Symbol.iterator](): Iterator<unknown>;
  }
  interface RdfExtFactory {
    dataset(quads?: Iterable<unknown>): RdfExtDataset;
    literal(value: string, languageOrDatatype?: unknown): unknown;
    namedNode(value: string): unknown;
    blankNode(value?: string): unknown;
    quad(s: unknown, p: unknown, o: unknown, g?: unknown): unknown;
  }
  const rdf: RdfExtFactory;
  export default rdf;
}

declare module "@rdfjs/parser-n3" {
  export default class ParserN3 {
    constructor(options?: { factory?: unknown });
    import(stream: unknown): unknown;
  }
}

declare module "shacl-engine" {
  export class Validator {
    constructor(shapes: unknown, options: { factory: unknown; [k: string]: unknown });
    validate(data: { dataset: unknown; [k: string]: unknown }): Promise<{
      conforms: boolean;
      results: Array<{
        focusNode?: { term?: { value?: string }; value?: string };
        message?: Array<{ value: string }>;
        path?: Array<{ predicates?: Array<{ value?: string }> }>;
      }>;
    }>;
  }
}

// The sparql subpath registers the sh:sparql constraint + target extensions the
// ConflictingAnnotationShape needs (see bff/src/etl/rdf/verify.mjs). Typed as the
// opaque option bags shacl-engine's Validator accepts.
declare module "shacl-engine/sparql.js" {
  export const validations: unknown;
  export const targetResolvers: unknown;
}
