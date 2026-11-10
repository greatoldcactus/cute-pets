// Local HTTP API + SSE fanout for pet faces (web now, Electron later).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPets, importPet, usePet, activePet, petAsset } from "./pets.mjs";
import { readConfig, writeConfig } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, "..", "faces", "web");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > 1 << 20) throw new Error("body too large");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("invalid json"); }
}

export function startServer({ port, host, store, api }) {
  const clients = new Set();

  const broadcast = (snap) => {
    const payload = `event: state\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const res of clients) {
      try { res.write(payload); } catch { clients.delete(res); }
    }
  };

  store.on(broadcast);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /api/health") return json(res, 200, { ok: true, uptime: process.uptime() });

      if (route === "GET /api/state") return json(res, 200, store.snapshot());

      if (route === "GET /api/pet") {
        const pet = activePet();
        if (!pet) {
          return json(res, 200, { id: "saber", name: "Saber", fallback: true, url: "/assets/saber/spritesheet.webp" });
        }
        return json(res, 200, {
          id: pet.id,
          name: pet.name,
          description: pet.description,
          url: `/pets/${pet.id}/${pet.spritesheetPath}`,
        });
      }

      if (route === "GET /api/pets") return json(res, 200, listPets());

      if (route === "GET /api/commands") {
        const commands = await api.commands({ server: url.searchParams.get("server") });
        return json(res, 200, { commands });
      }

      if (route === "GET /api/models") {
        return json(res, 200, await api.models({ server: url.searchParams.get("server") }));
      }

      if (route === "GET /api/agents") {
        return json(res, 200, { agents: await api.agents({ server: url.searchParams.get("server") }) });
      }

      if (route === "POST /api/session/action") {
        const body = await readBody(req);
        const out = await api.sessionAction({
          server: body.server ?? null,
          sessionId: body.sessionId ?? null,
          action: body.action,
          value: body.value ?? null,
        });
        return json(res, 200, out);
      }

      if (route === "GET /api/workspaces") return json(res, 200, { workspaces: api.workspaces() });

      if (route === "POST /api/workspace") {
        const body = await readBody(req);
        const ws = await api.ensureWorkspace(body.directory);
        return json(res, 200, ws);
      }

      if (route === "POST /api/pets/import") {
        const body = await readBody(req);
        const pet = importPet(body.path);
        return json(res, 200, { ok: true, ...pet, ...listPets() });
      }

      if (route === "POST /api/pets/active") {
        const body = await readBody(req);
        if (!body.id) return json(res, 400, { error: "id required" });
        return json(res, 200, { ok: true, active: usePet(body.id) });
      }

      if (req.method === "GET" && url.pathname.startsWith("/pets/")) {
        const [, , petId, ...rest] = url.pathname.split("/");
        const rel = decodeURIComponent(rest.join("/"));
        const file = petAsset(petId, rel);
        if (!file) return json(res, 404, { error: "pet asset not found" });
        res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
        return fs.createReadStream(file).pipe(res);
      }

      if (route === "GET /api/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        res.write(`event: state\ndata: ${JSON.stringify(store.snapshot())}\n\n`);
        clients.add(res);
        const beat = setInterval(() => {
          try { res.write(": ping\n\n"); } catch {}
        }, 20000);
        req.on("close", () => {
          clearInterval(beat);
          clients.delete(res);
        });
        return;
      }

      if (route === "POST /api/attach") {
        const body = await readBody(req);
        if (!body.url) return json(res, 400, { error: "url required" });
        const client = await api.attach(body.url, {
          directory: body.directory ?? null,
          password: body.password ?? null,
        });
        return json(res, client ? 200 : 502, {
          ok: Boolean(client),
          attached: store.snapshot().servers.map((s) => s.url),
        });
      }

      if (route === "POST /api/detach") {
        const body = await readBody(req);
        const url = String(body.url ?? "").replace(/\/+$/, "");
        const cfg = readConfig();
        const servers = (cfg.servers ?? []).filter((u) => u !== url);
        writeConfig({ servers });
        return json(res, 200, { ok: true, servers });
      }

      if (route === "POST /api/announce") {
        const body = await readBody(req);
        if (!body.serverUrl) return json(res, 400, { error: "serverUrl required" });
        let client = await api.attach(body.serverUrl, { directory: body.directory ?? null });
        let via = "announce";
        if (!client) {
          // The announced URL is often the configured default, not the real port.
          const found = await api.discover();
          via = "scan";
          client = found.attached.length ? true : null;
        }
        return json(res, 200, {
          ok: Boolean(client),
          via,
          attached: store.snapshot().servers.map((s) => s.url),
        });
      }

      if (route === "POST /api/prompt") {
        const body = await readBody(req);
        const hasCommand = typeof body.command === "string" && body.command.length > 0;
        if (!hasCommand && (!body.text || typeof body.text !== "string")) {
          return json(res, 400, { error: "text or command required" });
        }
        const out = await api.prompt({
          server: body.server ?? null,
          sessionId: body.sessionId ?? null,
          newSession: Boolean(body.newSession),
          title: body.title ?? null,
          text: body.text,
          command: body.command ?? null,
          directory: body.directory ?? null,
        });
        return json(res, 200, out);
      }

      if (route === "POST /api/abort") {
        const body = await readBody(req);
        const out = await api.abort({ server: body.server ?? null, sessionId: body.sessionId });
        return json(res, 200, out);
      }

      if (route === "POST /api/permission") {
        const body = await readBody(req);
        const out = await api.replyPermission({ id: body.id, reply: body.reply });
        return json(res, 200, out);
      }

      if (route === "GET /api/messages") {
        const server = url.searchParams.get("server");
        const sessionId = url.searchParams.get("sessionId");
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const out = await api.messages({ server, sessionId, limit });
        return json(res, 200, out);
      }

      if (req.method === "GET") {
        const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
        const file = path.join(WEB_ROOT, rel);
        if (!file.startsWith(WEB_ROOT)) return json(res, 403, { error: "forbidden" });
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
          return fs.createReadStream(file).pipe(res);
        }
      }

      return json(res, 404, { error: "not found", route });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, port: server.address().port }));
  });
}
