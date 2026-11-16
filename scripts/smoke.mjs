// Hermetic end-to-end smoke test: starts a fake OpenCode 2 server and the brain,
// then drives the same path the pet uses (attach, create a session, prompt, read
// the reply). No real provider, credentials or network access is involved.
//
// It also runs a quota failure through a second fake so the error path is covered.
//
// Usage: node scripts/smoke.mjs
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, message) => { if (!ok) throw new Error(message); };

const children = [];
let stateDir = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(150);
  }
  throw new Error(`${label} did not start (${last})`);
}

async function get(base, route) {
  const res = await fetch(base + route);
  if (!res.ok) throw new Error(`GET ${route} -> ${res.status}`);
  return res.json();
}

async function post(base, route, body) {
  const res = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${route} -> ${res.status} ${json.error ?? ""}`);
  return json;
}

function pipe(child, label) {
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    if (!stream) continue;
    let buf = "";
    stream.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        out.write(`[${label}] ${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
      }
    });
  }
}

async function startFake(port, extra = []) {
  const child = spawn(process.execPath, [
    path.join(HERE, "fake-opencode.mjs"),
    "--port", String(port),
    "--directory", stateDir,
    ...extra,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", (err) => console.error("[fake] spawn failed:", err.message));
  pipe(child, "fake");
  children.push(child);
  await waitFor(`http://127.0.0.1:${port}/api/info`, "fake opencode");
  return child;
}

async function waitForSession(brainUrl, sessionId, { allowError = false } = {}) {
  let rec = null;
  let sawRunning = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(250);
    const state = await get(brainUrl, "/api/state");
    rec = state.sessions.find((s) => s.id === sessionId);
    if (rec?.state === "running") sawRunning = true;
    if (rec?.state === "error") break;
    if (rec && rec.state === "idle" && rec.lastText) break;
  }
  check(rec, "session never appeared in state");
  if (!allowError) check(rec.state !== "error", `session errored: ${rec.detail ?? "unknown error"}`);
  return { rec, sawRunning };
}

try {
  const fakePort = await freePort();
  const brainPort = await freePort();
  const fakeUrl = `http://127.0.0.1:${fakePort}`;
  const brainUrl = `http://127.0.0.1:${brainPort}`;
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "cute-pets-smoke-"));

  await startFake(fakePort);

  const brain = spawn(process.execPath, [
    path.join(ROOT, "src", "main.mjs"),
    "--port", String(brainPort),
    "--server", fakeUrl,
    "--no-discover",
  ], {
    cwd: ROOT,
    env: { ...process.env, CUTE_PETS_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  brain.on("error", (err) => console.error("[brain] spawn failed:", err.message));
  pipe(brain, "brain");
  children.push(brain);
  await waitFor(brainUrl + "/api/health", "brain");

  const health = await get(brainUrl, "/api/health");
  check(health?.ok, `brain not healthy at ${brainUrl}`);

  let state = await get(brainUrl, "/api/state");
  check(state.servers?.length, "no opencode server attached");
  check(state.servers.some((s) => s.online), "attached server is offline");
  console.log("servers:", state.servers.map((s) => `${s.url} ${s.online ? "online" : "offline"}`).join(", "));
  console.log("sessions before:", state.sessions.length);
  check(state.stats && typeof state.stats.sessions === "number", "aggregate stats missing from /api/state");
  console.log("aggregate sessions:", state.stats.sessions);

  // --- happy path ---------------------------------------------------------
  const title = `cute-pets smoke ${new Date().toISOString().slice(11, 19)}`;
  const { server, sessionId } = await post(brainUrl, "/api/prompt", {
    server: fakeUrl,
    newSession: true,
    title,
    text: "Reply with only the word: alive",
  });
  console.log("prompt sent ->", server, sessionId);

  const { rec, sawRunning } = await waitForSession(brainUrl, sessionId);
  check(rec.lastText.toLowerCase().includes("alive"), `unexpected reply: ${JSON.stringify(rec.lastText)}`);
  check(sawRunning, "never observed 'running'");

  const msgs = await get(
    brainUrl,
    `/api/messages?server=${encodeURIComponent(server)}&sessionId=${encodeURIComponent(sessionId)}&limit=5`,
  );
  const assistant = msgs.filter((m) => m.role === "assistant").pop();
  const text = assistant?.parts?.map((p) => p.text).join("") ?? "";
  check(text.toLowerCase().includes("alive"), `assistant message missing: ${JSON.stringify(text)}`);

  console.log("assistant text:", JSON.stringify(text));
  console.log("tokens:", rec.tokens, "state:", rec.state, "title:", rec.title);

  // --- /btw side question -------------------------------------------------
  const beforeBtw = await get(
    brainUrl,
    `/api/messages?server=${encodeURIComponent(server)}&sessionId=${encodeURIComponent(sessionId)}&limit=20`,
  );
  const btw = await post(brainUrl, "/api/session/action", {
    server,
    sessionId,
    action: "btw",
    value: { text: "What changed?" },
  });
  check(btw.text === "A concise side answer.", `unexpected /btw answer: ${JSON.stringify(btw.text)}`);
  const afterBtw = await get(
    brainUrl,
    `/api/messages?server=${encodeURIComponent(server)}&sessionId=${encodeURIComponent(sessionId)}&limit=20`,
  );
  check(afterBtw.length === beforeBtw.length, "/btw appended to the session history");
  console.log("btw:", btw.text);

  // --- plan hand-off ------------------------------------------------------
  // The chat's "implement" strip appears when a plan turn finishes, then
  // switches the session to build and sends the hand-off prompt.
  const plan = await post(brainUrl, "/api/prompt", {
    server: fakeUrl,
    newSession: true,
    title: "cute-pets smoke plan",
    text: "Make a plan",
    agent: "plan",
  });
  const planned = await waitForSession(brainUrl, plan.sessionId);
  check(planned.rec.agent === "plan", `plan session changed agent: ${planned.rec.agent}`);
  check(planned.rec.planReady === true, "a finished plan turn was not marked plan-ready");

  await post(brainUrl, "/api/session/action", {
    server: fakeUrl,
    sessionId: plan.sessionId,
    action: "agent",
    value: "build",
  });
  await post(brainUrl, "/api/prompt", {
    server: fakeUrl,
    sessionId: plan.sessionId,
    newSession: false,
    text: "Implement the plan.",
  });
  const built = await waitForSession(brainUrl, plan.sessionId);
  check(built.rec.agent === "build", `hand-off did not switch to build: ${built.rec.agent}`);
  check(built.rec.planReady === false, "plan-ready flag survived the hand-off");
  console.log("plan hand-off:", plan.sessionId, "->", built.rec.agent);

  // --- plan readiness backfill on attach ---------------------------------
  // A plan that finished before the brain attached has no live busy -> idle
  // transition. The brain reconstructs readiness from the last assistant
  // message's agent, which OpenCode stores.
  const backfillPort = await freePort();
  const backfillUrl = `http://127.0.0.1:${backfillPort}`;
  await startFake(backfillPort);
  const seeded = await post(backfillUrl, "/api/session", {
    title: "cute-pets smoke backfill",
    agent: "plan",
  });
  const seededId = seeded.data.id;
  await post(backfillUrl, `/api/session/${encodeURIComponent(seededId)}/prompt`, {
    text: "Plan the work",
  });
  await sleep(1900); // the fake finishes the turn after 1.5s
  await post(brainUrl, "/api/attach", { url: backfillUrl });
  const backfilled = await waitForSession(brainUrl, seededId);
  check(backfilled.rec.agent === "plan", `backfill session agent: ${backfilled.rec.agent}`);
  check(backfilled.rec.planReady === true, "an idle plan session was not backfilled as plan-ready");
  check(
    backfilled.rec.lastText.toLowerCase().includes("alive"),
    `backfill text missing: ${JSON.stringify(backfilled.rec.lastText)}`,
  );
  console.log("plan backfill:", seededId, "-> planReady");

  // --- fork from a message + edit/revert ---------------------------------
  const parentMsgs = await get(
    brainUrl,
    `/api/messages?server=${encodeURIComponent(fakeUrl)}&sessionId=${encodeURIComponent(plan.sessionId)}&limit=20`,
  );
  const parentUsers = parentMsgs.filter((m) => m.role === "user");
  check(parentUsers.length >= 2, "plan session did not keep both user messages");
  const forkBefore = parentUsers[1];
  const forked = await post(brainUrl, "/api/session/action", {
    server: fakeUrl,
    sessionId: plan.sessionId,
    action: "fork",
    value: { before: forkBefore.id },
  });
  check(forked.sessionId && forked.sessionId !== plan.sessionId, "fork did not return a child");
  const childMsgs = await get(
    brainUrl,
    `/api/messages?server=${encodeURIComponent(fakeUrl)}&sessionId=${encodeURIComponent(forked.sessionId)}&limit=20`,
  );
  const childText = childMsgs
    .filter((m) => m.role === "user")
    .map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""))
    .join("\n");
  check(childText.includes("Make a plan"), `fork lost the earlier prompt: ${JSON.stringify(childText)}`);
  check(!childText.includes("Implement the plan."), "fork copied the message it forked before");
  console.log("fork before:", forkBefore.id.slice(0, 12), "->", forked.sessionId);

  await post(brainUrl, "/api/session/action", {
    server: fakeUrl,
    sessionId: plan.sessionId,
    action: "revert",
    value: { messageID: parentUsers[0].id },
  });
  let revertState = await get(brainUrl, "/api/state");
  let revertRec = revertState.sessions.find((s) => s.id === plan.sessionId);
  check(revertRec?.revert?.messageID === parentUsers[0].id, "revert was not exposed on the session");
  await post(brainUrl, "/api/prompt", {
    server: fakeUrl,
    sessionId: plan.sessionId,
    newSession: false,
    text: "Replacement",
  });
  const replaced = await waitForSession(brainUrl, plan.sessionId);
  check(replaced.rec.revert == null, "the replacement prompt did not commit the staged revert");
  console.log("edit revert committed:", plan.sessionId);

  // --- hide from pet keeps the session in the list -----------------------
  await post(brainUrl, "/api/session/hide", {
    server: fakeUrl,
    sessionId: plan.sessionId,
    hidden: true,
  });
  let hiddenState = await get(brainUrl, "/api/state");
  let hiddenRec = hiddenState.sessions.find((s) => s.id === plan.sessionId);
  check(hiddenRec?.petHidden === true, "the hidden session disappeared from the session list");
  check(
    hiddenState.pet.total === hiddenState.sessions.filter((s) => !s.petHidden).length,
    "the pet counted a pet-hidden session",
  );
  await post(brainUrl, "/api/session/hide", { sessionId: plan.sessionId, hidden: false });
  hiddenState = await get(brainUrl, "/api/state");
  hiddenRec = hiddenState.sessions.find((s) => s.id === plan.sessionId);
  check(hiddenRec?.petHidden === false, "unhide did not clear petHidden");
  console.log("pet hide/unhide:", plan.sessionId);

  // --- quota failure ------------------------------------------------------
  const failPort = await freePort();
  const failUrl = `http://127.0.0.1:${failPort}`;
  await startFake(failPort, ["--fail", "quota"]);
  await post(brainUrl, "/api/attach", { url: failUrl });

  const failed = await post(brainUrl, "/api/prompt", {
    server: failUrl,
    newSession: true,
    title: "cute-pets smoke quota",
    text: "Reply with only the word: alive",
  });
  const failure = await waitForSession(brainUrl, failed.sessionId, { allowError: true });
  check(failure.rec.state === "error", `expected an error, got ${failure.rec.state}`);
  check(
    String(failure.rec.detail ?? "").includes("Insufficient balance"),
    `error detail lost: ${JSON.stringify(failure.rec.detail)}`,
  );

  const failMsgs = await get(
    brainUrl,
    `/api/messages?server=${encodeURIComponent(failUrl)}&sessionId=${encodeURIComponent(failed.sessionId)}&limit=5`,
  );
  const failError = failMsgs.filter((m) => m.role === "assistant").pop()?.error;
  check(failError?.type === "provider.quota", `unexpected error type: ${JSON.stringify(failError)}`);
  console.log("quota error:", `${failError.type} · ${failError.message}`);

  console.log("PASS");
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  for (const child of children) {
    if (!child || child.exitCode != null) continue;
    try { child.kill("SIGINT"); } catch {}
  }
  await sleep(300);
  for (const child of children) {
    if (!child || child.exitCode != null) continue;
    try { child.kill("SIGKILL"); } catch {}
  }
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
}
