// End-to-end smoke test: drives the brain API against a live OpenCode server.
// Usage: node scripts/smoke.mjs [brainUrl]
const BRAIN = (process.argv[2] ?? process.env.CUTE_PETS_BRAIN ?? "http://127.0.0.1:4280").replace(/\/+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BRAIN + path);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}
async function post(path, body) {
  const res = await fetch(BRAIN + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${json.error ?? ""}`);
  return json;
}

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

const health = await get("/api/health").catch(() => null);
if (!health?.ok) fail(`brain not reachable at ${BRAIN}`);

let state = await get("/api/state");
if (!state.servers?.length) fail("no opencode server attached");
if (!state.servers.some((s) => s.online)) fail("attached server is offline");
console.log("servers:", state.servers.map((s) => `${s.url} ${s.online ? "online" : "offline"}`).join(", "));
console.log("sessions before:", state.sessions.length);

const title = `cute-pets smoke ${new Date().toISOString().slice(11, 19)}`;
const { server, sessionId } = await post("/api/prompt", {
  newSession: true,
  title,
  text: "Reply with only the word: alive",
});
console.log("prompt sent ->", server, sessionId);

let rec = null;
const deadline = Date.now() + 120_000;
let sawRunning = false;
while (Date.now() < deadline) {
  await sleep(1000);
  state = await get("/api/state");
  rec = state.sessions.find((s) => s.id === sessionId);
  if (rec?.state === "running") sawRunning = true;
  if (rec && (rec.state === "idle" || rec.state === "error") && rec.lastText) break;
}

if (!rec) fail("session never appeared in state");
if (!rec.lastText.toLowerCase().includes("alive")) fail(`unexpected reply: ${JSON.stringify(rec.lastText)}`);
if (!sawRunning) console.log("note: never observed 'running' (fast model, sampling gap)");

const msgs = await get(`/api/messages?server=${encodeURIComponent(server)}&sessionId=${encodeURIComponent(sessionId)}&limit=5`);
const assistant = msgs.filter((m) => m.role === "assistant").pop();
console.log("assistant text:", JSON.stringify(assistant?.parts?.map((p) => p.text).join("")));
console.log("tokens:", rec.tokens, "state:", rec.state, "title:", rec.title);
console.log("PASS");
