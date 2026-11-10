// cute-pets desktop shell: a transparent, frameless, always-on-top pet window.
// Usage: npx electron electron/main.cjs [--dev]
// Env:   CP_URL  brain URL (default http://127.0.0.1:4282)
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BRAIN = process.env.CP_URL || "http://127.0.0.1:4282";
const MIN = { width: 272, height: 404 };
const EXP = { width: 496, height: 760 };
const MARGIN = 22;

let win = null;
let expanded = false;
let grab = null;

// ---- config -------------------------------------------------------------
// ~/.cute-pets/config.json is shared with the brain (brain.json lives there too).
// facing: "right" = sprite as authored, "left" = mirrored.
const CONFIG_PATH = path.join(os.homedir(), ".cute-pets", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error("[cute-pets] config write failed:", err.message);
  }
}

const cliFacing = (() => {
  const i = process.argv.indexOf("--facing");
  const v = i >= 0 ? process.argv[i + 1] : null;
  return v === "left" || v === "right" ? v : null;
})();

const config = { ...readConfig() };
config.facing = cliFacing || (config.facing === "left" ? "left" : "right");

function anchorTo(bounds) {
  const cur = win.getBounds();
  const area = screen.getDisplayMatching(cur).workArea;
  // keep the pet (bottom-right of the window) where it is
  const x = cur.x + cur.width - bounds.width;
  const y = cur.y + cur.height - bounds.height;
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - bounds.width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - bounds.height)),
    ...bounds,
  };
}

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: MIN.width,
    height: MIN.height,
    x: area.x + area.width - MIN.width - MARGIN,
    y: area.y + area.height - MIN.height - MARGIN,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    fullscreenable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`${BRAIN}/min.html`);

  ipcMain.on("cp:expanded", (_e, on) => {
    expanded = Boolean(on);
    win.setBounds(anchorTo(expanded ? EXP : MIN), false);
  });
  ipcMain.on("cp:ignore-mouse", (_e, ignore) => {
    try {
      win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    } catch {}
  });
  ipcMain.on("cp:quit", () => app.quit());

  ipcMain.on("cp:facing-set", (_e, facing) => {
    if (facing !== "left" && facing !== "right") return;
    config.facing = facing;
    saveConfig({ ...readConfig(), facing });
    win.webContents.send("cp:facing", facing);
  });

  // Manual dragging: the renderer reports global cursor coords, the main process
  // moves the window. Keeps click-to-open working (a click is a drag of <4px).
  ipcMain.on("cp:drag-begin", (_e, p) => {
    const b = win.getBounds();
    grab = { dx: p.x - b.x, dy: p.y - b.y };
  });
  ipcMain.on("cp:drag-move", (_e, p) => {
    if (!grab) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const x = Math.min(Math.max(area.x, p.x - grab.dx), area.x + area.width - b.width);
    const y = Math.min(Math.max(area.y, p.y - grab.dy), area.y + area.height - b.height);
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height }, false);
  });
  ipcMain.on("cp:drag-end", () => {
    grab = null;
  });

  win.webContents.on("did-finish-load", () => win.webContents.send("cp:facing", config.facing));

  if (process.argv.includes("--dev")) startDevServer();
});

// Dev-only: POST/GET http://127.0.0.1:4290/shot?file=<path> captures the window
// (with alpha) so screenshots don't depend on desktop capture.
function startDevServer() {
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/shot") {
        const img = await win.webContents.capturePage();
        const file = url.searchParams.get("file") || path.join(__dirname, "shot.png");
        fs.writeFileSync(file, img.toPNG());
        const size = img.getSize();
        res.end(`saved ${file} ${size.width}x${size.height}`);
        return;
      }
      if (url.pathname === "/size") {
        res.end(JSON.stringify(win.getBounds()));
        return;
      }
      if (url.pathname === "/eval") {
        const code = url.searchParams.get("js") || "0";
        try {
          const out = await win.webContents.executeJavaScript(code);
          res.end(JSON.stringify({ ok: true, out }));
        } catch (err) {
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
        return;
      }
      res.end("ok");
    })
    .listen(4290, "127.0.0.1", () => console.log("[cute-pets] dev capture on http://127.0.0.1:4290"));
}
