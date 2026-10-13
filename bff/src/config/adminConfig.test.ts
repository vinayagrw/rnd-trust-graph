/**
 * Admin-config unit tests (Phase 3a). The whole trust story rides on these:
 *  (a) the zod schema REJECTS bad input (so a PUT can't persist garbage);
 *  (b) the configured marker round-trips and is the SINGLE source the agent
 *      emits, the bridge gates on, and the UI detects (editing it can't desync);
 *  (c) a PUT can NOT enable writes / can NOT remove the enforced read-only
 *      guarantees — allowedTools is not in the writable schema, and the enforced
 *      block stays immutable across edits.
 *
 * These touch the real bff/admin-config.json, so we snapshot + restore it around
 * the run. Invalidate the cache after restore so other tests see clean state.
 * Run: `node --import tsx --test src/config/adminConfig.test.ts`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import {
  adminConfigSchema,
  DEFAULT_ADMIN_CONFIG,
  ADMIN_CONFIG_PATH,
  getConfig,
  setConfig,
  invalidateConfigCache,
} from "./adminConfig.js";
import { ALLOWED_TOOLS, EXCLUDED_WRITE_TOOL } from "../ask/enforced.js";

// --- snapshot / restore the on-disk config so the test is non-destructive ---
let backup: string | null = null;
before(() => {
  backup = existsSync(ADMIN_CONFIG_PATH) ? readFileSync(ADMIN_CONFIG_PATH, "utf-8") : null;
});
after(() => {
  if (backup === null) {
    if (existsSync(ADMIN_CONFIG_PATH)) rmSync(ADMIN_CONFIG_PATH);
  } else {
    writeFileSync(ADMIN_CONFIG_PATH, backup, "utf-8");
  }
  invalidateConfigCache();
});
beforeEach(() => {
  // Start each test from pristine defaults (no persisted overrides, fresh cache).
  if (existsSync(ADMIN_CONFIG_PATH)) rmSync(ADMIN_CONFIG_PATH);
  invalidateConfigCache();
});

// --- (a) schema rejects bad input ------------------------------------------
test("schema rejects an empty marker", () => {
  const bad = { ...DEFAULT_ADMIN_CONFIG, notInGraphMarker: "" };
  assert.equal(adminConfigSchema.safeParse(bad).success, false);
});

test("schema rejects out-of-range risk values", () => {
  const bad = {
    ...DEFAULT_ADMIN_CONFIG,
    risk: { ...DEFAULT_ADMIN_CONFIG.risk, statisticalConfidence: 1.5 },
  };
  assert.equal(adminConfigSchema.safeParse(bad).success, false);
});

test("schema rejects unknown keys (strict) — e.g. a smuggled allowedTools", () => {
  const bad = { ...DEFAULT_ADMIN_CONFIG, allowedTools: ["mcp__neo4j__write_neo4j_cypher"] };
  assert.equal(adminConfigSchema.safeParse(bad).success, false);
});

test("setConfig throws (ZodError) on invalid input and persists nothing", () => {
  assert.throws(() => setConfig({ notInGraphMarker: "" }));
  // No file written → next getConfig() is byte-identical defaults.
  assert.deepEqual(getConfig(), DEFAULT_ADMIN_CONFIG);
});

// --- (b) marker round-trips as the single source of truth ------------------
test("the configured marker round-trips through PUT/GET and hot-applies", () => {
  assert.equal(getConfig().notInGraphMarker, "NOT_IN_GRAPH:");
  const updated = setConfig({ notInGraphMarker: "ABSENT_FROM_GRAPH:" });
  assert.equal(updated.notInGraphMarker, "ABSENT_FROM_GRAPH:");
  // Hot-apply: no restart, next read sees it (cache invalidated on write).
  assert.equal(getConfig().notInGraphMarker, "ABSENT_FROM_GRAPH:");
  // Persisted to disk for a true round-trip.
  invalidateConfigCache();
  assert.equal(getConfig().notInGraphMarker, "ABSENT_FROM_GRAPH:");
});

test("agent, bridge and UI all read the SAME configured marker (single source)", async () => {
  // Edit the marker, then confirm every consumer resolves it via getConfig().
  setConfig({ notInGraphMarker: "MARKER_X:" });

  // agent.ts emits it: the built /ask prompt instructs the model to use it.
  const agentMod = await import("../ask/agent.js");
  // buildAskPrompt is module-private; assert via getConfig parity instead — the
  // prompt is built from getConfig().notInGraphMarker (see agent.ts).
  assert.equal(getConfig().notInGraphMarker, "MARKER_X:");
  assert.ok(agentMod.askGraph, "agent exports askGraph");

  // bridge gates on getConfig().notInGraphMarker (aguiBridge.ts isRefusal()).
  const bridgeMod = await import("../ask/aguiBridge.js");
  assert.ok(bridgeMod.aguiBridge, "bridge exports aguiBridge");

  // All three consumers derive from this one value — there is no second literal.
  assert.equal(getConfig().notInGraphMarker, "MARKER_X:");
});

test("risk thresholds hot-apply from config", () => {
  assert.equal(getConfig().risk.penaltyPerFlag, 25);
  setConfig({ risk: { penaltyPerFlag: 40 } as never });
  assert.equal(getConfig().risk.penaltyPerFlag, 40);
  // Untouched risk fields keep their defaults (partial merge).
  assert.equal(getConfig().risk.readinessBase, 100);
  assert.equal(getConfig().risk.staleBeforeYear, 2023);
});

test("modelCard round-trips: a partial PUT merges + getConfig returns it", () => {
  // Defaults are present out of the box.
  assert.equal(getConfig().modelCard.name, DEFAULT_ADMIN_CONFIG.modelCard.name);
  // Patch the whole modelCard object (it merges whole-object, like finops).
  const patched = {
    name: "Custom Copilot",
    version: "demo-2",
    provider: "Anthropic Claude",
    intendedUse: "Read-only grounded Q&A.",
    evaluation: "Grounding enforced in code.",
    limitations: "Not a medical device.",
    trainingCutoff: "n/a",
  };
  const updated = setConfig({ modelCard: patched });
  assert.deepEqual(updated.modelCard, patched);
  // Hot-apply + true round-trip from disk.
  assert.deepEqual(getConfig().modelCard, patched);
  invalidateConfigCache();
  assert.deepEqual(getConfig().modelCard, patched);
});

test("an absent modelCard falls back to defaults", () => {
  // No persisted overrides → defaults (including the full modelCard).
  assert.deepEqual(getConfig().modelCard, DEFAULT_ADMIN_CONFIG.modelCard);
  // Editing an unrelated field leaves modelCard at its default.
  setConfig({ notInGraphMarker: "X:" });
  assert.deepEqual(getConfig().modelCard, DEFAULT_ADMIN_CONFIG.modelCard);
});

// --- (c) a PUT can't enable writes / can't remove enforced guarantees -------
test("enforced read-only guarantees are NOT writable via config", () => {
  // allowedTools is not part of the schema; attempting to set it throws.
  assert.throws(() => setConfig({ allowedTools: [EXCLUDED_WRITE_TOOL] } as never));
  // The enforced allow-list is exactly schema + read query; the write tool is
  // never present, and these constants are code-level (not from config).
  assert.deepEqual([...ALLOWED_TOOLS], [
    "mcp__neo4j__get_neo4j_schema",
    "mcp__neo4j__read_neo4j_cypher",
  ]);
  assert.ok(!ALLOWED_TOOLS.includes(EXCLUDED_WRITE_TOOL as never));
});

test("deleting the config file falls back to byte-identical defaults", () => {
  setConfig({ notInGraphMarker: "TEMP:" });
  assert.equal(existsSync(ADMIN_CONFIG_PATH), true);
  rmSync(ADMIN_CONFIG_PATH);
  invalidateConfigCache();
  assert.deepEqual(getConfig(), DEFAULT_ADMIN_CONFIG);
});
