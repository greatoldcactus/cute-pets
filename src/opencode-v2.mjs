// OpenCode 2.x client (v2.2.6). Same surface as the v1 client: the brain and the
// faces never see the difference, only normalized shapes.
//
// Differences that matter, all verified against a live v2 server:
//  - HTTP Basic auth, username "opencode", password from OPENCODE_SERVER_PASSWORD
//  - every route lives under /api/*
//  - responses are wrapped in { data } (some also carry { location })
//  - sessions: directory lives in location.directory
//  - messages: parts are called content[]; role comes from type
//  - the server default for prompts is "steer"; this client sends "queue" by
//    default, and the brain asks for "steer" while a turn is running or a
//    synthetic mode reminder is still pending
//  - permissions reply with { action, resources }, not { reply }

const enc = encodeURIComponent;

export class OpenCodeV2Client {
  constructor(baseUrl, { password = null, directory = null } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.password = password;
    this.directory = directory;
    this.online = false;
    this.lastEventAt = 0;
    this.version = "2";
  }

  get authHeader() {
    if (!this.password) return {};
    const token = Buffer.from(`opencode:${this.password}`).toString("base64");
    return { authorization: `Basic ${token}` };
  }

  async #req(path, init = {}) {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...this.authHeader,
        ...(init.headers || {}),
      },
      signal: init.timeout === 0 ? undefined : AbortSignal.timeout(init.timeout ?? 20000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`${init.method || "GET"} ${path} -> ${res.status} ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  get(path) {
    if (path === "/path") return this.location();
    return this.#req(path);
  }
  post(path, body) { return this.#req(path, { method: "POST", body: JSON.stringify(body ?? {}) }); }

  async location() {
    const out = await this.#req("/api/location");
    return out?.data ?? out ?? {};
  }

  health() { return this.#req("/api/info"); }

  static mapSession(s) {
    if (!s) return null;
    return {
      id: s.id,
      slug: s.slug,
      title: s.title,
      directory: s.location?.directory ?? s.directory ?? null,
      agent: s.agent,
      model: s.model,
      tokens: s.tokens,
      cost: s.cost,
      time: s.time
        ? {
            created: s.time.created ?? null,
            updated: s.time.updated ?? null,
            busy: s.time.busy ?? null,
            idle: s.time.idle ?? null,
          }
        : null,
    };
  }

  async listSessions() {
    const out = await this.#req("/api/session");
    return (out?.data ?? []).map(OpenCodeV2Client.mapSession);
  }

  // v2 has no status map; running state is driven by the event stream.
  async statuses() { return {}; }

  async permissions() {
    const out = await this.#req("/api/permission/request");
    return (out?.data ?? []).map((p) => ({
      id: p.id,
      sessionID: p.sessionID ?? p.sessionId,
      permission: p.permission ?? p.tool ?? "permission",
      patterns: p.patterns ?? (p.resources ? [].concat(p.resources) : []),
      resources: p.resources ?? [],
      metadata: p.metadata ?? {},
      always: p.always ?? [],
      tool: p.tool ?? null,
    }));
  }

  // Pending agent questions. v2 scopes these to a location: passing a session's
  // directory returns the forms of every session in it, which is cheaper than one
  // request per session.
  async forms(directory = null) {
    const query = directory ? `?location[directory]=${enc(directory)}` : "";
    const out = await this.#req(`/api/form${query}`);
    return (out?.data ?? []).map((f) => ({
      id: f.id,
      sessionID: f.sessionID,
      title: f.title ?? "",
      fields: f.fields ?? [],
      metadata: f.metadata ?? null,
    }));
  }

  replyForm(sessionId, formId, answer) {
    return this.#req(`/api/session/${enc(sessionId)}/form/${enc(formId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ answer: answer ?? {} }),
    });
  }

  // Durable inputs waiting to be delivered. A plan session is created with, or
  // switched to/from, the plan agent: the plan plugin then enqueues a synthetic
  // mode reminder with delivery "steer" and resume:false. Seeing it lets the
  // brain join its turn with the first prompt instead of queueing behind it.
  async inbox(sessionId) {
    const out = await this.#req(`/api/session/${enc(sessionId)}/inbox`);
    return out?.data ?? [];
  }

  // Cancel an input that has not been delivered yet. OpenCode treats a missing
  // (already delivered) item as a no-op, so callers can always prune locally.
  cancelInbox(sessionId, inboxId) {
    return this.#req(`/api/session/${enc(sessionId)}/inbox/${enc(inboxId)}`, {
      method: "DELETE",
    });
  }

  // Promote a queued input to "steer" so the running turn picks it up at its
  // next step boundary instead of waiting for the turn to finish.
  setInboxDelivery(sessionId, inboxId, delivery) {
    return this.#req(`/api/session/${enc(sessionId)}/inbox/${enc(inboxId)}`, {
      method: "PATCH",
      body: JSON.stringify({ delivery }),
    });
  }

  // Fetch one page of messages. v2 pages with an opaque cursor; pages are
  // returned from oldest to newest so the face can prepend older pages without
  // reversing everything again.
  async messagePage(id, { limit = 20, order = "desc", type = null, cursor = null, compact = false, lookahead = false } = {}) {
    // Ask for one extra message so the caller can tell whether another page
    // actually exists. v2 returns a cursor even on the last page, so cursor
    // presence alone would show a bogus "earlier messages" divider.
    const requestLimit = lookahead ? limit + 1 : limit;
    const qs = new URLSearchParams({ limit: String(requestLimit) });
    if (type) qs.set("type", type);
    if (cursor) qs.set("cursor", cursor);
    else qs.set("order", order === "asc" ? "asc" : "desc");
    const out = await this.#req(`/api/session/${enc(id)}/message?${qs.toString()}`);
    const raw = out?.data ?? [];
    const rows = this.#normalizeRows(raw, { compact });
    rows.sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0));
    const hasMore = lookahead ? raw.length > limit : Boolean(out?.cursor);
    return {
      messages: rows,
      cursor: hasMore ? out?.cursor ?? null : null,
      hasMore,
    };
  }

  async messages(id, limit = 20) {
    const page = await this.messagePage(id, { limit, order: "desc" });
    return page.messages;
  }

  #normalizeRows(rows, { compact = false } = {}) {
    const clip = (s, n) => {
      const text = String(s ?? "");
      return text.length > n ? text.slice(0, n) + "\n…" : text;
    };
    const toolOutput = (st) => {
      let o = st?.content;
      if (Array.isArray(o)) o = o.filter((x) => x?.type === "text" && x.text).map((x) => x.text).join("\n");
      else if (o && typeof o === "object") o = JSON.stringify(o, null, 2);
      if (st?.error) o = [String(st.error), o || ""].filter(Boolean).join("\n\n");
      o = o || "";
      return compact ? clip(o, 4000) : o;
    };
    const partsOf = (m) => {
      const parts = [];
      if (m.type === "user") {
        const text = m.text ?? m.payload?.text;
        if (text) parts.push({ type: "text", text });
        for (const f of m.files ?? []) {
          parts.push({ type: "file", name: f?.name || f?.path || String(f), path: f?.path ?? null });
        }
      } else if (m.type === "assistant") {
        for (const c of m.content ?? []) {
          if (c.type === "text" && c.text) parts.push({ type: "text", text: compact ? clip(c.text, 8000) : c.text });
          else if (c.type === "reasoning" && c.text) parts.push({ type: "reasoning", text: compact ? clip(c.text, 4000) : c.text });
          else if (c.type === "tool") {
            const st = c.state ?? {};
            parts.push({
              type: "tool",
              name: c.name || "tool",
              status: st.status || "unknown",
              input: st.input ?? null,
              output: toolOutput(st),
            });
          }
        }
      }
      return parts;
    };
    return rows.map((m) => ({
      info: {
        id: m.id,
        role: m.type === "user" ? "user" : m.type === "assistant" ? "assistant" : m.type,
        time: { created: m.time?.created ?? null },
        tokens: m.tokens ?? null,
        cost: m.cost ?? null,
        error: m.error ?? null,
      },
      parts: partsOf(m),
    })).filter((m) => m.parts.length || m.info.error);
  }

  getSession(id) {
    return this.#req(`/api/session/${enc(id)}`).then((out) => OpenCodeV2Client.mapSession(out?.data));
  }
  // A fork copies history up to `before` (null = the full history). The response
  // carries the new session, including the "… (fork #N)" title.
  forkSession(id, before = null) {
    return this.#req(`/api/session/${enc(id)}/fork`, { method: "POST", body: JSON.stringify({ before }) })
      .then((out) => OpenCodeV2Client.mapSession(out?.data));
  }
  setTitle(id, title) {
    return this.#req(`/api/session/${enc(id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
  }

  async createSession(body = {}) {
    const payload = {};
    if (body.title) payload.title = body.title;
    if (body.agent) payload.agent = body.agent;
    if (body.model) payload.model = body.model;
    if (body.location) payload.location = body.location;
    const out = await this.#req("/api/session", { method: "POST", body: JSON.stringify(payload) });
    return OpenCodeV2Client.mapSession(out?.data);
  }
  // v2 moves a session between project directories; the server accepts the path
  // and the next tool call resolves it, so the face validates the host path.
  moveSession(id, directory) {
    return this.#req(`/api/session/${enc(id)}/move`, {
      method: "POST",
      body: JSON.stringify({ directory }),
    });
  }

  // v2 prompts are durable inbox items: "queue" waits for the next turn, while
  // "steer" joins a turn that is starting or already running.
  prompt(id, text, extra = {}) {
    return this.#req(`/api/session/${enc(id)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text, delivery: "queue", ...extra }),
      timeout: 30000,
    });
  }

  // Commands run synchronously; don't hold the face request.
  command(id, { command, args = "" }) {
    return this.#req(`/api/session/${enc(id)}/command`, {
      method: "POST",
      body: JSON.stringify({ name: command, arguments: args }),
      timeout: 0,
    });
  }

  abort(id) { return this.#req(`/api/session/${enc(id)}/interrupt`, { method: "POST", body: "{}" }); }
  deleteSession(id) { return this.#req(`/api/session/${enc(id)}`, { method: "DELETE" }); }

  replyPermission(permission, reply) {
    const sessionID = permission?.sessionID;
    if (!sessionID) throw new Error("permission has no sessionID");
    const action = reply === "reject" || reply === "deny" ? "deny" : "allow";
    const resources = permission.resources ?? [];
    return this.#req(`/api/session/${enc(sessionID)}/permission`, {
      method: "POST",
      body: JSON.stringify({ action, resources }),
    }).catch(async (err) => {
      // tolerate a different resource shape without losing the decision
      if (err.status !== 400) throw err;
      return this.#req(`/api/session/${enc(sessionID)}/permission`, {
        method: "POST",
        body: JSON.stringify({ action, resources: [] }),
      });
    });
  }

  async models() {
    const out = await this.#req("/api/model");
    const rows = (out?.data ?? []).map((m) => ({
      providerID: m.providerID,
      id: m.modelID ?? m.id,
      name: m.name ?? m.modelID ?? m.id,
      free: /free/i.test(m.modelID ?? m.id ?? ""),
      default: Boolean(m.default),
      variants: (m.variants ?? []).map((v) => v.id).filter(Boolean),
    }));
    const grouped = {};
    for (const row of rows) grouped[row.providerID] = grouped[row.providerID] ?? row.id;
    return { providers: [], default: grouped, flat: rows };
  }

  async agents() {
    const out = await this.#req("/api/agent");
    return (out?.data ?? []).map((a) => ({
      name: a.id ?? a.name,
      mode: a.mode,
      description: a.description ?? "",
    }));
  }

  async commands() {
    const out = await this.#req("/api/command");
    return out?.data ?? [];
  }

  setModel(id, ref) { return this.post(`/api/session/${enc(id)}/model`, { model: ref }); }
  setAgent(id, agent) { return this.post(`/api/session/${enc(id)}/agent`, { agent }); }
  summarize() { throw new Error("summarize is not implemented for OpenCode 2"); }
  share() { throw new Error("share is not implemented for OpenCode 2"); }
  unshare() { throw new Error("share is not implemented for OpenCode 2"); }
  revert() { throw new Error("revert is not implemented for OpenCode 2"); }
  unrevert() { throw new Error("unrevert is not implemented for OpenCode 2"); }

  // Translate v2 events into the v1 event names the brain already understands.
  async stream(onEvent, { signal } = {}) {
    const res = await fetch(this.baseUrl + "/api/event", {
      headers: { accept: "text/event-stream", ...this.authHeader },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`event stream -> ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";

    // Live "what is happening" state, kept out of the message store: reasoning
    // deltas can be very frequent, so the preview is throttled; tool events are
    // emitted as they arrive.
    const toolNames = new Map(); // call id -> tool name
    const reasoningText = new Map(); // session id -> rolling tail
    const reasoningAt = new Map();
    const clip = (s, n) => {
      const text = String(s ?? "").replace(/\s+/g, " ").trim();
      return text.length > n ? text.slice(0, n) + "…" : text;
    };
    const toolHint = (input) => {
      if (input == null) return "";
      if (typeof input === "string") return clip(input, 120);
      if (typeof input === "object") {
        for (const key of ["command", "filePath", "path", "pattern", "query", "description", "url", "prompt"]) {
          if (typeof input[key] === "string" && input[key]) return clip(input[key], 120);
        }
      }
      try { return clip(JSON.stringify(input), 120); } catch { return ""; }
    };
    const activity = (sessionID, value) =>
      onEvent({ type: "session.activity", properties: { sessionID, activity: value } });

    const emit = (wrapper) => {
      const d = wrapper.data ?? {};
      const sid = d.sessionID;
      switch (wrapper.type) {
        case "session.created":
          return onEvent({ type: "session.created", properties: { info: OpenCodeV2Client.mapSession(d) } });
        case "session.deleted":
          return onEvent({ type: "session.deleted", properties: { sessionID: sid } });
        // v2 announces a fork with only its id and parent, not its info. Fetch the
        // session so its title ("… (fork #N)") reaches the pet immediately instead
        // of waiting for a full sync (the store used to show it as "(untitled)").
        case "session.forked": {
          const id = d.sessionID;
          if (id) {
            void this.getSession(id)
              .then((info) => { if (info) onEvent({ type: "session.created", properties: { info } }); })
              .catch(() => {});
          }
          return;
        }
        case "session.renamed":
          return onEvent({ type: "session.updated", properties: { info: { id: sid, title: d.title } } });
        case "session.usage.updated":
          return onEvent({ type: "session.updated", properties: { info: { id: sid, cost: d.cost, tokens: d.tokens } } });
        case "session.execution.started":
        case "session.step.started":
          return onEvent({ type: "session.status", properties: { sessionID: sid, status: { type: "busy" } } });
        case "session.execution.succeeded":
        case "session.execution.interrupted":
        case "session.idle":
          return onEvent({ type: "session.idle", properties: { sessionID: sid } });
        case "session.execution.failed":
          return onEvent({
            type: "session.error",
            properties: {
              sessionID: sid,
              error: d.error && typeof d.error === "object"
                ? d.error
                : { message: d.error ?? d.message ?? "execution failed" },
            },
          });
        case "session.reasoning.started":
          reasoningText.set(sid, "");
          return activity(sid, { kind: "thinking", text: "", status: "started" });
        case "session.reasoning.delta": {
          const text = (reasoningText.get(sid) ?? "") + (d.delta ?? "");
          const tail = text.slice(-400);
          reasoningText.set(sid, tail);
          const now = Date.now();
          if (now - (reasoningAt.get(sid) ?? 0) < 250) return;
          reasoningAt.set(sid, now);
          return activity(sid, { kind: "thinking", text: tail, status: "streaming" });
        }
        case "session.reasoning.ended": {
          const tail = String(d.text ?? reasoningText.get(sid) ?? "").slice(-400);
          reasoningText.set(sid, tail);
          reasoningAt.delete(sid);
          return activity(sid, { kind: "thinking", text: tail, status: "completed" });
        }
        case "session.tool.input.started":
          if (d.id) toolNames.set(d.id, d.name || "tool");
          return activity(sid, { kind: "tool", tool: d.name || "tool", status: "input", callID: d.id ?? null });
        case "session.tool.called": {
          const name = toolNames.get(d.id) || "tool";
          return activity(sid, { kind: "tool", tool: name, status: "running", detail: toolHint(d.input), callID: d.id ?? null });
        }
        case "session.tool.success": {
          const name = toolNames.get(d.id) || "tool";
          if (d.id) toolNames.delete(d.id);
          return activity(sid, { kind: "tool", tool: name, status: "completed", callID: d.id ?? null });
        }
        case "session.tool.failed":
        case "session.tool.error":
        case "session.tool.cancelled": {
          const name = toolNames.get(d.id) || "tool";
          if (d.id) toolNames.delete(d.id);
          return activity(sid, { kind: "tool", tool: name, status: "error", callID: d.id ?? null });
        }
        case "session.text.delta":
          return onEvent({ type: "message.part.delta", properties: { sessionID: sid, delta: d.delta ?? "" } });
        case "session.text.ended":
          return onEvent({ type: "message.part.updated", properties: { part: { sessionID: sid, type: "text", text: d.text ?? "" } } });
        case "session.status":
          return onEvent({ type: "session.status", properties: { sessionID: sid, status: d.status ?? { type: "idle" } } });
        case "form.created":
          return onEvent({ type: "form.created", properties: { form: d.form } });
        case "form.replied":
        case "form.cancelled":
          return onEvent({ type: wrapper.type, properties: { id: d.id, sessionID: d.sessionID } });
        // Durable queue items. The brain keeps these out of the message history
        // until OpenCode delivers them, and the face shows a queue strip.
        case "session.inbox.enqueued":
          return onEvent({
            type: "session.inbox.enqueued",
            properties: {
              sessionID: sid,
              inboxID: d.inboxID,
              item: d.item ?? {},
              created: wrapper.created ?? Date.now(),
            },
          });
        case "session.inbox.delivered":
        case "session.inbox.cancelled":
          return onEvent({ type: wrapper.type, properties: { sessionID: sid, inboxID: d.inboxID } });
        case "session.inbox.delivery.changed":
          return onEvent({
            type: "session.inbox.delivery.changed",
            properties: { sessionID: sid, inboxID: d.inboxID, delivery: d.delivery },
          });
        default:
          return undefined;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const payload = chunk
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        this.lastEventAt = Date.now();
        emit({ type: ev.type, data: ev.data ?? {}, location: ev.location, created: ev.created, id: ev.id });
      }
    }
  }
}
