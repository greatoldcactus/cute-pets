// cute-pets brain: attaches to one or more running `opencode serve` instances,
// keeps per-session state, and exposes it to pet faces over HTTP + SSE.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PetState, STATE } from "./state.mjs";
import { OpenCodeClient } from "./opencode.mjs";
import { findOpencodePorts } from "./discover.mjs";
import { startServer } from "./server.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[cute-pets]", ...a);

function parseArgs(argv) {
  const out = { port: 4280, host: "127.0.0.1", servers: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--server") out.servers.push(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

class Hub {
  constructor(store) {
    this.store = store;
    this.clients = new Map();
    this.permissionTimer = null;
  }

  list() {
    return [...this.clients.values()].filter((c) => c.client.online);
  }

  pickServer(preferred) {
    if (preferred && this.clients.has(preferred)) return preferred;
    const online = this.list();
    if (!online.length) return null;
    return online[0].client.baseUrl;
  }

  async attach(url, { directory = null } = {}) {
    const clean = String(url).replace(/\/+$/, "");
    const existing = this.clients.get(clean);
    if (existing) {
      if (!existing.client.online) this.#restartStream(clean);
      return existing.client;
    }
    const client = new OpenCodeClient(clean, { directory });
    let health;
    try {
      health = await client.health();
    } catch (err) {
      // Never register a dead URL: a plugin may announce its configured default
      // instead of the port the server actually picked.
      log(`attach failed ${clean}: ${err.message ?? err}`);
      return null;
    }
    client.online = true;
    this.store.addServer(clean, { directory });
    this.store.setServerOnline(clean, true);
    const entry = { client, controller: null, attempts: 0 };
    this.clients.set(clean, entry);
    log(`attached ${clean} (opencode ${health?.version ?? "?"})`);
    await this.sync(clean);
    this.#restartStream(clean);
    return client;
  }

  // Attach every live opencode server we can find by its listening port.
  async discover() {
    const ports = await findOpencodePorts();
    const attached = [];
    for (const port of ports) {
      const url = `http://127.0.0.1:${port}`;
      if (this.clients.has(url)) continue;
      if (await this.attach(url)) attached.push(url);
    }
    return { ports, attached };
  }

  #restartStream(url) {
    const entry = this.clients.get(url);
    if (!entry) return;
    if (entry.controller) {
      try { entry.controller.abort(); } catch {}
    }
    entry.controller = new AbortController();
    void this.#streamLoop(url, entry);
  }

  async #streamLoop(url, entry) {
    const signal = entry.controller.signal;
    while (!signal.aborted) {
      try {
        entry.client.online = true;
        this.store.setServerOnline(url, true);
        await entry.client.stream((ev) => this.handleEvent(url, ev), { signal });
      } catch (err) {
        if (signal.aborted) break;
        entry.client.online = false;
        this.store.setServerOnline(url, false, String(err.message ?? err));
      }
      if (signal.aborted) break;
      entry.attempts += 1;
      await sleep(Math.min(entry.attempts * 800, 10000));
      if (signal.aborted) break;
      try {
        await entry.client.health();
        entry.attempts = 0;
        await this.sync(url);
      } catch {
        // stay offline, keep retrying
      }
    }
  }

  async sync(url) {
    const entry = this.clients.get(url);
    if (!entry) return;
    const { client } = entry;
    const [sessions, statuses, permissions] = await Promise.all([
      client.listSessions().catch(() => []),
      client.statuses().catch(() => ({})),
      client.permissions().catch(() => []),
    ]);
    for (const info of sessions ?? []) this.store.upsertSession(url, info);
    for (const info of sessions ?? []) {
      if (statuses?.[info.id]) this.store.setStatus(url, info.id, statuses[info.id]);
    }
    this.store.replacePermissions(url, permissions ?? []);
  }

  #refreshPermissions(url) {
    clearTimeout(this.permissionTimer);
    this.permissionTimer = setTimeout(async () => {
      const entry = this.clients.get(url);
      if (!entry) return;
      const list = await entry.client.permissions().catch(() => null);
      if (list) this.store.replacePermissions(url, list);
    }, 150);
  }

  handleEvent(url, ev) {
    const p = ev?.properties ?? {};
    switch (ev?.type) {
      case "session.created":
      case "session.updated":
        if (p.info) this.store.upsertSession(url, p.info);
        break;
      case "session.deleted":
        if (p.sessionID) this.store.removeSession(url, p.sessionID);
        break;
      case "session.status":
        if (p.sessionID && p.status) this.store.setStatus(url, p.sessionID, p.status);
        break;
      case "session.idle":
        if (p.sessionID) this.store.setStatus(url, p.sessionID, { type: "idle" });
        break;
      case "session.error":
        if (p.sessionID) this.store.setError(url, p.sessionID, p.error?.message ?? p.message ?? "error");
        break;
      case "message.updated":
        if (p.info?.role === "assistant" && p.info?.tokens) {
          this.store.upsertSession(url, { id: p.info.sessionID, tokens: p.info.tokens });
        }
        break;
      case "message.part.updated":
        if (p.part?.sessionID) this.store.noteAssistantPart(url, p.part.sessionID, p.part);
        break;
      case "message.part.delta":
        if (p.sessionID) this.store.noteDelta(url, p.sessionID, p.delta);
        break;
      default:
        if (typeof ev?.type === "string" && ev.type.startsWith("permission.")) {
          if (p.sessionID && ev.type === "permission.replied" && p.requestID) {
            this.store.removePermission(p.requestID);
          }
          this.#refreshPermissions(url);
        }
        break;
    }
  }

  async prompt({ server, sessionId, newSession, title, text }) {
    const url = this.pickServer(server);
    if (!url) throw new Error("no opencode server attached");
    let entry = this.clients.get(url);
    if (!entry || !entry.client.online) {
      await this.attach(url);
      entry = this.clients.get(url);
    }
    const { client } = entry;
    let id = sessionId;
    if (!id || newSession) {
      const sess = await client.createSession(title ? { title } : {});
      id = sess.id;
      this.store.upsertSession(url, sess);
    }
    const rec = this.store.sessions.get(`${url}::${id}`);
    if (rec) {
      rec.state = STATE.RUNNING;
      rec.updatedAt = Date.now();
      this.store.touch();
    }
    await client.prompt(id, text);
    return { server: url, sessionId: id };
  }

  async abort({ server, sessionId }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry || !sessionId) throw new Error("server and sessionId required");
    await entry.client.abort(sessionId);
    return { ok: true };
  }

  async replyPermission({ id, reply }) {
    const found = this.store.permissions.get(id);
    const url = found ? found[0].split("::")[0] : null;
    const entry = url && this.clients.get(url);
    if (!entry) throw new Error("permission not found");
    await entry.client.replyPermission(id, reply);
    this.store.removePermission(id);
    this.#refreshPermissions(url);
    return { ok: true };
  }

  async messages({ server, sessionId, limit = 20 }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry || !sessionId) throw new Error("server and sessionId required");
    const raw = await entry.client.messages(sessionId, limit);
    return (raw ?? []).map((m) => ({
      id: m.info?.id,
      role: m.info?.role ?? "unknown",
      time: m.info?.time?.created ?? null,
      tokens: m.info?.tokens ?? null,
      parts: (m.parts ?? [])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => ({ type: p.type, text: p.text })),
    }));
  }

  async close() {
    for (const entry of this.clients.values()) {
      try { entry.controller?.abort(); } catch {}
    }
  }
}

function writeDiscovery(port, host) {
  try {
    const dir = path.join(os.homedir(), ".cute-pets");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "brain.json"),
      JSON.stringify({ url: `http://${host}:${port}`, pid: process.pid, since: Date.now() }, null, 2),
    );
  } catch (err) {
    log("discovery file write failed:", err.message);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`cute-pets brain
  --port <n>       face API port (default 4280)
  --host <addr>    bind address (default 127.0.0.1)
  --server <url>   attach to an opencode server (repeatable)
`);
  process.exit(0);
}

const store = new PetState();
const hub = new Hub(store);
const { port } = await startServer({ port: args.port, host: args.host, store, api: hub });
writeDiscovery(port, args.host);
log(`face API on http://${args.host}:${port}`);

for (const url of args.servers) await hub.attach(url);
await hub.discover();
setInterval(() => { void hub.discover(); }, 10_000);
log("scanning for opencode servers every 10s");

process.on("SIGINT", async () => {
  await hub.close();
  process.exit(0);
});
