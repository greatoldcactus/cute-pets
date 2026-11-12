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
