// Fast unit tests for the event-derived state machine. No HTTP, no OpenCode.
import test from "node:test";
import assert from "node:assert/strict";
import { PetState, STATE, keyOf } from "../src/state.mjs";

const SERVER = "http://127.0.0.1:1";

const newStore = () => {
  const store = new PetState();
  store.upsertSession(SERVER, { id: "s1", title: "One", time: { created: 1 } });
  return store;
};

test("a new session starts idle", () => {
  const store = newStore();
  const rec = store.sessions.get(keyOf(SERVER, "s1"));
  assert.equal(rec.state, STATE.IDLE);
  assert.equal(rec.title, "One");
  assert.equal(store.snapshot().sessions[0].title, "One");
});

test("busy, text and idle events drive the record", () => {
  const store = newStore();
  const rec = store.sessions.get(keyOf(SERVER, "s1"));

  store.setStatus(SERVER, "s1", { type: "busy" });
  assert.equal(rec.state, STATE.RUNNING);

  store.noteDelta(SERVER, "s1", "alive");
  assert.equal(rec.lastText, "alive");

  store.noteAssistantPart(SERVER, "s1", { type: "text", text: "alive" });
  assert.equal(rec.lastText, "alive");

  store.setStatus(SERVER, "s1", { type: "idle" });
  assert.equal(rec.state, STATE.IDLE);
});

test("an error keeps its detail", () => {
  const store = newStore();
  store.setError(SERVER, "s1", "Insufficient balance");
  const rec = store.snapshot().sessions[0];
  assert.equal(rec.state, STATE.ERROR);
  assert.equal(rec.detail, "Insufficient balance");
});

test("a retry event surfaces the server's label", () => {
  const store = newStore();
  store.setStatus(SERVER, "s1", { type: "retry", action: { label: "Retrying" } });
  const rec = store.sessions.get(keyOf(SERVER, "s1"));
  assert.equal(rec.state, STATE.ERROR);
  assert.equal(rec.detail, "Retrying");
});

test("a pending permission puts the session in waiting", () => {
  const store = newStore();
  const rec = store.sessions.get(keyOf(SERVER, "s1"));

  store.replacePermissions(SERVER, [{ id: "p1", sessionID: "s1", permission: "bash" }]);
  assert.equal(rec.state, STATE.WAITING);

  store.removePermission("p1");
  assert.equal(rec.state, STATE.IDLE);
});

test("a pending form puts the session in waiting", () => {
  const store = newStore();
  const rec = store.sessions.get(keyOf(SERVER, "s1"));

  store.replaceForms(SERVER, [{ id: "f1", sessionID: "s1", title: "Pick one" }]);
  assert.equal(rec.state, STATE.WAITING);

  store.removeForm("f1");
  assert.equal(rec.state, STATE.IDLE);
});

test("queued inbox items are exposed without touching messages", () => {
  const store = newStore();
  store.upsertInbox(SERVER, "s1", { id: "i1", type: "user", payload: { text: "later" } });
  const queued = store.snapshot().sessions[0].queued;
  assert.deepEqual(queued.map((q) => q.text), ["later"]);

  store.removeInbox(SERVER, "s1", "i1");
  assert.deepEqual(store.snapshot().sessions[0].queued, []);
});

test("a plan turn that finishes marks the session plan-ready", () => {
  const store = newStore();
  store.upsertSession(SERVER, { id: "s1", agent: "plan" });
  store.setStatus(SERVER, "s1", { type: "busy" });
  assert.equal(store.snapshot().sessions[0].planReady, false);

  store.setStatus(SERVER, "s1", { type: "idle" });
  assert.equal(store.snapshot().sessions[0].planReady, true);

  // A new turn in plan mode is not a finished plan anymore.
  store.setStatus(SERVER, "s1", { type: "busy" });
  assert.equal(store.snapshot().sessions[0].planReady, false);
  store.setStatus(SERVER, "s1", { type: "idle" });
  assert.equal(store.snapshot().sessions[0].planReady, true);

  // Leaving the plan agent makes the plan no longer actionable.
  store.upsertSession(SERVER, { id: "s1", agent: "build" });
  assert.equal(store.snapshot().sessions[0].planReady, false);
});

test("switching an idle session to plan does not mark it ready", () => {
  const store = newStore();
  store.upsertSession(SERVER, { id: "s1", agent: "plan" });
  assert.equal(store.snapshot().sessions[0].planReady, false);
});

test("plan readiness can be reconstructed from the last assistant turn", () => {
  const store = newStore();
  store.upsertSession(SERVER, { id: "s1", agent: "plan" });

  // The last completed turn was the plan agent, so the plan is ready.
  store.setPlanReady(SERVER, "s1", { ready: true, text: "the plan", stamp: 10 });
  let rec = store.snapshot().sessions[0];
  assert.equal(rec.planReady, true);
  assert.equal(rec.lastText, "the plan");

  // A later build turn is not a plan, even though the session still says plan
  // agent in a stale record.
  store.setPlanReady(SERVER, "s1", { ready: false, text: "implemented", stamp: 20 });
  rec = store.snapshot().sessions[0];
  assert.equal(rec.planReady, false);
  assert.equal(rec.lastText, "implemented");

  // A running plan session is never "ready" to hand off.
  store.setStatus(SERVER, "s1", { type: "busy" });
  store.setPlanReady(SERVER, "s1", { ready: true, text: "still working", stamp: 30 });
  assert.equal(store.snapshot().sessions[0].planReady, false);
});

test("backfilled readiness still requires the plan agent", () => {
  const store = newStore();
  store.upsertSession(SERVER, { id: "s1", agent: "build" });
  store.setPlanReady(SERVER, "s1", { ready: true, text: "old plan", stamp: 10 });
  assert.equal(store.snapshot().sessions[0].planReady, false);
});

test("a staged revert boundary is exposed on the session", () => {
  const store = newStore();
  store.setRevert(SERVER, "s1", { messageID: "msg_1" });
  assert.equal(store.snapshot().sessions[0].revert?.messageID, "msg_1");
  store.setRevert(SERVER, "s1", null);
  assert.equal(store.snapshot().sessions[0].revert, null);
});

test("a pet-hidden session stays in the list but leaves the pet", () => {
  const store = newStore();
  store.setStatus(SERVER, "s1", { type: "busy" });
  store.hideSession(SERVER, "s1");
  let snap = store.snapshot();
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].petHidden, true);
  assert.equal(snap.pet.state, "idle");
  assert.equal(snap.pet.total, 0);
  assert.equal(snap.pet.label, "all hidden");

  store.unhideSession("s1");
  snap = store.snapshot();
  assert.equal(snap.sessions[0].petHidden, false);
  assert.equal(snap.pet.state, "running");
  assert.equal(snap.pet.total, 1);
});

test("aggregate stats keep the largest server snapshot", () => {
  const store = new PetState();
  store.addServer("http://a");
  store.setServerOnline("http://a", true);
  store.addServer("http://b");
  store.setServerOnline("http://b", true);
  store.setStats("http://a", {
    sessions: 5,
    subagents: 0,
    tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
    cost: 0.5,
    range: { from: 1, to: 2 },
  });
  store.setStats("http://b", {
    sessions: 12,
    subagents: 1,
    tokens: { input: 100, output: 20, reasoning: 7, cache: { read: 30, write: 0 } },
    cost: 1.5,
    range: { from: 1, to: 3 },
  });
  const stats = store.snapshot().stats;
  assert.equal(stats.sessions, 12);
  assert.equal(stats.subagents, 1);
  assert.equal(stats.tokens.input, 100);
  assert.equal(stats.cost, 1.5);
});

// Deterministic clock for ordering tests: Date.now() advances on every call.
const withClock = (fn) => {
  const real = Date.now;
  let t = 1_000_000;
  Date.now = () => t++;
  try { return fn(); } finally { Date.now = real; }
};

test("idle sessions are ordered by when they ended, not when they started", () => {
  withClock(() => {
    const store = new PetState();
    store.upsertSession(SERVER, { id: "a", title: "A", time: { created: 100 } });
    store.upsertSession(SERVER, { id: "b", title: "B", time: { created: 200 } });
    store.setStatus(SERVER, "b", { type: "busy" });
    store.setStatus(SERVER, "a", { type: "busy" });
    store.setStatus(SERVER, "b", { type: "idle" }); // B ends first
    store.setStatus(SERVER, "a", { type: "idle" }); // A ends last
    assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ["a", "b"]);
  });
});

test("a rename moves an idle session; token bookkeeping does not", () => {
  withClock(() => {
    const store = new PetState();
    store.upsertSession(SERVER, { id: "a", title: "A", time: { created: 100 } });
    store.upsertSession(SERVER, { id: "b", title: "B", time: { created: 200 } });
    assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ["b", "a"]);

    store.upsertSession(SERVER, { id: "a", tokens: { input: 5 } });
    assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ["b", "a"]);

    store.upsertSession(SERVER, { id: "a", title: "A renamed" });
    assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ["a", "b"]);
  });
});

test("an unchanged sync does not move an idle session", () => {
  const store = new PetState();
  const info = { id: "a", title: "A", time: { created: 1000, updated: 2000, busy: 1900, idle: 2100 } };
  store.upsertSession(SERVER, info);
  const rec = store.sessions.get(keyOf(SERVER, "a"));
  const before = rec.updatedAt;
  store.upsertSession(SERVER, { ...info });
  assert.equal(rec.updatedAt, before);
});

test("clearing a permission ends the turn and moves the session", () => {
  withClock(() => {
    const store = new PetState();
    store.upsertSession(SERVER, { id: "a", time: { created: 100 } });
    store.upsertSession(SERVER, { id: "b", time: { created: 200 } });
    store.setStatus(SERVER, "a", { type: "busy" });
    store.replacePermissions(SERVER, [{ id: "p1", sessionID: "a", permission: "bash" }]);
    store.setStatus(SERVER, "a", { type: "idle" }); // turn ended, question pending
    store.setStatus(SERVER, "b", { type: "busy" });
    store.setStatus(SERVER, "b", { type: "idle" });
    store.replacePermissions(SERVER, []);
    const sessions = store.snapshot().sessions;
    assert.equal(sessions[0].id, "a");
    assert.equal(sessions[0].state, STATE.IDLE);
  });
});

test("active sessions follow the last user request", () => {
  withClock(() => {
    const store = new PetState();
    store.upsertSession(SERVER, { id: "a", time: { created: 100 } });
    store.upsertSession(SERVER, { id: "b", time: { created: 200 } });
    store.setStatus(SERVER, "a", { type: "busy" });
    store.setStatus(SERVER, "b", { type: "busy" });
    assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ["b", "a"]);

    // Repeated busy polls are not new requests and must not reorder.
    store.setStatus(SERVER, "b", { type: "busy" });
    store.setStatus(SERVER, "a", { type: "busy" });
    assert.deepEqual(store.snapshot().sessions.map((s) => s.id), ["b", "a"]);
  });
});

test("a synced idle session keeps its server end time", () => {
  const store = new PetState();
  store.upsertSession(SERVER, { id: "a", time: { created: 1000, updated: 2000, busy: 1900, idle: 2100 } });
  store.upsertSession(SERVER, { id: "b", time: { created: 900, updated: 1800, busy: 1700, idle: 1850 } });
  const sessions = store.snapshot().sessions;
  assert.deepEqual(sessions.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(sessions.map((s) => s.updatedAt), [2100, 1850]);
});

test("deleting a session also drops its hidden marker", () => {
  const store = newStore();
  store.hideSession(SERVER, "s1");
  assert.equal(store.snapshot().sessions[0].petHidden, true);
  store.removeSession(SERVER, "s1");
  assert.equal(store.hiddenList().length, 0);
  assert.equal(store.snapshot().sessions.length, 0);
});
