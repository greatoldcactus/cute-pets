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
const forms = new Map(); // id -> pending question
const inboxes = new Map(); // session id -> Map(inbox id -> pending input)
const timers = new Map(); // session id -> Set(timeout) for the running turn
const interrupts = []; // test-only log of interrupt requests
const compactions = []; // test-only log of compaction requests
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
    running: false,
    time: { created: now(), updated: now(), busy: null, idle: null },
  };
  sessions.set(id, session);
  messages.set(id, []);
  return session;
}

function appendUser(session, text) {
  const list = messages.get(session.id) ?? [];
  list.push({ id: newID("msg"), type: "user", text, time: { created: now() } });
  messages.set(session.id, list);
}

function inboxFor(session, create = true) {
  let map = inboxes.get(session.id);
  if (!map && create) {
    map = new Map();
    inboxes.set(session.id, map);
  }
  return map;
}

// Pending inputs. A queue item waits for the turn to finish; a steer item is
// consumed at the next step boundary, or by interrupt(resume=true).
function enqueue(session, text, delivery) {
  const item = {
    id: newID("inbox"),
    type: "user",
    delivery,
    payload: { text },
    time: { created: now() },
  };
  inboxFor(session).set(item.id, item);
  broadcast("session.inbox.enqueued", {
    sessionID: session.id,
    inboxID: item.id,
    item,
    created: item.time.created,
  });
  return item;
}

function dropInbox(session, inboxID) {
  const map = inboxFor(session, false);
  if (!map?.delete(inboxID)) return false;
  if (!map.size) inboxes.delete(session.id);
  return true;
}

function deliverSteers(session) {
  const map = inboxFor(session, false);
  if (!map?.size) return false;
  let delivered = false;
  for (const item of [...map.values()]) {
    if (item.delivery !== "steer") continue;
    dropInbox(session, item.id);
    appendUser(session, item.payload?.text ?? "");
    broadcast("session.inbox.delivered", { sessionID: session.id, inboxID: item.id });
    delivered = true;
  }
  return delivered;
}

function isBusy(session) {
  return Boolean(session.running);
}

function clearTimers(id) {
  for (const t of timers.get(id) ?? []) clearTimeout(t);
  timers.delete(id);
}

function later(id, fn, ms) {
  let set = timers.get(id);
  if (!set) {
    set = new Set();
    timers.set(id, set);
  }
  const t = setTimeout(() => {
    set.delete(t);
    fn();
  }, ms);
  set.add(t);
}

function startTurn(session) {
  const list = messages.get(session.id) ?? [];
  messages.set(session.id, list);
  session.running = true;
  session.time.busy = now();
  session.time.updated = now();
  broadcast("session.execution.started", { sessionID: session.id });

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
    later(session.id, () => {
      session.running = false;
      session.time.idle = now();
      session.time.updated = now();
      broadcast("session.execution.failed", { sessionID: session.id, error });
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
  later(session.id, () => broadcast("session.text.delta", { sessionID: session.id, delta: "alive" }), 150);
  later(session.id, () => broadcast("session.text.ended", { sessionID: session.id, text: "alive" }), 300);
  later(session.id, () => {
    assistant.time.completed = now();
    session.running = false;
    session.time.idle = now();
    session.time.updated = now();
    session.tokens = { input: 12, output: 1 };
    broadcast("session.usage.updated", { sessionID: session.id, cost: 0, tokens: session.tokens });
    broadcast("session.execution.succeeded", { sessionID: session.id });
    // Steering is consumed by the end of a turn; queued prompts stay parked.
    if (deliverSteers(session)) startTurn(session);
  }, 1500);
}

function prompt(session, body) {
  const text = String(body.text ?? "");
  const delivery = body.delivery === "queue" ? "queue" : "steer";
  // A prompt sent while the session is busy is admitted to the inbox instead of
  // touching the history, exactly like OpenCode's durable queue.
  if (isBusy(session)) return { item: enqueue(session, text, delivery) };
  appendUser(session, text);
  startTurn(session);
  return null;
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
    if (route === "GET /api/experimental/session/stats") {
      const all = [...sessions.values()];
      const tokens = all.reduce((acc, s) => {
        acc.input += Number(s.tokens?.input) || 0;
        acc.output += Number(s.tokens?.output) || 0;
        return acc;
      }, { input: 0, output: 0 });
      const times = all.map((s) => Number(s.time?.created) || 0).filter(Boolean);
      return json(res, 200, {
        data: {
          range: { from: times.length ? Math.min(...times) : now(), to: now() },
          sessions: all.length,
          subagents: 0,
          prompts: 0,
          steps: 0,
          tokens: { ...tokens, reasoning: 0, cache: { read: 0, write: 0 } },
          cost: all.reduce((n, s) => n + (Number(s.cost) || 0), 0),
          tools: { mode: "none" },
          activeDays: 0,
          streak: 0,
          activity: [],
          models: [],
        },
      });
    }

    if (route === "GET /api/session") {
      return json(res, 200, { data: [...sessions.values()] });
    }
    if (route === "POST /api/session") {
      const session = createSession(await readBody(req));
      broadcast("session.created", session);
      return json(res, 200, { data: session });
    }
    const delSession = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (delSession && req.method === "DELETE") {
      const session = sessionByID(delSession[1]);
      if (!session) return json(res, 404, { error: "session not found" });
      sessions.delete(session.id);
      clearTimers(session.id);
      inboxes.delete(session.id);
      broadcast("session.deleted", { sessionID: session.id });
      res.writeHead(204);
      return res.end();
    }

    if (route === "GET /api/permission/request") return json(res, 200, { data: [] });
    if (route === "GET /api/form") return json(res, 200, { data: [...forms.values()] });
    if (route === "GET /api/test/stats") return json(res, 200, { data: { interrupts, compactions } });
    if (route === "POST /api/test/form") {
      const body = await readBody(req);
      const form = {
        id: newID("form"),
        sessionID: body.sessionID,
        title: "Pick a color",
        fields: [{ key: "color", title: "Color", type: "string", required: true }],
      };
      forms.set(form.id, form);
      broadcast("form.created", { form });
      return json(res, 200, { data: form });
    }
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

    const rev = url.pathname.match(/^\/api\/session\/([^/]+)\/revert(?:\/(stage|commit))?$/);
    if (rev) {
      const session = sessionByID(rev[1]);
      if (!session) return json(res, 404, { error: "session not found" });
      const step = rev[2] ?? null;
      if (!step && req.method === "DELETE") {
        session.revert = null;
        broadcast("session.revert.cleared", { sessionID: session.id });
        res.writeHead(204);
        return res.end();
      }
      if (step === "stage" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.messageID) return json(res, 400, { error: "messageID required" });
        session.revert = { messageID: body.messageID };
        broadcast("session.revert.staged", { sessionID: session.id, revert: session.revert });
        return json(res, 200, { data: session.revert });
      }
      if (step === "commit" && req.method === "POST") {
        session.revert = null;
        broadcast("session.revert.committed", { sessionID: session.id });
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { error: "not found", route });
    }

    const formRoute = url.pathname.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)(?:\/reply)?$/);
    if (formRoute) {
      const [, sid, fid, reply] = formRoute;
      const form = forms.get(fid);
      if (!form || form.sessionID !== sid) return json(res, 404, { error: "form not found" });
      if (reply && req.method === "POST") {
        forms.delete(fid);
        broadcast("form.replied", { id: fid, sessionID: sid });
        res.writeHead(204);
        return res.end();
      }
      if (!reply && req.method === "DELETE") {
        forms.delete(fid);
        broadcast("form.cancelled", {
          id: fid,
          sessionID: sid,
          message: url.searchParams.get("message") || null,
        });
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { error: "not found", route });
    }

    const inboxItem = url.pathname.match(/^\/api\/session\/([^/]+)\/inbox\/([^/]+)$/);
    if (inboxItem) {
      const session = sessionByID(inboxItem[1]);
      if (!session) return json(res, 404, { error: "session not found" });
      const inboxID = decodeURIComponent(inboxItem[2]);
      const item = inboxFor(session, false)?.get(inboxID);
      if (!item) {
        // Cancelling an item that already left the inbox is a no-op upstream;
        // changing its delivery is a conflict.
        if (req.method === "DELETE") {
          res.writeHead(204);
          return res.end();
        }
        return json(res, 409, { error: "inbox item not pending" });
      }
      if (req.method === "DELETE") {
        dropInbox(session, inboxID);
        broadcast("session.inbox.cancelled", { sessionID: session.id, inboxID });
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const body = await readBody(req);
        if (body.delivery === "queue" || body.delivery === "steer") item.delivery = body.delivery;
        broadcast("session.inbox.delivery.changed", {
          sessionID: session.id,
          inboxID,
          delivery: item.delivery,
        });
        // Steering wakes an idle session; a queued prompt keeps waiting.
        if (item.delivery === "steer" && !isBusy(session) && deliverSteers(session)) startTurn(session);
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { error: "not found", route });
    }

    const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const session = sessionByID(match[1]);
      if (!session) return json(res, 404, { error: "session not found" });
      const action = match[2] ?? null;

      if (!action && req.method === "GET") return json(res, 200, { data: session });
      if (!action && req.method === "PATCH") {
        const body = await readBody(req);
        if (typeof body.title === "string" && body.title.trim()) session.title = body.title.trim();
        session.time.updated = now();
        broadcast("session.renamed", { sessionID: session.id, title: session.title });
        return json(res, 200, { data: session });
      }
      if (action === "message" && req.method === "GET") {
        const rows = [...(messages.get(session.id) ?? [])]
          .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
        return json(res, 200, { data: rows, cursor: null });
      }
      if (action === "inbox" && req.method === "GET") {
        return json(res, 200, { data: [...(inboxFor(session, false)?.values() ?? [])] });
      }
      if (action === "interrupt" && req.method === "POST") {
        const resume = url.searchParams.get("resume") === "true";
        const interrupted = isBusy(session);
        interrupts.push({ sessionID: session.id, resume, interrupted });
        if (interrupted) {
          clearTimers(session.id);
          session.running = false;
          session.time.idle = now();
          session.time.updated = now();
          broadcast("session.execution.interrupted", { sessionID: session.id });
        }
        // resume hands pending steering input its own turn, while queued
        // prompts stay parked until they are promoted or the turn ends.
        if (resume && deliverSteers(session)) startTurn(session);
        return json(res, 200, { data: { interrupted } });
      }
      if (action === "agent" && req.method === "POST") {
        // Lets the plan-ready hand-off work against the stub: the brain refreshes
        // the session from this response after switching the agent.
        const body = await readBody(req);
        if (body.agent) session.agent = body.agent;
        session.time.updated = now();
        return json(res, 200, { data: session });
      }
      if (action === "fork" && req.method === "POST") {
        // v2 forks copy projected history before a message ID.
        const body = await readBody(req);
        const before = body.before ?? null;
        const list = messages.get(session.id) ?? [];
        let copy = [...list];
        if (before) {
          const idx = list.findIndex((m) => m.id === before);
          if (idx < 0) return json(res, 404, { error: "message not found" });
          copy = list.slice(0, idx);
        }
        const base = session.title.replace(/ \(fork #\d+\)$/, "");
        const n = [...sessions.values()]
          .filter((s) => s.title.startsWith(`${base} (fork #`)).length + 1;
        const child = createSession({
          title: `${base} (fork #${n})`,
          agent: session.agent,
          model: session.model,
          location: session.location,
        });
        messages.set(child.id, copy.map((m) => ({ ...m })));
        broadcast("session.created", child);
        return json(res, 200, { data: child });
      }
      if (action === "generate" && req.method === "POST") {
        // Transient side question: deliberately does not touch messages.
        await readBody(req);
        return json(res, 200, { data: { text: "A concise side answer." } });
      }
      if (action === "compact" && req.method === "POST") {
        // v2 admits a durable compaction request and reports progress through
        // events. The stub finishes immediately and leaves the history alone,
        // which is what the brain relies on: the summary is not a chat message.
        const body = await readBody(req);
        const compaction = {
          id: body.id ?? newID("msg"),
          sessionID: session.id,
          time: { created: now() },
          type: "compaction",
          payload: {},
          delivery: body.delivery ?? "steer",
        };
        compactions.push({
          sessionID: session.id,
          id: compaction.id,
          reason: "manual",
          delivery: compaction.delivery,
        });
        broadcast("session.compaction.started", {
          sessionID: session.id,
          reason: "manual",
          inputID: compaction.id,
        });
        broadcast("session.compaction.ended", {
          sessionID: session.id,
          reason: "manual",
          inputID: compaction.id,
          summary: "Fake summary.",
        });
        return json(res, 200, { data: compaction });
      }
      if (action === "prompt" && req.method === "POST") {
        const admitted = prompt(session, await readBody(req));
        return json(res, 200, { data: admitted?.item ?? {} });
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
