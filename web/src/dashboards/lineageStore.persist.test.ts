import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardSpec } from "@rnd/shared";

// Map-backed sessionStorage polyfill (node has no DOM). Set BEFORE calling the store.
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return Array.from(this.m.keys())[i] ?? null; }
}
(globalThis as any).sessionStorage = new MemStorage();

const {
  applyIncoming,
  resetLineage,
  rehydrate,
  currentSpec,
  subscribe,
  scheduleStudioReset,
  cancelScheduledStudioReset,
} = await import("./lineageStore.js");

const tick = () => new Promise((r) => setTimeout(r, 5));

const spec = (id: string, node: string): DashboardSpec => ({
  version: 1, title: "t", widgets: [{ id, kind: "citation-chips", nodeIds: [node] }], citedNodeIds: [node], source: "llm",
});

test("applyIncoming persists the studio board to sessionStorage as a {current, committed} envelope", () => {
  resetLineage("studio");
  applyIncoming(spec("b", "N2"), "studio");
  const raw = sessionStorage.getItem("rtg.studio.board");
  assert.ok(raw, "expected a persisted board");
  const envelope = JSON.parse(raw!);
  assert.equal(envelope.current.widgets[0].id, "b");
  assert.equal(envelope.committed, null); // no final reconcile yet — nothing committed
});

test("rehydrate restores a persisted studio board into memory", () => {
  resetLineage("studio"); // clears memory + storage
  sessionStorage.setItem("rtg.studio.board", JSON.stringify(spec("a", "N1")));
  rehydrate("studio");
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["a"]);
});

test("resetLineage(studio) clears the persisted board", () => {
  applyIncoming(spec("c", "N3"), "studio");
  resetLineage("studio");
  assert.equal(sessionStorage.getItem("rtg.studio.board"), null);
});

test("a failed run's partial does not survive a reload+retry (committed rides the envelope)", () => {
  resetLineage("studio");
  // r1 streams [w1] and reconciles — its final is byte-identical to the delta
  // (sig-cache hit), which must still commit [w1] as the rollback base.
  applyIncoming(spec("w1", "N1"), "studio", { runId: "r1" });
  applyIncoming(spec("w1", "N1"), "studio", { runId: "r1", final: true });
  // r2 streams a partial [p]; the stream dies before its final.
  applyIncoming(spec("p", "N1"), "studio", { runId: "r2" });
  const raw = sessionStorage.getItem("rtg.studio.board");
  assert.ok(raw, "expected a persisted board");
  // Simulated tab reload: fresh memory, same sessionStorage contents.
  resetLineage("studio"); // clears storage too...
  sessionStorage.setItem("rtg.studio.board", raw!); // ...so restore the captured value
  rehydrate("studio");
  // Display restores the working board (partial included)...
  assert.ok(currentSpec("studio")?.widgets.some((w) => w.id === "p"), "partial restored for display");
  // ...but the retry rolls back to the COMMITTED base — p must be gone.
  applyIncoming(spec("w2", "N1"), "studio", { runId: "r3" });
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["w1", "w2"]);
});

test("a never-finalized envelope restores display only — no promotion to the rollback base", () => {
  resetLineage("studio");
  sessionStorage.setItem("rtg.studio.board", JSON.stringify({ current: spec("p", "N1"), committed: null }));
  rehydrate("studio");
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["p"]); // display restored
  // The next run starts from the (null) committed base — the partial disappears.
  applyIncoming(spec("w2", "N1"), "studio", { runId: "r4" });
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["w2"]);
});

test("legacy bare-spec storage rehydrates as both current and committed", () => {
  resetLineage("studio");
  sessionStorage.setItem("rtg.studio.board", JSON.stringify(spec("a", "N1")));
  rehydrate("studio");
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["a"]);
  // A new run merges ONTO the restored board (not discarded).
  applyIncoming(spec("b", "N1"), "studio", { runId: "r5" });
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["a", "b"]);
});

test("scheduleStudioReset clears the board + storage on the next tick", async () => {
  resetLineage("studio");
  applyIncoming(spec("d", "N4"), "studio");
  scheduleStudioReset();
  await tick();
  assert.equal(currentSpec("studio"), null);
  assert.equal(sessionStorage.getItem("rtg.studio.board"), null);
});

test("cancelScheduledStudioReset rescues the board (StrictMode remount cycle)", async () => {
  resetLineage("studio");
  applyIncoming(spec("e", "N5"), "studio");
  scheduleStudioReset(); // StrictMode cleanup...
  cancelScheduledStudioReset(); // ...immediately followed by the remount
  await tick();
  assert.deepEqual(currentSpec("studio")?.widgets.map((w) => w.id), ["e"]);
  assert.ok(sessionStorage.getItem("rtg.studio.board"), "storage must survive the cancelled reset");
});

test("scheduling twice yields a single clear and does not throw", async () => {
  resetLineage("studio");
  applyIncoming(spec("f", "N6"), "studio");
  let hits = 0;
  const off = subscribe("studio", () => { hits++; });
  scheduleStudioReset();
  scheduleStudioReset();
  await tick();
  off();
  assert.equal(currentSpec("studio"), null);
  assert.equal(hits, 1); // one reset-notify, not two
});
