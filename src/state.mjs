// Session/pet state derived from OpenCode events.
// Event names verified against opencode 1.18.7: session.status, session.idle,
// session.updated, session.created, session.deleted, session.error,
// message.updated, message.part.delta, permission.asked, permission.replied.

export const STATE = {
  IDLE: "idle",
  RUNNING: "running",
  WAITING: "waiting",
  ERROR: "error",
};

const PRIORITY = { waiting: 3, error: 2, running: 1, idle: 0 };
const KIND_OF_STATE = { waiting: "waiting", error: "error", running: "working", idle: "idle" };

export const keyOf = (server, id) => `${server}::${id}`;

export class PetState {
  constructor() {
    this.sessions = new Map(); // key -> record
    this.servers = new Map(); // url -> {url, directory, online, lastEventAt, error}
    this.hidden = new Map(); // session id -> {id, server, title, at}; pet-side only, never deletes
    this.permissions = new Map(); // permission id -> [key, request]
    this.forms = new Map(); // form id -> [key, form]
    this.listeners = new Set();
    this.timer = null;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const snap = this.snapshot();
      for (const fn of this.listeners) {
        try { fn(snap); } catch {}
      }
    }, 120);
  }

  addServer(url, { directory = null } = {}) {
    const clean = String(url).replace(/\/+$/, "");
    let s = this.servers.get(clean);
    if (!s) {
      s = { url: clean, directory, online: false, lastEventAt: 0, error: null };
      this.servers.set(clean, s);
    }
    if (directory && !s.directory) s.directory = directory;
    return s;
  }

  setServerOnline(url, online, error = null) {
    const s = this.servers.get(String(url).replace(/\/+$/, ""));
    if (!s) return;
    s.online = online;
    s.error = error;
    this.touch();
  }

  upsertSession(server, info) {
    if (!info?.id) return null;
    const key = keyOf(server, info.id);
    let rec = this.sessions.get(key);
    if (!rec) {
      rec = {
        key,
        server,
        id: info.id,
        title: "",
        slug: info.slug ?? "",
        directory: info.directory ?? null,
        agent: null,
        model: null,
        state: STATE.IDLE,
        detail: null,
        tokens: { input: 0, output: 0 },
        cost: 0,
        lastText: "",
        lastAssistantID: null,
        updatedAt: Date.now(),
      };
      this.sessions.set(key, rec);
    }
    if (info.title) rec.title = info.title;
    if (info.directory) rec.directory = info.directory;
    if (info.agent) rec.agent = info.agent;
    if (info.model) rec.model = info.model;
    if (info.tokens) rec.tokens = { input: info.tokens.input ?? 0, output: info.tokens.output ?? 0 };
    if (typeof info.cost === "number") rec.cost = info.cost;
    rec.updatedAt = Date.now();
    this.touch();
    return rec;
  }

  setStatus(server, id, status) {
    const rec = this.sessions.get(keyOf(server, id));
    const type = status?.type ?? "idle";
    if (!rec) {
      if (type === "idle") return;
      return this.upsertSession(server, { id }) && this.setStatus(server, id, status);
    }
    if (type === "busy") {
      rec.state = STATE.RUNNING;
      rec.detail = null;
    } else if (type === "idle") {
      rec.state = this.hasPending(rec.key) ? STATE.WAITING : STATE.IDLE;
      rec.detail = null;
    } else if (type === "retry") {
      rec.state = STATE.ERROR;
      rec.detail = status.action?.label ?? status.message ?? "retrying";
    }
    rec.updatedAt = Date.now();
    this.touch();
  }

  setError(server, id, message) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec) return;
    rec.state = STATE.ERROR;
    rec.detail = message ?? "error";
    rec.updatedAt = Date.now();
    this.touch();
  }

  removeSession(server, id) {
    this.sessions.delete(keyOf(server, id));
    const key = keyOf(server, id);
    for (const [pid, [k]] of this.permissions) if (k === key) this.permissions.delete(pid);
    for (const [fid, [k]] of this.forms) if (k === key) this.forms.delete(fid);
    this.touch();
  }

  noteAssistantPart(server, id, part) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec || !part) return;
    if (part.type === "text" && typeof part.text === "string") {
      rec.lastText = part.text.slice(-600);
      rec.updatedAt = Date.now();
      this.touch();
    }
  }

  noteDelta(server, id, delta) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec || typeof delta !== "string") return;
    rec.lastText = (rec.lastText + delta).slice(-600);
    rec.updatedAt = Date.now();
    this.touch();
  }

  replacePermissions(server, list) {
    for (const [pid, [key]] of [...this.permissions]) {
      if (key.startsWith(server + "::")) this.permissions.delete(pid);
    }
    for (const req of list ?? []) {
      if (!req?.id || !req.sessionID) continue;
      this.permissions.set(req.id, [keyOf(server, req.sessionID), req]);
    }
    this.recomputeWaiting();
  }

  removePermission(id) {
    if (!this.permissions.delete(id)) return;
    this.recomputeWaiting();
  }

  pendingFor(key) {
    const out = [];
    for (const [pid, [k, req]] of this.permissions) {
      if (k === key) out.push({ id: pid, ...req });
    }
    return out;
  }

  // v2 forms are questions asked by the agent; they wait for an answer just like
  // permission requests do.
  replaceForms(server, list) {
    for (const [fid, [key]] of [...this.forms]) {
      if (key.startsWith(server + "::")) this.forms.delete(fid);
    }
    for (const form of list ?? []) {
      if (!form?.id || !form.sessionID) continue;
      this.forms.set(form.id, [keyOf(server, form.sessionID), form]);
    }
    this.recomputeWaiting();
  }

  upsertForm(server, form) {
    if (!form?.id || !form.sessionID) return;
    this.forms.set(form.id, [keyOf(server, form.sessionID), form]);
    this.recomputeWaiting();
  }

  removeForm(id) {
    if (!this.forms.delete(id)) return;
    this.recomputeWaiting();
  }

  formsFor(key) {
    const out = [];
    for (const [fid, [k, form]] of this.forms) {
      if (k === key) out.push({ id: fid, ...form });
    }
    return out;
  }

  hasPending(key) {
    if (this.pendingFor(key).length) return true;
    for (const [, [k]] of this.forms) if (k === key) return true;
    return false;
  }

  recomputeWaiting() {
    for (const rec of this.sessions.values()) {
      const pending = this.hasPending(rec.key);
      if (pending) rec.state = STATE.WAITING;
      else if (rec.state === STATE.WAITING) rec.state = STATE.IDLE;
    }
    this.touch();
  }

  petSummary(sessions) {
    const counts = { waiting: 0, error: 0, running: 0, idle: 0 };
    for (const s of sessions) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const state = counts.waiting ? "waiting" : counts.error ? "error" : counts.running ? "running" : "idle";
    // The pet has one body: colour/pose follow the session that drives the rollup
    // (the urgent one, else the most recently updated).
    const top = sessions[0];
    const plan = Boolean(top && top.agent === "plan" && top.state !== "idle");
    const label =
      state === "waiting" ? `${counts.waiting} need${counts.waiting === 1 ? "s" : ""} you`
      : state === "error" ? `${counts.error} failed`
      : state === "running" ? `${counts.running} ${plan ? "planning" : "working"}`
      : sessions.length ? "all done" : "no sessions";
    return {
      state,
      plan,
      kind: plan ? "planning" : KIND_OF_STATE[state],
      label,
      counts,
      total: sessions.length,
    };
  }

  hideSession(server, id) {
    const rec = this.sessions.get(`${server}::${id}`);
    this.hidden.set(id, { id, server, title: rec?.title ?? "", at: Date.now() });
    return this.hidden.get(id);
  }

  unhideSession(id) {
    return this.hidden.delete(id);
  }

  loadHidden(list) {
    for (const h of list ?? []) if (h?.id) this.hidden.set(h.id, { at: Date.now(), ...h });
  }

  hiddenList() {
    return [...this.hidden.values()].sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  snapshot() {
    // Every opencode process over the same data directory reports the same
    // sessions, so collapse duplicates by session id and keep the best record:
    // an online server with live activity beats a stale copy.
    const best = new Map();
    for (const rec of this.sessions.values()) {
      const online = this.servers.get(rec.server)?.online ? 1 : 0;
      const active = rec.state === STATE.IDLE ? 0 : 1;
      const score = online * 2 + active;
      const prev = best.get(rec.id);
      if (!prev || score > prev.score || (score === prev.score && rec.updatedAt > prev.rec.updatedAt)) {
        best.set(rec.id, { rec, score });
      }
    }

    const sessions = [...best.values()]
      .filter(({ rec }) => !this.hidden.has(rec.id))
      .map(({ rec }) => ({
        server: rec.server,
        id: rec.id,
        title: rec.title || "(untitled)",
        slug: rec.slug,
        directory: rec.directory,
        dirName: rec.directory ? rec.directory.split(/[\\/]/).filter(Boolean).pop() : "",
        agent: rec.agent,
        model: rec.model,
        state: rec.state,
        detail: rec.detail,
        tokens: rec.tokens,
        cost: rec.cost,
        lastText: rec.lastText,
        updatedAt: rec.updatedAt,
        pending: this.pendingFor(rec.key).map((p) => ({
          id: p.id,
          permission: p.permission,
          patterns: p.patterns ?? [],
        })),
        forms: this.formsFor(rec.key).map((f) => ({
          id: f.id,
          title: f.title ?? "",
          fields: f.fields ?? [],
          metadata: f.metadata ?? null,
        })),
      }))
      .sort((a, b) => (PRIORITY[b.state] - PRIORITY[a.state]) || (b.updatedAt - a.updatedAt));

    const permissions = [...this.permissions.entries()].map(([id, [key, req]]) => ({
      id,
      key,
      server: req.server ?? key.split("::")[0],
      sessionID: req.sessionID,
      permission: req.permission,
      patterns: req.patterns ?? [],
      metadata: req.metadata ?? {},
      always: req.always ?? [],
      tool: req.tool ?? null,
    }));

    return {
      generatedAt: Date.now(),
      pet: this.petSummary(sessions),
      servers: [...this.servers.values()],
      sessions,
      hidden: this.hiddenList().map((h) => ({
        id: h.id,
        title: h.title || "(hidden)",
        server: h.server ?? null,
      })),
      permissions,
      forms: [...this.forms.entries()].map(([id, [key, form]]) => ({
        id,
        key,
        server: key.split("::")[0],
        sessionID: form.sessionID,
        title: form.title ?? "",
        fields: form.fields ?? [],
        metadata: form.metadata ?? null,
      })),
    };
  }
}
