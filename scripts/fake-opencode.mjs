// Minimal OpenCode 2.x stub for hermetic tests and offline UI work.
//
// It implements only the surface the brain uses (see src/opencode-v2.mjs):
// attach, session list/create, prompt, messages, inbox, permissions, forms and
// the event stream. No model is called and nothing leaves the machine.
//
// Usage: node scripts/fake-opencode.mjs [--port 0] [--directory DIR] [--fail quota]
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";

const args = parseArgs(process.argv.slice(2));
const failMode = args.fail;
const directory = path.resolve(args.directory ?? process.cwd());

const sessions = new Map(); // id -> session
const messages = new Map(); // id -> message[]
const clients = new Set(); // open SSE responses

const now = () => Date.now();
const newID = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

function parseArgs(argv) {
  const out = { port: 0, directory: null, fail: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--directory") out.directory = argv[++i];
    else if (a === "--fail") out.fail = argv[++i];
    else if (a.startsWith("--fail=")) out.fail = a.slice("--fail=".length);
    else if (a === "--help" || a === "-h") {
      console.log("fake-opencode [--port 0] [--directory DIR] [--fail quota]");
      process.exit(0);
    }
  }
  return out;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function broadcast(type, data) {
  const payload = `data: ${JSON.stringify({ type, data, created: now() })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function sessionByID(id) {
  return sessions.get(decodeURIComponent(id)) ?? null;
}

function createSession(body = {}) {
  const id = newID("ses");
  const session = {
    id,
    slug: id,
    title: body.title || "Fake session",
    location: { directory: body.location?.directory ?? directory },
    agent: body.agent ?? "build",
    model: body.model ?? { id: "fake-1", providerID: "fake" },
    tokens: { input: 0, output: 0 },
    cost: 0,
    time: { created: now(), updated: now(), busy: null, idle: null },
  };
  sessions.set(id, session);
  messages.set(id, []);
  return session;
}

function prompt(session, body) {
  const id = session.id;
  const text = String(body.text ?? "");
  const list = messages.get(id) ?? [];
  list.push({ id: newID("msg"), type: "user", text, time: { created: now() } });
  messages.set(id, list);

  session.time.busy = now();
  session.time.updated = now();
  broadcast("session.execution.started", { sessionID: id });

  if (failMode === "quota") {
    const error = {
      type: "provider.quota",
      message: "Insufficient balance. Top up at https://opencode.ai/console/org_fake/billing?credits=1.",
      status: 402,
    };
    list.push({
      id: newID("msg"),
      type: "assistant",
      agent: session.agent,
      model: session.model,
      content: [],
      finish: "error",
      error,
      time: { created: now(), completed: now() },
    });
    setTimeout(() => {
      session.time.idle = now();
      session.time.updated = now();
      broadcast("session.execution.failed", { sessionID: id, error });
    }, 300);
    return;
  }

  const assistant = {
    id: newID("msg"),
    type: "assistant",
    agent: session.agent,
    model: session.model,
    content: [{ type: "text", text: "alive" }],
    finish: "stop",
    time: { created: now() },
  };
  list.push(assistant);

  // Keep the turn visibly running long enough for a 1s poller to observe it,
  // then finish with the deterministic reply the smoke test expects.
  setTimeout(() => broadcast("session.text.delta", { sessionID: id, delta: "alive" }), 150);
  setTimeout(() => broadcast("session.text.ended", { sessionID: id, text: "alive" }), 300);
  setTimeout(() => {
    assistant.time.completed = now();
    session.time.idle = now();
    session.time.updated = now();
    session.tokens = { input: 12, output: 1 };
    broadcast("session.usage.updated", { sessionID: id, cost: 0, tokens: session.tokens });
    broadcast("session.execution.succeeded", { sessionID: id });
  }, 1500);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    // The brain probes /global/health first; a 404 makes it fall through to the
    // v2 client, which is the surface this stub speaks.
    if (route === "GET /global/health") return json(res, 404, { error: "not found" });

    if (route === "GET /api/info") {
      return json(res, 200, { version: "2.2.6-fake", data: { version: "2.2.6-fake" } });
    }
    if (route === "GET /api/location") {
      return json(res, 200, { data: { directory } });
    }

    if (route === "GET /api/session") {
      return json(res, 200, { data: [...sessions.values()] });
    }
    if (route === "POST /api/session") {
      const session = createSession(await readBody(req));
      broadcast("session.created", session);
      return json(res, 200, { data: session });
    }

    if (route === "GET /api/permission/request") return json(res, 200, { data: [] });
    if (route === "GET /api/form") return json(res, 200, { data: [] });
    if (route === "GET /api/model") {
      return json(res, 200, {
        data: [{ providerID: "fake", modelID: "fake-1", name: "Fake", default: true, cost: [] }],
      });
    }
    if (route === "GET /api/agent") {
      return json(res, 200, { data: [{ id: "build", mode: "primary", description: "fake" }] });
    }
    if (route === "GET /api/command") return json(res, 200, { data: [] });

    if (route === "GET /api/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 1000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const session = sessionByID(match[1]);
      if (!session) return json(res, 404, { error: "session not found" });
      const action = match[2] ?? null;

      if (!action && req.method === "GET") return json(res, 200, { data: session });
      if (action === "message" && req.method === "GET") {
        const rows = [...(messages.get(session.id) ?? [])]
          .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
        return json(res, 200, { data: rows, cursor: null });
      }
      if (action === "inbox" && req.method === "GET") return json(res, 200, { data: [] });
      if (action === "prompt" && req.method === "POST") {
        prompt(session, await readBody(req));
        return json(res, 200, { data: {} });
      }
    }

    return json(res, 404, { error: "not found", route });
  } catch (err) {
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

server.listen(args.port, "127.0.0.1", () => {
  const { port } = server.address();
  console.log(`fake-opencode listening on http://127.0.0.1:${port}`);
});
