// Thin HTTP client for a running `opencode serve` instance.
// Verified against opencode 1.18.7 (OpenAPI 3.1 at /doc).

const enc = encodeURIComponent;

export class OpenCodeClient {
  constructor(baseUrl, { directory = null } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, "");
    this.directory = directory;
    this.online = false;
    this.lastEventAt = 0;
  }

  async #req(path, init = {}) {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers || {}) },
      signal: AbortSignal.timeout(init.timeout ?? 20000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${init.method || "GET"} ${path} -> ${res.status} ${body.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  get(path) { return this.#req(path); }
  post(path, body) { return this.#req(path, { method: "POST", body: JSON.stringify(body ?? {}) }); }

  health() { return this.get("/global/health"); }
  listSessions() { return this.get("/session"); }
  statuses() { return this.get("/session/status"); }
  permissions() { return this.get("/permission"); }
  messages(id, limit = 20) { return this.get(`/session/${enc(id)}/message?limit=${limit}`); }
  createSession(body = {}) { return this.post("/session", body); }
  prompt(id, text, extra = {}) {
    return this.post(`/session/${enc(id)}/prompt_async`, { parts: [{ type: "text", text }], ...extra });
  }
  abort(id) { return this.post(`/session/${enc(id)}/abort`); }
  replyPermission(id, reply) { return this.post(`/permission/${enc(id)}/reply`, { reply }); }

  // SSE bus. Resolves when the stream ends; caller handles reconnect.
  async stream(onEvent, { signal } = {}) {
    const res = await fetch(this.baseUrl + "/event", {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`event stream -> ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handle = (chunk) => {
      const data = chunk
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) return;
      let ev;
      try { ev = JSON.parse(data); } catch { return; }
      this.lastEventAt = Date.now();
      onEvent(ev);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        handle(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
  }
}
