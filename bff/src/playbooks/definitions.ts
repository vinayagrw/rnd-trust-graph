/**
 * F5 — curated scientific-workflow playbooks ("safety dossiers") + the
 * orchestration layer over the user-authored (AI-assisted) custom playbooks.
 *
 * A playbook is a definition-driven ordered list of steps. `ask` steps run the
 * REAL grounded agent (so each refuses off-graph on its own); `checkpoint` steps
 * enqueue a HITL review (non-blocking — the reviewer approves asynchronously);
 * `synth` marks dossier assembly. No new answer source, no new write path — pure
 * orchestration over the existing grounded agent + authorized writer.
 *
 * Curated playbooks ship in code and are READ-ONLY (immutable + undeletable);
 * custom ones live in `store.ts` (playbooks-custom.json). This module is the
 * single place that MERGES the two and enforces curated immutability, so the
 * store stays a dumb persistence sink.
 */
import type { Playbook } from "@rnd/shared";
import {
  createCustom,
  deleteCustom,
  getCustom,
  hasCustom,
  listCustom,
  updateCustom,
} from "./store.js";

export const PLAYBOOKS: Playbook[] = [
  {
    id: "myocarditis-safety-dossier",
    title: "Myocarditis safety dossier",
    description:
      "Assemble a grounded safety dossier for the checkpoint-inhibitor myocarditis " +
      "signal: state the signal, trace its mechanism, gather the supporting evidence, " +
      "then route the conclusion to a reviewer.",
    origin: "curated",
    steps: [
      {
        id: "signal",
        kind: "ask",
        title: "Safety signal",
        question: "What is the safety signal for the checkpoint inhibitor?",
      },
      {
        id: "mechanism",
        kind: "ask",
        title: "Mechanism",
        question: "How does the checkpoint inhibitor cause myocarditis?",
      },
      {
        id: "evidence",
        kind: "ask",
        title: "Supporting evidence",
        question: "What evidence supports the myocarditis signal?",
      },
      {
        id: "review",
        kind: "checkpoint",
        title: "Reviewer sign-off",
        prompt: "Confirm the myocarditis safety conclusion for the dossier.",
      },
      { id: "assemble", kind: "synth", title: "Assemble dossier" },
    ],
  },
];

/** Ids that ship in code — reserved, immutable, and un-collidable by custom ones. */
export const CURATED_IDS = new Set(PLAYBOOKS.map((p) => p.id));

/** Every runnable playbook — curated first, then custom (newest first). */
export function listPlaybooks(): Playbook[] {
  return [...PLAYBOOKS, ...listCustom()];
}

/** Look up a playbook by id across curated + custom. */
export function getPlaybook(id: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.id === id) ?? getCustom(id);
}

/** Raised when a write targets a curated (read-only) id. Mapped to 409 by the route. */
export class CuratedReadOnlyError extends Error {
  constructor(id: string) {
    super(`playbook "${id}" is curated and read-only`);
    this.name = "CuratedReadOnlyError";
  }
}

/** Create a custom playbook. Rejects a curated-id collision (they are reserved).
 *  Throws ZodError on an invalid shape (route → 400) or a plain Error on a
 *  duplicate custom id. */
export function createPlaybook(input: unknown, createdBy?: string): Playbook {
  const id = (input as { id?: unknown })?.id;
  if (typeof id === "string" && CURATED_IDS.has(id)) throw new CuratedReadOnlyError(id);
  return createCustom(input, createdBy);
}

/** Update a custom playbook. Curated ids are immutable. */
export function updatePlaybook(id: string, input: unknown, updatedBy?: string): Playbook {
  if (CURATED_IDS.has(id)) throw new CuratedReadOnlyError(id);
  return updateCustom(id, input, updatedBy);
}

/** Delete a custom playbook. Curated ids cannot be deleted. Returns false if the
 *  id did not exist among custom playbooks. */
export function deletePlaybook(id: string): boolean {
  if (CURATED_IDS.has(id)) throw new CuratedReadOnlyError(id);
  return deleteCustom(id);
}

/** True when the id belongs to an existing custom playbook. */
export function isCustomPlaybook(id: string): boolean {
  return hasCustom(id);
}
