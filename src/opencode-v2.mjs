// OpenCode 2.x client (v2.2.6). Same surface as the v1 client: the brain and the
// faces never see the difference, only normalized shapes.
//
// Differences that matter, all verified against a live v2 server:
//  - HTTP Basic auth, username "opencode", password from OPENCODE_SERVER_PASSWORD
//  - every route lives under /api/*
//  - responses are wrapped in { data } (some also carry { location })
//  - sessions: directory lives in location.directory
//  - messages: parts are called content[]; role comes from type
//  - prompts default to delivery "steer" (dropped if no turn runs) — we send "queue"
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

  async messages(id, limit = 20) {
    // Ask for the newest page instead of the whole history: tool inputs/outputs
    // can be large and the chat only needs the tail. The response is newest-first.
    const out = await this.#req(`/api/session/${enc(id)}/message?limit=${encodeURIComponent(String(limit))}&order=desc`);
    const rows = [...(out?.data ?? [])].reverse();
    const toolOutput = (st) => {
      let o = st?.content;
      if (Array.isArray(o)) o = o.filter((x) => x?.type === "text" && x.text).map((x) => x.text).join("\n");
      else if (o && typeof o === "object") o = JSON.stringify(o, null, 2);
      if (st?.error) o = [String(st.error), o || ""].filter(Boolean).join("\n\n");
      return o || "";
    };
    const partsOf = (m) => {
      const parts = [];
      if (m.type === "user") {
        if (m.text) parts.push({ type: "text", text: m.text });
        for (const f of m.files ?? []) {
          parts.push({ type: "file", name: f?.name || f?.path || String(f), path: f?.path ?? null });
        }
      } else if (m.type === "assistant") {
        for (const c of m.content ?? []) {
          if (c.type === "text" && c.text) parts.push({ type: "text", text: c.text });
          else if (c.type === "reasoning" && c.text) parts.push({ type: "reasoning", text: c.text });
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

  // v2 prompts are queued; "steer" (the default) is dropped when no turn is running.
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

    const emit = (wrapper) => {
      const d = wrapper.data ?? {};
      const sid = d.sessionID;
      switch (wrapper.type) {
        case "session.created":
          return onEvent({ type: "session.created", properties: { info: OpenCodeV2Client.mapSession(d) } });
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
          return onEvent({ type: "session.error", properties: { sessionID: sid, error: { message: "execution failed" } } });
        case "session.text.delta":
          return onEvent({ type: "message.part.delta", properties: { sessionID: sid, delta: d.delta ?? "" } });
        case "session.text.ended":
          return onEvent({ type: "message.part.updated", properties: { part: { sessionID: sid, type: "text", text: d.text ?? "" } } });
        case "session.status":
          return onEvent({ type: "session.status", properties: { sessionID: sid, status: d.status ?? { type: "idle" } } });
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
        emit({ type: ev.type, data: ev.data ?? {}, location: ev.location });
      }
    }
  }
}
