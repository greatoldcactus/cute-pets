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

// Normalize a v2 inbox item whether it came from GET /inbox, the prompt
// response or an enqueued event (where the id/timestamp live beside the item).
function inboxRecord(item, createdAt = null) {
  const id = item?.id ?? item?.inboxID;
  if (!id) return null;
  return {
    id,
    type: item.type ?? "user",
    delivery: item.delivery === "steer" ? "steer" : "queue",
    text: String(item.payload?.text ?? item.text ?? ""),
    createdAt: Number(item.time?.created ?? createdAt ?? item.created) || Date.now(),
  };
}

export class PetState {
  constructor() {
    this.sessions = new Map(); // key -> record
    this.servers = new Map(); // url -> {url, directory, online, lastEventAt, error}
    this.hidden = new Map(); // session id -> {id, server, title, at}; pet-side only, never deletes
    this.permissions = new Map(); // permission id -> [key, request]
    this.forms = new Map(); // form id -> [key, form]
    this.inbox = new Map(); // session key -> Map(inboxID -> queued input)
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
    const isNew = !rec;
    const serverUpdated = Number(info.time?.updated) || 0;
    const serverCreated = Number(info.time?.created) || 0;
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
        busy: false,
        detail: null,
        activity: null,
        tokens: { input: 0, output: 0 },
        cost: 0,
        lastText: "",
        lastAssistantID: null,
        planReady: false,
        createdAt: serverCreated || Date.now(),
        updatedAt: serverUpdated || Date.now(),
      };
      this.sessions.set(key, rec);
    }
    // Creation time is the stable order key for active sessions. A record that
    // was first seen without it may get the real value from a later sync; keep
    // the earlier of the two, since the fallback is "now" and never smaller.
    if (serverCreated) rec.createdAt = Math.min(rec.createdAt || serverCreated, serverCreated);
    if (info.title) rec.title = info.title;
    if (info.directory) rec.directory = info.directory;
    if (info.agent) {
      // Leaving the plan agent means the finished plan is no longer actionable.
      if (rec.agent !== info.agent) rec.planReady = false;
      rec.agent = info.agent;
    }
    if (info.model) rec.model = info.model;
    if (info.tokens) rec.tokens = { input: info.tokens.input ?? 0, output: info.tokens.output ?? 0 };
    if (typeof info.cost === "number") rec.cost = info.cost;
    // v2 sessions carry the timestamps of the last busy/idle transition. Use
    // them on sync/attach so a session that is still working is not reset to
    // idle just because no status event arrived while the brain was away.
    if (info.time) {
      const busy = Number(info.time.busy) || 0;
      const idle = Number(info.time.idle) || 0;
      if (busy || idle) rec.busy = busy > idle;
    }
    // A sync is also the only state source after a brain restart (v2 has no
    // status map), so let a live busy timestamp promote an idle record.
    if (rec.busy && rec.state === STATE.IDLE && !this.hasPending(rec.key)) {
      rec.state = STATE.RUNNING;
    }
    // A periodic sync re-sends the same session metadata. Do not make every idle
    // session look freshly updated: prefer the server's last-update timestamp.
    if (isNew) rec.updatedAt = serverUpdated || Date.now();
    else if (serverUpdated) rec.updatedAt = Math.max(rec.updatedAt || 0, serverUpdated);
    else rec.updatedAt = Date.now();
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
    const prevState = rec.state;
    const prevDetail = rec.detail;
    const prevActivity = rec.activity;
    if (type === "busy") {
      rec.busy = true;
      // A permission/form can still be pending while the turn continues; the
      // pending request is the more useful state.
      rec.state = this.hasPending(rec.key) ? STATE.WAITING : STATE.RUNNING;
      rec.detail = null;
      rec.activity = null;
      rec.planReady = false; // a new turn supersedes the finished plan
    } else if (type === "idle") {
      rec.busy = false;
      rec.state = this.hasPending(rec.key) ? STATE.WAITING : STATE.IDLE;
      rec.detail = null;
      rec.activity = null;
      // A plan turn that reaches idle has a plan to review. Keeping the flag on
      // the record (rather than deriving it in the face from idle+agent) means a
      // bare /plan switch on an old chat does not look like a finished plan.
      if (rec.state === STATE.IDLE && rec.agent === "plan" && prevState !== STATE.IDLE) {
        rec.planReady = true;
      }
    } else if (type === "retry") {
      rec.busy = false;
      rec.state = STATE.ERROR;
      rec.detail = status.action?.label ?? status.message ?? "retrying";
      rec.activity = null;
      rec.planReady = false;
    }
    // A status poll re-sends an unchanged state; only real transitions should
    // move a session to the top of the idle list.
    if (rec.state !== prevState || rec.detail !== prevDetail || rec.activity !== prevActivity) {
      rec.updatedAt = Date.now();
    }
    this.touch();
  }

  setError(server, id, message) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec) return;
    rec.busy = false;
    rec.state = STATE.ERROR;
    rec.detail = message ?? "error";
    rec.activity = null;
    rec.planReady = false;
    rec.updatedAt = Date.now();
    this.touch();
  }

  removeSession(server, id) {
    this.sessions.delete(keyOf(server, id));
    const key = keyOf(server, id);
    this.inbox.delete(key);
    for (const [pid, [k]] of this.permissions) if (k === key) this.permissions.delete(pid);
    for (const [fid, [k]] of this.forms) if (k === key) this.forms.delete(fid);
    this.touch();
  }

  // The server's session list is authoritative. Drop records it no longer
  // lists (deleted sessions were lingering and then failing to load messages).
  reconcileSessions(server, ids) {
    const keep = new Set(ids);
    let changed = false;
    for (const [key, rec] of [...this.sessions]) {
      if (rec.server !== server || keep.has(rec.id)) continue;
      this.sessions.delete(key);
      this.inbox.delete(key);
      for (const [pid, [k]] of this.permissions) if (k === key) this.permissions.delete(pid);
      for (const [fid, [k]] of this.forms) if (k === key) this.forms.delete(fid);
      changed = true;
    }
    if (changed) {
      this.recomputeWaiting();
      this.touch();
    }
  }

  noteAssistantPart(server, id, part) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec || !part) return;
    if (part.type === "text" && typeof part.text === "string") {
      rec.lastText = part.text.slice(-600);
      rec.activity = null; // the answer is visible; the trace no longer needs a preview
      rec.updatedAt = Date.now();
      this.touch();
    }
  }

  noteDelta(server, id, delta) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec || typeof delta !== "string") return;
    rec.lastText = (rec.lastText + delta).slice(-600);
    rec.activity = null;
    rec.updatedAt = Date.now();
    this.touch();
  }

  // A small live summary for the process trace: the latest thought, or the tool
  // that is currently running. Deliberately separate from the message history.
  noteActivity(server, id, activity) {
    const rec = this.sessions.get(keyOf(server, id));
    if (!rec || !activity) return;
    const prev = rec.activity;
    rec.activity = {
      kind: activity.kind || "thinking",
      text: activity.text !== undefined
        ? String(activity.text ?? "").slice(-400)
        : (activity.kind === "thinking" ? (prev?.text ?? "") : ""),
      tool: activity.tool ?? null,
      detail: activity.detail ? String(activity.detail).slice(0, 160) : null,
      status: activity.status ?? null,
      callID: activity.callID ?? null,
      at: Date.now(),
    };
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

  // v2 queues undelivered inputs in the session's durable inbox. Keep them
  // separate from messages: OpenCode does not add them to the history until
  // they are delivered.
  upsertInbox(server, sessionID, item, createdAt = null) {
    const rec = inboxRecord(item, createdAt);
    if (!rec) return null;
    const key = keyOf(server, sessionID);
    let map = this.inbox.get(key);
    if (!map) {
      map = new Map();
      this.inbox.set(key, map);
    }
    // Preserve an id/createdAt already known from an earlier event.
    const prev = map.get(rec.id);
    if (prev) {
      rec.createdAt = prev.createdAt || rec.createdAt;
    }
    map.set(rec.id, rec);
    this.touch();
    return rec;
  }

  replaceInbox(server, sessionID, list) {
    const key = keyOf(server, sessionID);
    const map = new Map();
    for (const item of list ?? []) {
      const rec = inboxRecord(item);
      if (rec) map.set(rec.id, rec);
    }
    if (map.size) this.inbox.set(key, map);
    else this.inbox.delete(key);
    this.touch();
  }

  removeInbox(server, sessionID, inboxID) {
    const key = keyOf(server, sessionID);
    const map = this.inbox.get(key);
    if (!map?.delete(inboxID)) return false;
    if (!map.size) this.inbox.delete(key);
    this.touch();
    return true;
  }

  setInboxDelivery(server, sessionID, inboxID, delivery) {
    const rec = this.inbox.get(keyOf(server, sessionID))?.get(inboxID);
    if (!rec) return false;
    rec.delivery = delivery === "steer" ? "steer" : "queue";
    this.touch();
    return true;
  }

  inboxFor(key) {
    return [...(this.inbox.get(key)?.values() ?? [])]
      .filter((item) => item.type === "user")
      .sort((a, b) => a.createdAt - b.createdAt);
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
      // Answering a form does not end the turn: restore the busy state instead
      // of dropping the session to idle until the next event arrives.
      else if (rec.state === STATE.WAITING) rec.state = rec.busy ? STATE.RUNNING : STATE.IDLE;
    }
    this.touch();
  }

  petSummary(sessions) {
    const counts = { waiting: 0, error: 0, running: 0, idle: 0 };
    for (const s of sessions) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const state = counts.waiting ? "waiting" : counts.error ? "error" : counts.running ? "running" : "idle";
    // The pet has one body: colour/pose follow the most urgent session; within
    // that priority a plan session wins, so plan mode stays visible while other
    // sessions run. (The list order itself is creation-based and stable.)
    const topState = sessions[0]?.state;
    const top = sessions.find((s) => s.state === topState && s.agent === "plan") ?? sessions[0];
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

    // The creation time identifies the session, so a copy that lacks it can take
    // the value from any other copy of the same id.
    const created = new Map();
    for (const rec of this.sessions.values()) {
      const t = Number(rec.createdAt) || 0;
      if (t && (!created.has(rec.id) || t < created.get(rec.id))) created.set(rec.id, t);
    }

    // Queues are keyed per server::session, but the same session is reported by
    // every attached server. Merge by session id so the chosen record does not
    // hide a queue seen on another copy.
    const queues = new Map();
    for (const rec of this.sessions.values()) {
      for (const item of this.inboxFor(rec.key)) {
        let map = queues.get(rec.id);
        if (!map) {
          map = new Map();
          queues.set(rec.id, map);
        }
        map.set(item.id, item);
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
        activity: rec.activity,
        tokens: rec.tokens,
        cost: rec.cost,
        lastText: rec.lastText,
        planReady: Boolean(rec.planReady),
        createdAt: created.get(rec.id) || rec.createdAt || 0,
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
        queued: [...(queues.get(rec.id)?.values() ?? [])]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((q) => ({
            id: q.id,
            text: q.text,
            delivery: q.delivery,
            createdAt: q.createdAt,
          })),
      }))
      // Within a priority, active sessions are ordered by creation time, not by
      // last update: concurrent sessions emit activity every moment, so recency
      // would reshuffle the list (and the bubble stack) several times a second.
      // Idle sessions keep the useful "recent work first" order, which is stable
      // because idle records no longer refresh on a sync.
      .sort((a, b) => (PRIORITY[b.state] - PRIORITY[a.state]) ||
        (a.state === STATE.IDLE
          ? (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)
          : (a.createdAt - b.createdAt) || a.id.localeCompare(b.id)));

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
