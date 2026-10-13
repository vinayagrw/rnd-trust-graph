/**
 * Board planner — hermetic tests.
 *
 * The planner emits INTENT only (archetype + which fields to filter + slots). The
 * `.strict()` schema is the trust guard: a plan that tries to smuggle a span, a
 * chart config, or any data value must FAIL to parse. `planBoard` never throws —
 * on any failure it returns the deterministic `defaultPlan`. Both `run` (the LLM
 * transport) and the field menu (via the real `bindFromGraph`) are injected, so no
 * Neo4j and no real CLI are touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { GraphPayload, GraphNode, GraphEdge } from "@rnd/shared";
import type { ClaudeCodeRunOpts, ClaudeCodeResult } from "../llm/claudeCode.js";
import { bindFromGraph } from "./bind.js";
import { boardPlanSchema, planBoard, defaultPlan, MAX_SLOTS } from "./plan.js";

const nodes: GraphNode[] = [
  { id: "n1", kind: "Drug", label: "Drug A" },
  { id: "n2", kind: "AdverseEvent", label: "AE B" },
  { id: "n3", kind: "AdverseEvent", label: "AE C" },
];
const edges: GraphEdge[] = [{ id: "e1", source: "n1", target: "n2", kind: "TARGETS" }];
const graph: GraphPayload = { nodes, edges };
const cited = ["n1", "n2", "n3"];
const input = { question: "why afib?", answerText: "supported by disproportionality metrics." };

const menu = async () => (await bindFromGraph(graph, cited)).fieldMenu;

function scriptedProvider(scripts: string[]) {
  const prompts: string[] = [];
  let calls = 0;
  const run = async (opts: ClaudeCodeRunOpts): Promise<ClaudeCodeResult> => {
    prompts.push(opts.prompt);
    const script = scripts[calls] ?? scripts[scripts.length - 1] ?? "";
    calls++;
    for (let i = 1; i <= script.length; i += 5) opts.sink({ type: "token", text: script.slice(i - 1, i + 4) });
    return { ok: true };
  };
  return { run, prompts, callCount: () => calls };
}

const planBuffer = (plan: unknown) => JSON.stringify({ plan: [plan] });

test("boardPlanSchema is STRICT — a slot with an injected span, or a top-level config, fails to parse", async () => {
  const schema = boardPlanSchema(await menu());
  const withSpan = { archetype: "kpi-grid", filterFields: [], slots: [{ role: "kpi", dataset: "cited", intent: "count", span: 2 }] };
  assert.equal(schema.safeParse(withSpan).success, false, "a model-authored span must be rejected");
  const withConfig = { archetype: "kpi-grid", filterFields: [], slots: [{ role: "detail", dataset: "cited", intent: "x" }], config: {} };
  assert.equal(schema.safeParse(withConfig).success, false, "a model-authored config must be rejected");
});

test("boardPlanSchema ACCEPTS the new host-computed KPI-family roles (gauge, spark) as INTENT", async () => {
  const schema = boardPlanSchema(await menu());
  const withGaugeSpark = {
    archetype: "kpi-grid",
    filterFields: [],
    slots: [
      { role: "gauge", dataset: "metrics", intent: "PRR level on a dial" },
      { role: "spark", dataset: "metrics", intent: "ROR trend" },
    ],
  };
  const parsed = schema.safeParse(withGaugeSpark);
  assert.equal(parsed.success, true, "gauge and spark are valid planner intents");
  // Still INTENT-only: a gauge slot smuggling a domain/number must be rejected.
  const withDomain = { archetype: "kpi-grid", filterFields: [], slots: [{ role: "gauge", dataset: "metrics", intent: "x", domain: [0, 10] }] };
  assert.equal(schema.safeParse(withDomain).success, false, "a model-authored domain must be rejected");
});

test("the plan prompt describes the gauge and spark roles", async () => {
  const provider = scriptedProvider([planBuffer({ archetype: "kpi-grid", filterFields: [], slots: [{ role: "kpi", dataset: "cited", intent: "count" }] })]);
  await planBoard(input, await menu(), { run: provider.run });
  assert.match(provider.prompts[0]!, /gauge:/);
  assert.match(provider.prompts[0]!, /spark:/);
});

test("filterFields must be names drawn from the field menu", async () => {
  const schema = boardPlanSchema(await menu());
  const good = { archetype: "analytic-grid", filterFields: ["kind"], slots: [{ role: "detail", dataset: "cited", intent: "by kind" }] };
  assert.equal(schema.safeParse(good).success, true);
  const bad = { archetype: "analytic-grid", filterFields: ["not_a_field"], slots: [{ role: "detail", dataset: "cited", intent: "x" }] };
  assert.equal(schema.safeParse(bad).success, false);
});

test("planBoard returns the model's plan when it parses, and the prompt shows the menu + archetypes", async () => {
  const plan = {
    archetype: "hero-rail",
    filterFields: ["kind"],
    slots: [{ role: "hero", dataset: "metrics", intent: "signal values" }, { role: "detail", dataset: "cited", intent: "by kind" }],
  };
  const provider = scriptedProvider([planBuffer(plan)]);
  const result = await planBoard(input, await menu(), { run: provider.run });
  assert.equal(result.archetype, "hero-rail");
  assert.deepEqual(result.filterFields, ["kind"]);
  assert.equal(result.slots.length, 2);
  assert.match(provider.prompts[0]!, /kind \(nominal/);
  assert.match(provider.prompts[0]!, /hero-rail/);
  assert.match(provider.prompts[0]!, /"plan"/);
});

test("a throwing run yields the deterministic default plan — never throws", async () => {
  const fm = await menu();
  const run = async (): Promise<ClaudeCodeResult> => { throw new Error("boom"); };
  const result = await planBoard(input, fm, { run });
  assert.equal(result.archetype, defaultPlan(fm).archetype);
  assert.ok(result.slots.length >= 1);
});

test("an unparseable reply falls back to the default plan", async () => {
  const fm = await menu();
  const provider = scriptedProvider(["not json at all"]);
  const result = await planBoard(input, fm, { run: provider.run });
  assert.equal(result.archetype, defaultPlan(fm).archetype);
});

test("defaultPlan picks analytic-grid and low-cardinality nominal filter fields (never a quantitative one)", async () => {
  const dp = defaultPlan(await menu());
  assert.equal(dp.archetype, "analytic-grid");
  assert.ok(dp.slots.length >= 1 && dp.slots.length <= MAX_SLOTS);
  assert.ok(dp.filterFields.includes("kind"), "kind (2 distinct) is a good filter");
  assert.ok(!dp.filterFields.includes("degree"), "degree is quantitative — not a categorical filter field");
});
