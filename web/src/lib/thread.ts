/**
 * Shared conversation-thread helpers used by BOTH the full Beat 4 surface
 * (`CopilotChatBeat`) and the floating dock (`AskDock`). Centralizing the
 * `localStorage` key + the message dedupe here is what lets the two surfaces
 * address the SAME persistent thread in the BFF store: the dock saves under this
 * key, and Beat 4's mount-restore reads it back (and vice versa). Keep the key
 * value frozen — changing it would orphan every already-persisted thread.
 */
import type { ThreadMessage } from "../api.js";

/** localStorage key remembering the last-open thread so a reload — and a hand-off
 *  between the dock and Beat 4 — restores the same conversation. */
export const LAST_THREAD_KEY = "rtg.beat4.threadId";

/** Keep the first message per id. Guards the durable thread store from ever
 *  persisting (and later restoring) an array with a duplicate message id — which
 *  would render duplicate React keys on every future load. Messages without an
 *  id are passed through untouched. Order-preserving. */
export function dedupeById(messages: ThreadMessage[]): ThreadMessage[] {
  const seen = new Set<string>();
  return messages.filter((m) => {
    if (!m || typeof m.id !== "string" || m.id === "") return true;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}
