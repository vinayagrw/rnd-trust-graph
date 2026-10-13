/**
 * Enforced, NON-EDITABLE grounding guarantees for /ask.
 *
 * These are the structural trust guarantees of the demo and are deliberately
 * kept OUT of the editable admin config (see config/adminConfig.ts). They live
 * in code so that no live config edit — and no weakened prompt — can ever enable
 * a write, broaden the tool surface, or disable the off-path-citation refusal.
 *
 * Single source of truth: agent.ts uses ALLOWED_TOOLS as its allow-list, and
 * server.ts surfaces these same constants in the read-only `enforced` block of
 * GET /api/admin/config so the admin UI can DISPLAY them as locked.
 */

/** The ONLY tools the /ask agent may call: schema (to write correct Cypher) +
 *  read query. The write tool is deliberately absent and must never be added. */
export const ALLOWED_TOOLS = [
  "mcp__neo4j__get_neo4j_schema",
  "mcp__neo4j__read_neo4j_cypher",
] as const;

/** The write tool that is deliberately never in ALLOWED_TOOLS. */
export const EXCLUDED_WRITE_TOOL = "mcp__neo4j__write_neo4j_cypher";
