/**
 * Read-only graph-schema helper for AI-assisted playbook authoring.
 *
 * Returns the live graph's vocabulary — node labels, relationship types, and a
 * small sample of real entity names — so the drafting prompt can steer the model
 * toward questions the graph can ACTUALLY answer (avoiding dead-end steps that
 * would hit NOT_IN_GRAPH at run time). This is the cheapest effective grounding
 * for generated questions (feed the schema; don't dry-run every step).
 *
 * Strictly READ-ONLY: three `db.labels()` / `db.relationshipTypes()` / sample
 * reads via the existing `read()` path. Never writes, never on the answer path.
 * Cached briefly; any failure degrades to an empty schema (the draft engine then
 * simply skips schema-seeding and schema-lint — it never throws).
 */
import { read } from "../neo4j.js";

export interface GraphSchema {
  labels: string[];
  relationshipTypes: string[];
  sampleEntities: string[];
}

const EMPTY: GraphSchema = { labels: [], relationshipTypes: [], sampleEntities: [] };
const TTL_MS = 60_000;
let cache: GraphSchema | null = null;
let cacheAt = 0;

export async function getGraphSchema(): Promise<GraphSchema> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  try {
    const [labelRows, relRows, sampleRows] = await Promise.all([
      read<{ label: string }>("CALL db.labels() YIELD label RETURN label ORDER BY label"),
      read<{ rel: string }>(
        "CALL db.relationshipTypes() YIELD relationshipType AS rel RETURN rel ORDER BY rel",
      ),
      read<{ name: string }>(
        "MATCH (n) WITH coalesce(n.label, n.name, n.id) AS name WHERE name IS NOT NULL RETURN DISTINCT name LIMIT 40",
      ),
    ]);
    const schema: GraphSchema = {
      labels: labelRows.map((r) => r.label).filter(Boolean),
      relationshipTypes: relRows.map((r) => r.rel).filter(Boolean),
      sampleEntities: Array.from(new Set(sampleRows.map((r) => r.name).filter(Boolean))).slice(0, 30),
    };
    cache = schema;
    cacheAt = now;
    return schema;
  } catch {
    // Never block authoring on a schema read — degrade to empty (or last good).
    return cache ?? EMPTY;
  }
}

/** Test hook: drop the cached schema. */
export function invalidateSchemaCache(): void {
  cache = null;
  cacheAt = 0;
}
