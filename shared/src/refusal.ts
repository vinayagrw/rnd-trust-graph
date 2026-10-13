/**
 * The honest "not in the grounded graph" refusal — single source of truth.
 * The bff default config emits/gates on the marker (admin-config can override it at
 * runtime); the web detects the DEFAULT marker and offers these curated in-graph
 * next actions. Keeping both here removes the cross-workspace drift hazard.
 */
export const NOT_IN_GRAPH_MARKER = "NOT_IN_GRAPH:";

/** Curated in-graph questions offered when the graph can't answer — always a next action. */
export const REFUSAL_SUGGESTIONS: readonly string[] = [
  "What is the safety signal for the checkpoint inhibitor?",
  "How does the checkpoint inhibitor cause myocarditis?",
  "What evidence supports the myocarditis signal?",
];
