// cute-pets brain: attaches to one or more running `opencode serve` instances,
// keeps per-session state, and exposes it to pet faces over HTTP + SSE.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readConfig, writeConfig } from "./config.mjs";
import { PetState, STATE } from "./state.mjs";
import { OpenCodeClient } from "./opencode.mjs";
import { OpenCodeV2Client } from "./opencode-v2.mjs";
import { findOpencodePorts } from "./discover.mjs";
import { startServer } from "./server.mjs";
import { ensureBuiltin } from "./pets.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/global/health", { signal: AbortSignal.timeout(1500) });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(300);
  }
  throw new Error(`server did not start: ${url}`);
}
const LOG_FILE = path.join(os.homedir(), ".cute-pets", "brain.log");
const HIDDEN_FILE = path.join(os.homedir(), ".cute-pets", "hidden.json");
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
};

function parseArgs(argv) {
  const out = { port: 4280, host: "127.0.0.1", servers: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--server") out.servers.push({ url: argv[++i], password: null });
    else if (a === "--password") {
      const pw = argv[++i];
      const last = out.servers[out.servers.length - 1];
      if (last) last.password = pw;
      else out.password = pw;
    }
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

class Hub {
  constructor(store) {
    this.store = store;
    this.clients = new Map();
    this.credentials = new Map(); // url -> password (never exposed in snapshots)
    this.permissionTimer = null;
    // Sessions the pet should not show. Local only: nothing is deleted in OpenCode.
    try {
      const raw = JSON.parse(fs.readFileSync(HIDDEN_FILE, "utf8"));
      store.loadHidden(Array.isArray(raw) ? raw : raw?.hidden);
    } catch {}
  }

  #saveHidden() {
    try {
      fs.mkdirSync(path.dirname(HIDDEN_FILE), { recursive: true });
      fs.writeFileSync(HIDDEN_FILE, JSON.stringify(this.store.hiddenList(), null, 2));
    } catch (e) {
      log("could not write hidden.json:", e.message);
    }
  }

  setHidden({ server, sessionId, hidden = true }) {
    if (!sessionId) throw new Error("sessionId required");
    if (hidden) {
      const url = server || this.pickServer(null);
      this.store.hideSession(url, sessionId);
    } else {
      this.store.unhideSession(sessionId);
    }
    this.#saveHidden();
    this.store.touch(); // push a fresh snapshot to every face
    return { ok: true, hidden: this.store.hiddenList().length };
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

  async attach(url, { directory = null, password = null } = {}) {
    const clean = String(url).replace(/\/+$/, "");
    const existing = this.clients.get(clean);
    if (existing) {
      if (!existing.client.online) this.#restartStream(clean);
      return existing.client;
    }

    // v1 or v2? Probe /global/health first, then /api/info with credentials.
    const creds = password || this.credentials.get(clean) || null;
    let client = new OpenCodeClient(clean, { directory });
    let health;
    try {
      health = await client.health();
    } catch (v1err) {
      client = new OpenCodeV2Client(clean, { directory, password: creds });
      try {
        health = await client.health();
        log(`attached ${clean} as OpenCode ${health?.version ?? "2"}`);
      } catch (v2err) {
        // Never register a dead URL: a plugin may announce its configured default
        // instead of the port the server actually picked.
        log(`attach failed ${clean}: ${v1err.message ?? v1err}`);
        return null;
      }
    }
    client.online = true;
    let workdir = directory;
    try {
      workdir = (await client.get("/path"))?.directory ?? directory;
    } catch {}
    this.store.addServer(clean, { directory: workdir });
    this.store.setServerOnline(clean, true);
    const entry = { client, controller: null, attempts: 0, workdir, password: creds };
    this.clients.set(clean, entry);
    log(`attached ${clean} (opencode ${health?.version ?? "?"})`);
    try {
      if (creds) this.credentials.set(clean, creds);
      const cfg = readConfig();
      const list = (cfg.servers ?? []).filter((e) => (typeof e === "string" ? e : e.url) !== clean);
      list.push(creds ? { url: clean, password: creds } : clean);
      writeConfig({ servers: list });
    } catch {}
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
    const srv = this.store.servers.get(url);
    if (srv) srv.lastEventAt = Date.now();
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

  // Sessions live inside a server that is bound to one directory. A new chat in
  // another folder therefore needs its own `opencode serve` there.
  async ensureWorkspace(directory) {
    const raw = String(directory);
    if (process.platform === "win32" && raw.startsWith("/")) {
      throw new Error(
        `"${raw}" is a Linux path. Start the server inside WSL and attach it instead: ` +
        `opencode serve --hostname 0.0.0.0 --port 4096, then POST /api/attach {"url":"http://localhost:4096"}`,
      );
    }
    const dir = path.resolve(raw);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(`not a directory: ${dir}`);
    }
    const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
    const want = norm(dir);
    for (const [url, entry] of this.clients) {
      if (entry.workdir && norm(entry.workdir) === want) {
        return { server: url, directory: dir, reused: true };
      }
    }
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn("opencode", ["serve", "--port", String(port)], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
    log(`spawned opencode serve for ${dir} on ${port}`);
    await waitForHealth(url);
    await this.attach(url, { directory: dir });
    return { server: url, directory: dir, spawned: true };
  }

  workspaces() {
    const byDir = new Map();
    for (const rec of this.store.sessions.values()) {
      if (!rec.directory) continue;
      const dir = rec.directory;
      const entry = byDir.get(dir) ?? { directory: dir, dirName: dir.split(/[\\/]/).filter(Boolean).pop(), sessions: 0, server: rec.server };
      entry.sessions += 1;
      byDir.set(dir, entry);
    }
    return [...byDir.values()].sort((a, b) => b.sessions - a.sessions);
  }

  async models({ server }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry) return { models: [], default: {} };
    const cfg = await entry.client.models();
    if (Array.isArray(cfg?.flat)) return { models: cfg.flat, default: cfg.default ?? {} };
    const out = [];
    for (const provider of cfg?.providers ?? []) {
      for (const modelID of Object.keys(provider.models ?? {})) {
        const info = provider.models[modelID] ?? {};
        out.push({
          providerID: provider.id,
          id: modelID,
          name: info.name ?? modelID,
          free: /free/i.test(modelID),
          default: cfg?.default?.[provider.id] === modelID,
        });
      }
    }
    out.sort((a, b) => Number(b.default) - Number(a.default) || a.providerID.localeCompare(b.providerID) || a.id.localeCompare(b.id));
    return { models: out, default: cfg?.default ?? {} };
  }

  async agents({ server }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry) return [];
    const agents = await entry.client.agents();
    return (agents ?? []).map((a) => ({ name: a.name, mode: a.mode, description: a.description ?? "" }));
  }

  async sessionAction({ server, sessionId, action, value }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry || !sessionId) throw new Error("server and sessionId required");
    const client = entry.client;
    const rec = this.store.sessions.get(`${url}::${sessionId}`);
    const refresh = async () => {
      try { this.store.upsertSession(url, await client.get(`/session/${sessionId}`)); } catch {}
    };

    switch (action) {
      case "model":
        if (!value?.id || !value?.providerID) throw new Error("model id and providerID required");
        await client.setModel(sessionId, { id: value.id, providerID: value.providerID, variant: value.variant ?? "default" });
        await refresh();
        return { ok: true, model: value };
      case "agent":
        if (!value) throw new Error("agent required");
        await client.setAgent(sessionId, value);
        await refresh();
        return { ok: true, agent: value };
      case "compact": {
        const model = rec?.model;
        if (!model?.id || !model?.providerID) throw new Error("session has no model to summarize with");
        await client.summarize(sessionId, model.providerID, model.id);
        return { ok: true };
      }
      case "share": {
        const out = await client.share(sessionId);
        return { ok: true, url: out?.share?.url ?? null };
      }
      case "unshare":
        await client.unshare(sessionId);
        return { ok: true };
      case "undo": {
        const msgs = await client.messages(sessionId, 50);
        const lastUser = [...(msgs ?? [])].reverse().find((m) => m.info?.role === "user");
        if (!lastUser) throw new Error("nothing to undo");
        await client.revert(sessionId, lastUser.info.id);
        return { ok: true, reverted: lastUser.info.id };
      }
      case "redo":
        await client.unrevert(sessionId);
        return { ok: true };
      default:
        throw new Error(`unknown action: ${action}`);
    }
  }

  async commands({ server }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry) return [];
    return entry.client.commands();
  }

  async prompt({ server, sessionId, newSession, title, text, command, directory }) {
    // A new chat in an explicit folder must land in THAT folder's server, not the
    // default one. ensureWorkspace reuses an attached server for the directory or
    // spawns one (and refuses Linux paths on Windows).
    let url = null;
    if (!sessionId && !server && directory) {
      const ws = await this.ensureWorkspace(directory);
      url = ws.server;
    } else {
      url = this.pickServer(server);
    }
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
    if (command) {
      // `/command` blocks until the command finishes; don't hold the face request.
      void client
        .command(id, { command, args: text ?? "" })
        .catch((err) => log(`command ${command} failed: ${err.message ?? err}`));
    } else {
      await client.prompt(id, text);
    }
    return { server: url, sessionId: id };
  }

  // Destructive: removes the session in OpenCode. Not wired to any UI control.
  async closeSession({ server, sessionId }) {
    const url = this.pickServer(server);
    const entry = url && this.clients.get(url);
    if (!entry || !sessionId) throw new Error("server and sessionId required");
    await entry.client.deleteSession(sessionId);
    this.store.removeSession(url, sessionId);
    return { ok: true };
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
    const request = found?.[1];
    await entry.client.replyPermission(request ?? id, reply);
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
  --port <n>        face API port (default 4280)
  --host <addr>     bind address (default 127.0.0.1)
  --server <url>    attach to an opencode server (repeatable; v1 or v2)
  --password <pw>   basic-auth password for OpenCode 2 (use after --server)
`);
  process.exit(0);
}

const store = new PetState();
const hub = new Hub(store);
// Ship a usable pet: install the bundled pack on first run and make it active.
try {
  const builtin = ensureBuiltin();
  if (builtin) log(`built-in pet ready: ${builtin}`);
} catch (e) {
  log("built-in pet unavailable:", e.message);
}
const { port } = await startServer({ port: args.port, host: args.host, store, api: hub });
writeDiscovery(port, args.host);
log(`face API on http://${args.host}:${port}`);

for (const entry of args.servers) await hub.attach(entry.url, { password: entry.password ?? args.password ?? null });
for (const entry of readConfig().servers ?? []) {
  const url = typeof entry === "string" ? entry : entry.url;
  const password = typeof entry === "string" ? null : entry.password ?? null;
  if (url && !args.servers.includes(url)) await hub.attach(url, { password }).catch(() => {});
}
await hub.discover();
setInterval(() => { void hub.discover(); }, 10_000);
log("scanning for opencode servers every 10s");

process.on("SIGINT", async () => {
  await hub.close();
  process.exit(0);
});
