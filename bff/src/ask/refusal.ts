import { REFUSAL_SUGGESTIONS } from "@rnd/shared";

/** True when an answer is the honest "not in the grounded graph" refusal. */
export function containsRefusal(text: string, marker: string): boolean {
  return typeof text === "string" && text.includes(marker);
}
/** Curated in-graph questions offered when the graph can't answer — always a next
 *  action. The strings live in `@rnd/shared` (single source, shared with the web). */
export function refusalSuggestions(): string[] {
  return [...REFUSAL_SUGGESTIONS];
}
