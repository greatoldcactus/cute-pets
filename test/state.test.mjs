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
