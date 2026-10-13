/**
 * Custom-playbook store unit tests (AI-assisted authoring).
 *
 * These pin the authoring trust story:
 *  (a) a saved playbook ROUND-TRIPS and is stamped origin:"custom" + timestamps;
 *  (b) structural validation REJECTS nonsense (no ask step; synth not last; ask
 *      without a question; checkpoint without a prompt; bad id; unknown key) so a
 *      bad save can't persist junk that later feeds the grounded agent;
 *  (c) create/update/delete behave (dup id rejected; update preserves createdAt);
 *  (d) authored strings are SANITIZED (control chars stripped);
 *  (e) TRUST: the store imports nothing from the graph layer, so it can never run
 *      Cypher or weaken grounding.
 *
 * Uses a scratch PLAYBOOKS_STORE_PATH so it never touches bff/playbooks-custom.json.
 * Run: `node --import tsx --test src/playbooks/store.test.ts`.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = join(tmpdir(), `rtg-playbooks-test-${process.pid}.json`);
process.env.PLAYBOOKS_STORE_PATH = SCRATCH;

const {
  listCustom,
  getCustom,
  createCustom,
  updateCustom,
  deleteCustom,
  invalidatePlaybookCache,
  PLAYBOOKS_STORE_PATH,
} = await import("./store.js");

/** A minimal valid definition. */
function goodDef(id = "hepatotox-dossier") {
  return {
    id,
    title: "Hepatotoxicity dossier",
    description: "Signal, mechanism, evidence, sign-off.",
    steps: [
      { id: "signal", kind: "ask", title: "Signal", question: "What is the hepatotoxicity signal?" },
      { id: "review", kind: "checkpoint", title: "Sign-off", prompt: "Confirm the conclusion." },
      { id: "assemble", kind: "synth", title: "Assemble dossier" },
    ],
  };
}

function cleanup() {
  if (existsSync(SCRATCH)) unlinkSync(SCRATCH);
  invalidatePlaybookCache();
}

before(() => assert.equal(PLAYBOOKS_STORE_PATH, SCRATCH, "must use scratch store"));
beforeEach(cleanup);
after(cleanup);

test("create -> get -> list round-trips and stamps origin + timestamps", () => {
  const pb = createCustom(goodDef(), "Dr. A. Reviewer");
  assert.equal(pb.origin, "custom");
  assert.equal(pb.createdBy, "Dr. A. Reviewer");
  assert.ok(pb.createdAt && pb.updatedAt, "timestamps stamped");

  const got = getCustom("hepatotox-dossier");
  assert.equal(got?.title, "Hepatotoxicity dossier");
  assert.equal(got?.steps.length, 3);

  const list = listCustom();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "hepatotox-dossier");
});

test("survives a cache drop (reload) by re-reading disk", () => {
  createCustom(goodDef());
  invalidatePlaybookCache();
  assert.equal(getCustom("hepatotox-dossier")?.title, "Hepatotoxicity dossier");
  assert.ok(existsSync(SCRATCH), "store file is written to disk");
});

test("duplicate id is rejected", () => {
  createCustom(goodDef());
  assert.throws(() => createCustom(goodDef()), /already exists/);
});

test("update preserves createdAt/createdBy and bumps updatedAt", () => {
  const a = createCustom(goodDef(), "Dr. A");
  invalidatePlaybookCache();
  const b = updateCustom("hepatotox-dossier", { ...goodDef(), title: "Hepatotoxicity dossier v2" });
  assert.equal(b.title, "Hepatotoxicity dossier v2");
  assert.equal(b.createdAt, a.createdAt, "createdAt preserved");
  assert.equal(b.createdBy, "Dr. A", "createdBy preserved");
  assert.ok((b.updatedAt ?? 0) >= (a.updatedAt ?? 0), "updatedAt refreshed");
});

test("delete returns true then false", () => {
  createCustom(goodDef());
  assert.equal(deleteCustom("hepatotox-dossier"), true);
  assert.equal(deleteCustom("hepatotox-dossier"), false, "second delete is a no-op");
  assert.deepEqual(listCustom(), []);
});

test("structural validation REJECTS nonsense", () => {
  // No ask step.
  assert.throws(() =>
    createCustom({
      id: "no-ask",
      title: "t",
      description: "d",
      steps: [{ id: "s", kind: "synth", title: "Assemble" }],
    }),
  );
  // synth not last.
  assert.throws(() =>
    createCustom({
      id: "bad-order",
      title: "t",
      description: "d",
      steps: [
        { id: "a", kind: "synth", title: "Assemble" },
        { id: "b", kind: "ask", title: "Q", question: "what?" },
      ],
    }),
  );
  // ask without a question.
  assert.throws(() =>
    createCustom({
      id: "ask-no-q",
      title: "t",
      description: "d",
      steps: [{ id: "a", kind: "ask", title: "Q" }],
    }),
  );
  // checkpoint without a prompt.
  assert.throws(() =>
    createCustom({
      id: "cp-no-prompt",
      title: "t",
      description: "d",
      steps: [
        { id: "a", kind: "ask", title: "Q", question: "what?" },
        { id: "c", kind: "checkpoint", title: "Review" },
      ],
    }),
  );
  // Non-kebab id.
  assert.throws(() => createCustom({ ...goodDef(), id: "Not Kebab!" }));
  // Unknown top-level key (strict).
  assert.throws(() => createCustom({ ...goodDef(), evil: true }));
});

test("authored strings are sanitized (control chars stripped)", () => {
  // A literal BEL (0x07) + a stray tab between words -> collapsed to one space.
  const dirty = "Clean" + String.fromCharCode(7) + "\ttitle";
  const pb = createCustom({ ...goodDef("sanitize-me"), title: dirty });
  assert.equal(pb.title, "Clean title", "control chars replaced + whitespace collapsed");
});

test("a missing store file yields an empty list (never throws)", () => {
  cleanup();
  assert.deepEqual(listCustom(), []);
  assert.equal(getCustom("nope"), undefined);
});

test("TRUST: store imports nothing from the graph layer", () => {
  const mod = readFileSync(join(import.meta.dirname, "store.ts"), "utf-8");
  assert.doesNotMatch(
    mod,
    /from ["']\.\.\/(neo4j|graph)|from ["']\.\/(schema|draft)|from ["']\.\.\/ask\//,
    "the store must stay a dumb persistence sink",
  );
  // And the persisted blob carries no graph secret / write clause.
  createCustom(goodDef());
  const raw = readFileSync(SCRATCH, "utf-8");
  assert.doesNotMatch(raw, /\b(MERGE|DETACH)\b|bolt:\/\/|neo4j:\/\/|password/i);
});
