/**
 * /ask grounding eval — "does the live agent answer FROM the graph, or fall back?"
 *
 * The bug-hunt rounds proved the grounding INVARIANT (off-path citations are
 * refused). This harness measures the thing the invariant can't: the
 * GROUNDED-vs-FALLBACK rate. The schema-first /ask prompt (see askInstruction in
 * config/adminConfig.ts) is supposed to make the agent read the schema, write
 * Cypher that actually returns rows, and answer live — instead of writing empty
 * Cypher and silently dropping to the canned safeGraphAnswer fallback. This
 * script puts a number on that so prompt changes can be MEASURED, not asserted.
 *
 * It is a MEASUREMENT, not a pass/fail gate: the LLM is non-deterministic, so a
 * fallback is reported, not a test failure. It exits non-zero only on real infra
 * breakage (a grounded case that throws). Like the golden harness, it SKIPS
 * cleanly (exit 0) when live mode is off or Neo4j is unreachable, so it is safe
 * to wire into CI on a bare laptop.
 *
 * Run: `npm run eval:ask` (from bff/), or `tsx src/eval/askEval.ts`.
 * Live mode requires LLM_PROVIDER=claude-code (or an ANTHROPIC_API_KEY) AND a
 * reachable Neo4j with the demo graph loaded (`npm run etl`).
 */
import { askGraph } from "../ask/agent.js";
import { config, liveModeAvailable } from "../config.js";
import { getConfig } from "../config/adminConfig.js";
import { read, closeDriver } from "../neo4j.js";

type Kind = "grounded" | "offgraph";

interface EvalCase {
  id: string;
  question: string;
  kind: Kind;
  /** Substrings a correct grounded answer should contain (case-insensitive, any-of). */
  expectIncludes?: string[];
  /** Node IDs we'd expect the answer to cite (any-of is enough — under-citing is safe). */
  expectCitations?: string[];
}

/** Canonical questions grounded in the demo graph (see ask/agent.ts safeGraphAnswer
 *  + eval/golden.test.ts for the facts these probe). The "offgraph" cases have NO
 *  answer in the graph and SHOULD trigger the NOT_IN_GRAPH refusal, never a guess. */
const CASES: EvalCase[] = [
  {
    id: "signal-ae",
    question: "Which adverse event is the checkpoint inhibitor suspected in?",
    kind: "grounded",
    expectIncludes: ["myocard"],
    expectCitations: ["AE-MYOCARDITIS", "DRUG-CPI"],
  },
  {
    id: "prr-value",
    question: "What is the disproportionality signal (PRR) for the myocarditis signal?",
    kind: "grounded",
    expectIncludes: ["4.2"],
    expectCitations: ["STAT-MYO-CPI", "AE-MYOCARDITIS"],
  },
  {
    id: "case-count",
    question: "How many distinct patients reported the myocarditis adverse event?",
    kind: "grounded",
    expectIncludes: ["6", "six"],
    expectCitations: ["AE-MYOCARDITIS"],
  },
  {
    id: "mechanism",
    question: "What biological target and pathway does the checkpoint inhibitor act through?",
    kind: "grounded",
    expectCitations: ["DRUG-CPI"],
  },
  {
    id: "evidence",
    question: "What source evidence supports the myocarditis signal?",
    kind: "grounded",
    expectCitations: ["STAT-MYO-CPI"],
  },
  {
    id: "offgraph-dosage",
    question: "What is the recommended daily dosage of aspirin for an adult with a headache?",
    kind: "offgraph",
  },
  {
    id: "offgraph-entity",
    question: "Who is the current chief executive officer of Pfizer?",
    kind: "offgraph",
  },
];

interface RunResult {
  text: string;
  citations: string[];
  isFallback: boolean;
  reason?: string;
}

/** Drive askGraph once, accumulating the streamed answer + citations + terminal flags. */
async function runOne(question: string): Promise<RunResult> {
  let text = "";
  let citations: string[] = [];
  let isFallback = false;
  let reason: string | undefined;
  await askGraph(question, (event) => {
    if (event.type === "token" && typeof event.text === "string") text += event.text;
    else if (event.type === "citations") {
      const ids = (event as { nodeIds?: unknown }).nodeIds;
      if (Array.isArray(ids)) citations = ids.map(String);
    } else if (event.type === "done") {
      isFallback = Boolean((event as { isFallback?: unknown }).isFallback);
      reason = (event as { reason?: unknown }).reason as string | undefined;
    }
  });
  return { text, citations, isFallback, reason };
}

interface Scored {
  c: EvalCase;
  r: RunResult;
  grounded: boolean; // live grounded answer (not fallback) — the headline metric
  includeHit: boolean | null; // expectIncludes satisfied (null = none specified)
  citationHit: boolean | null; // expectCitations satisfied (null = none specified)
  refusalCorrect: boolean | null; // offgraph only: answer carries the marker
  ok: boolean; // overall: behaved as the case intends
}

function score(c: EvalCase, r: RunResult, marker: string): Scored {
  const lower = r.text.toLowerCase();
  const grounded = !r.isFallback;
  const includeHit =
    c.expectIncludes && c.expectIncludes.length
      ? c.expectIncludes.some((s) => lower.includes(s.toLowerCase()))
      : null;
  const citationHit =
    c.expectCitations && c.expectCitations.length
      ? c.expectCitations.some((id) => r.citations.includes(id))
      : null;

  if (c.kind === "offgraph") {
    // Correct behaviour: a grounded refusal carrying the marker, NOT a confident guess.
    const refusalCorrect = r.text.includes(marker);
    return { c, r, grounded, includeHit, citationHit, refusalCorrect, ok: refusalCorrect };
  }
  // Grounded case: must be a live answer (not fallback) and satisfy any stated
  // content/citation expectations. Unspecified expectations don't count against it.
  const ok = grounded && includeHit !== false && citationHit !== false;
  return { c, r, grounded, includeHit, citationHit, refusalCorrect: null, ok };
}

function tri(v: boolean | null): string {
  return v === null ? " · " : v ? " ✓ " : " ✗ ";
}

async function main(): Promise<number> {
  // --- skip gates (mirror golden.test.ts: never fail a bare-laptop CI) ---------
  if (!liveModeAvailable() || config.narrator.provider !== "claude-code") {
    console.log(
      "[ask-eval] SKIP — live /ask needs LLM_PROVIDER=claude-code (the agentic Cypher\n" +
        "           tool-loop path). Current provider: " +
        `${config.narrator.provider}. Nothing measured.`
    );
    return 0;
  }
  try {
    await read("RETURN 1 AS ok"); // driver carries its own timeout; cannot hang
  } catch {
    console.log("[ask-eval] SKIP — Neo4j unreachable. Start the DB and `npm run etl`, then re-run.");
    return 0;
  }

  const marker = getConfig().notInGraphMarker;
  console.log(
    `[ask-eval] model=${config.ask.model} maxTurns=${config.ask.maxTurns} marker="${marker}"\n` +
      `[ask-eval] running ${CASES.length} cases sequentially (live agent + Neo4j MCP)…\n`
  );

  const scored: Scored[] = [];
  let infraError = false;
  for (const c of CASES) {
    process.stdout.write(`  • ${c.id.padEnd(18)} `);
    try {
      const r = await runOne(c.question);
      const s = score(c, r, marker);
      scored.push(s);
      const tag =
        c.kind === "offgraph"
          ? `refusal${tri(s.refusalCorrect)}`
          : `${s.grounded ? "LIVE   " : "FALLBACK"} inc${tri(s.includeHit)} cite${tri(s.citationHit)}`;
      console.log(`${s.ok ? "OK  " : "MISS"} ${tag}${r.reason ? ` (${r.reason})` : ""}`);
    } catch (e) {
      // A grounded case that THROWS is real infra breakage, not a soft fallback.
      infraError = infraError || c.kind === "grounded";
      console.log(`ERROR — ${(e as Error)?.message ?? e}`);
    }
  }

  // --- scorecard ---------------------------------------------------------------
  const grounded = scored.filter((s) => s.c.kind === "grounded");
  const offgraph = scored.filter((s) => s.c.kind === "offgraph");
  const liveCount = grounded.filter((s) => s.grounded).length;
  const citeChecked = grounded.filter((s) => s.citationHit !== null);
  const citeHits = citeChecked.filter((s) => s.citationHit).length;
  const incChecked = grounded.filter((s) => s.includeHit !== null);
  const incHits = incChecked.filter((s) => s.includeHit).length;
  const refusalHits = offgraph.filter((s) => s.refusalCorrect).length;

  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "n/a");
  console.log("\n[ask-eval] ── scorecard ───────────────────────────────");
  console.log(`  grounded answers (live, not fallback): ${liveCount}/${grounded.length}  (${pct(liveCount, grounded.length)})`);
  console.log(`  expected content present:              ${incHits}/${incChecked.length}  (${pct(incHits, incChecked.length)})`);
  console.log(`  expected citation present:             ${citeHits}/${citeChecked.length}  (${pct(citeHits, citeChecked.length)})`);
  console.log(`  off-graph refused (NOT_IN_GRAPH):      ${refusalHits}/${offgraph.length}  (${pct(refusalHits, offgraph.length)})`);
  console.log("[ask-eval] ────────────────────────────────────────────");
  console.log(
    "  Note: a FALLBACK is reported, not a failure — it usually means the agent's\n" +
      "  Cypher returned no rows (often a prompt-quality signal). The grounded-rate is\n" +
      "  the number to watch when tuning askInstruction."
  );

  return infraError ? 1 : 0;
}

let code = 0;
try {
  code = await main();
} catch (e) {
  console.error("[ask-eval] harness error:", (e as Error)?.message ?? e);
  code = 1;
} finally {
  await closeDriver();
}
process.exit(code);
