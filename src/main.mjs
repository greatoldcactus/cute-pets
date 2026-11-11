// cute-pets brain: attaches to one or more running `opencode serve` instances,
// keeps per-session state, and exposes it to pet faces over HTTP + SSE.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
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

// ---- directories ---------------------------------------------------------
// v2 sessions can be created/moved at any directory the server's host can see;
// the server itself does not stat the path up front. Validate on the brain host
// (or through its WSL UNC mount) so /cd fails before a turn is started.
function isRemoteUrl(url) {
  try {
    const host = new URL(url).hostname;
    return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

function normalizeDir(dir, entry) {
  let value = String(dir || "").trim();
  if (!value) throw new Error("directory required");
  const home = entry?.workdir || os.homedir();
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = home.replace(/[\\/]+$/, "") + value.slice(1);
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) throw new Error(`use an absolute path: ${value}`);
  value = /^[a-zA-Z]:[\\/]/.test(value) ? path.win32.normalize(value) : path.posix.normalize(value);
  return value;
}

function hostPath(dir, entry) {
  if (entry?.distro) {
    // a WSL server only understands POSIX paths; map them through its UNC share
    return dir.startsWith("/") ? `//wsl.localhost/${entry.distro}${dir}` : null;
  }
  if (process.platform === "win32" && dir.startsWith("/")) return null; // local Windows server
  return dir;
}

function modelRef(model) {
  if (!model) return null;
  return { id: model.id, providerID: model.providerID, variant: model.variant ?? "default" };
}
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

// WSL publishes its managed OpenCode 2 service - url and password - in
// ~/.local/state/opencode/service.json. WSL2 forwards localhost, so the brain can attach
// to it from Windows without the user copying a credential around.
function wslServices() {
  if (process.platform !== "win32") return [];
  let distros = [];
  const exe = ["wsl.exe", "C:\\Windows\\System32\\wsl.exe"];
  for (const bin of exe) {
    try {
      distros = execFileSync(bin, ["-l", "-q"], { encoding: "utf8" })
        .split(/\r?\n/).map((s) => s.replace(/\0/g, "").trim()).filter(Boolean);
      break;
    } catch (e) {
      if (process.env.CUTE_PETS_WSL_DEBUG) log(`wsl ${bin}: ${e.message}`);
    }
  }
  if (!distros.length) return [];
  const found = [];
  let scanned = 0, errs = [];
  for (const distro of distros) {
    const root = `//wsl.localhost/${distro}/home`;
    let homes = [];
    try { homes = fs.readdirSync(root); } catch (e) { errs.push(distro + ":" + e.code); continue; }
    for (const home of homes) {
      const file = path.join(root, home, ".local", "state", "opencode", "service.json");
      try {
        const meta = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!meta?.url || !meta?.password) continue;
        const port = Number(String(meta.url).replace(/\/$/, "").split(":").pop());
        if (!port) continue;
        found.push({ url: `http://localhost:${port}`, password: meta.password, distro });
      } catch (e) { errs.push(home + ":" + e.code); }
      scanned++;
    }
  }
  if (process.env.CUTE_PETS_WSL_DEBUG) log(`wsl scan: distros=${distros.length} scanned=${scanned} found=${found.length} errs=${errs.join(",")}`);
  return found;
}

class Hub {
  constructor(store) {
    this.store = store;
    this.clients = new Map();
    this.credentials = new Map(); // url -> password (never exposed in snapshots)
    this.permissionTimer = null;
    this.wslTried = new Map(); // url -> last attach attempt, so a dead WSL service is not retried every tick
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

  async attach(url, { directory = null, password = null, distro = null } = {}) {
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
    const entry = { client, controller: null, attempts: 0, workdir, password: creds, distro };
    this.clients.set(clean, entry);
    log(`attached ${clean} (opencode ${health?.version ?? "?"})`);
    try {
      if (creds) this.credentials.set(clean, creds);
      const cfg = readConfig();
      const list = (cfg.servers ?? []).filter((e) => (typeof e === "string" ? e : e.url) !== clean);
      list.push(creds ? { url: clean, password: creds, ...(distro ? { distro } : {}) } : clean);
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

    // OpenCode 2 inside WSL: its managed service file carries the credential, so v2
    // needs no manual attach. Retried at most once a minute per URL.
    let wsl = [];
    try { wsl = wslServices(); } catch (e) { log("wsl scan failed:", e.message); }
    if (wsl.length && !this.wslLogged) { this.wslLogged = true; log(`WSL services found: ${wsl.map((w) => w.url).join(", ")}`); }
    for (const entry of wsl) {
      const existing = this.clients.get(entry.url);
      if (existing) {
        if (!existing.distro && entry.distro) existing.distro = entry.distro;
        continue;
      }
      const last = this.wslTried.get(entry.url) ?? 0;
      if (Date.now() - last < 60_000) continue;
      this.wslTried.set(entry.url, Date.now());
      try {
        const client = await this.attach(entry.url, { password: entry.password, distro: entry.distro });
        if (client) {
          attached.push(entry.url);
          log(`attached WSL service ${entry.url} (${entry.distro})`);
        }
      } catch (e) {
        log(`WSL service ${entry.url} not reachable: ${e.message}`);
      }
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

  // Resolve a user-supplied directory on the brain host (or its WSL mount) and
  // return the absolute path. Remote servers cannot be checked locally, so their
  // paths are passed through.
  hostDirectory(directory, entry) {
    const dir = normalizeDir(directory, entry);
    if (isRemoteUrl(entry.client.baseUrl)) return dir;
    const hp = hostPath(dir, entry);
    if (!hp) throw new Error(`"${dir}" is a Linux path; attach the WSL server that owns it`);
    if (!fs.existsSync(hp) || !fs.statSync(hp).isDirectory()) throw new Error(`not a directory: ${dir}`);
    return dir;
  }

  defaults() {
    const cfg = readConfig();
    const first = this.list()[0];
    return {
      directory: cfg.lastDirectory || first?.workdir || os.homedir(),
      server: first?.client.baseUrl ?? null,
      model: cfg.lastModel ?? null,
      agent: cfg.lastAgent ?? null,
    };
  }

  // Validate a directory before a draft starts or a session moves. v2 only: v1
  // servers are bound to one cwd and need a server per directory.
  checkdir({ directory, server } = {}) {
    if (!directory) throw new Error("directory required");
    const candidates = [];
    if (server && this.clients.has(server)) candidates.push(server);
    for (const entry of this.list()) if (!candidates.includes(entry.client.baseUrl)) candidates.push(entry.client.baseUrl);
    let lastError = null;
    for (const url of candidates) {
      const entry = this.clients.get(url);
      if (!entry?.client.online || entry.client.version !== "2") continue;
      try {
        return { ok: true, directory: this.hostDirectory(directory, entry), server: url, wsl: Boolean(entry.distro) };
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw lastError;
    throw new Error("no OpenCode 2 server attached");
  }

  // Pick the server a new session at `directory` belongs to. For v2 any attached
  // server can host a location; prefer the one the face was using, then the rest.
  // v1 falls back to the old server-per-directory spawn.
  async resolveDirectory(directory, preferred) {
    const dir = String(directory || "").trim();
    if (!dir) return null;
    const candidates = [];
    const push = (url) => {
      if (url && this.clients.has(url) && !candidates.includes(url)) candidates.push(url);
    };
    push(preferred);
    for (const entry of this.list()) push(entry.client.baseUrl);
    let lastError = null;
    let sawV2 = false;
    for (const url of candidates) {
      const entry = this.clients.get(url);
      if (!entry?.client.online || entry.client.version !== "2") continue;
      sawV2 = true;
      try {
        return { server: url, directory: this.hostDirectory(dir, entry) };
      } catch (err) {
        lastError = err;
      }
    }
    if (sawV2) throw lastError || new Error(`no OpenCode 2 server can use ${dir}`);
    return await this.ensureWorkspace(dir);
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
      try {
        const info = typeof client.getSession === "function"
          ? await client.getSession(sessionId)
          : await client.get(`/session/${sessionId}`);
        if (info) this.store.upsertSession(url, info);
      } catch {}
    };

    switch (action) {
      case "model": {
        if (!value?.id || !value?.providerID) throw new Error("model id and providerID required");
        const ref = modelRef(value);
        await client.setModel(sessionId, ref);
        await refresh();
        writeConfig({ lastModel: ref });
        return { ok: true, model: ref };
      }
      case "agent":
        if (!value) throw new Error("agent required");
        await client.setAgent(sessionId, value);
        await refresh();
        writeConfig({ lastAgent: value });
        return { ok: true, agent: value };
      case "move": {
        if (!value?.directory) throw new Error("directory required");
        if (typeof client.moveSession !== "function") throw new Error("moving sessions needs OpenCode 2");
        const dir = this.hostDirectory(value.directory, entry);
        await client.moveSession(sessionId, dir);
        await refresh();
        writeConfig({ lastDirectory: dir });
        const session = this.store.snapshot().sessions.find((s) => s.id === sessionId) ?? null;
        return { ok: true, directory: dir, session };
      }
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
      case "fork": {
        const out = await client.forkSession(sessionId);
        const info = out?.data ?? out;
        if (!info?.id) throw new Error("fork returned no session");
        // v2 titles forks itself ("… (fork #N)"); if a server does not, keep the
        // pet readable and avoid "(untitled)" for the child session.
        let title = info.title || "";
        if (!title) {
          title = `${rec?.title || "session"} (fork)`;
          try { await client.setTitle(info.id, title); } catch {}
          info.title = title;
        }
        this.store.upsertSession(url, info);
        const session = this.store.snapshot().sessions.find((s) => s.id === info.id) ?? null;
        return { ok: true, sessionId: info.id, title, session };
      }
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

  async prompt({ server, sessionId, newSession, title, text, command, directory, model, agent }) {
    // A new chat with an explicit directory: v2 servers host any location, so use
    // one of them instead of spawning a server per folder. v1 falls back to the
    // old server-per-directory behaviour inside resolveDirectory.
    let url = null;
    let dir = null;
    if (!sessionId && directory) {
      const loc = await this.resolveDirectory(directory, server);
      url = loc.server;
      dir = loc.directory;
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
      const opts = {};
      if (title) opts.title = title;
      if (agent) opts.agent = agent;
      if (model) opts.model = modelRef(model);
      if (dir && client.version === "2") opts.location = { directory: dir };
      const sess = await client.createSession(opts);
      id = sess.id;
      this.store.upsertSession(url, sess);
      const lastDirectory = dir || sess.directory || readConfig().lastDirectory;
      if (lastDirectory) {
        const patch = { lastDirectory };
        if (model) patch.lastModel = modelRef(model);
        if (agent) patch.lastAgent = agent;
        writeConfig(patch);
      }
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
    const session = this.store.snapshot().sessions.find((s) => s.id === id) ?? null;
    return { server: url, sessionId: id, session };
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
    // The clients normalize text, reasoning, tool and file parts; the face decides
    // which of them to show collapsed (tool calls, thinking, errors).
    return (raw ?? []).map((m) => ({
      id: m.info?.id,
      role: m.info?.role ?? "unknown",
      time: m.info?.time?.created ?? null,
      tokens: m.info?.tokens ?? null,
      error: m.info?.error ?? null,
      parts: m.parts ?? [],
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
  const distro = typeof entry === "string" ? null : entry.distro ?? null;
  if (url && !args.servers.includes(url)) await hub.attach(url, { password, distro }).catch(() => {});
}
await hub.discover();
setInterval(() => { void hub.discover(); }, 10_000);
// Titles (forks, generated names) and metadata can change without an event we
// translate; a cheap refresh keeps the pet from showing stale "(untitled)" rows.
setInterval(() => {
  for (const entry of hub.list()) void hub.sync(entry.client.baseUrl).catch(() => {});
}, 30_000);
log("scanning for opencode servers every 10s");

process.on("SIGINT", async () => {
  await hub.close();
  process.exit(0);
});
