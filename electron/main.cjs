// cute-pets desktop shell: a transparent, frameless, always-on-top pet window.
// Usage: npx electron electron/main.cjs [--dev]
// Env:   CP_URL  brain URL (default http://127.0.0.1:4280)
const { app, BrowserWindow, ipcMain, screen, dialog } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BRAIN = process.env.CP_URL || "http://127.0.0.1:4280";
// One fixed size: the panel shows/hides inside it, so the window never resizes.
// Resizing a transparent frameless window on Windows flashes for a frame — this
// avoids it entirely and keeps the pet anchored in the same pixels.
const WIN = { width: 560, height: 800 };
const MARGIN = 22;

let win = null;
let expanded = false;
let grab = null;
let locked = null; // last intentional bounds; the window must never change size

// Always size from the WIN constant: getBounds() returns scaled pixels while
// setBounds() takes DIPs, so feeding one into the other inflates the window on
// every move (that was the drift that also made the panel miss the screen).
function place(bounds) {
  win.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: WIN.width, height: WIN.height }, false);
}

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
    width: WIN.width,
    height: WIN.height,
    x: area.x + area.width - WIN.width - MARGIN,
    y: area.y + area.height - WIN.height - MARGIN,
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

  locked = { width: WIN.width, height: WIN.height };
  win.on("maximize", () => {
    if (win.isMaximized()) win.unmaximize();
    const b = win.getBounds();
    place({ x: b.x, y: b.y });
  });
  win.on("resize", () => {
    const b = win.getBounds();
    if (b.width !== WIN.width || b.height !== WIN.height) {
      win.setBounds({ x: b.x, y: b.y, width: WIN.width, height: WIN.height }, false);
    }
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(`${BRAIN}/min.html`);

  // Kept as a signal only: the window is a fixed size, so expanding never
  // resizes it (that resize was the source of the one-frame flicker on close).
  ipcMain.on("cp:expanded", (_e, on) => {
    expanded = Boolean(on);
  });
  ipcMain.on("cp:ignore-mouse", (_e, ignore) => {
    try {
      win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    } catch {}
  });
  ipcMain.on("cp:quit", () => app.quit());

  // Import a pet pack (.zip file or a folder) through a native dialog, then let
  // the brain copy it into ~/.cute-pets/pets/<id>/.
  // A native dialog owned by an always-on-top window can open *behind* it, which
  // looks like the button doing nothing. Drop the flag for the duration.
  const withDialog = async (fn) => {
    const wasTop = win.isAlwaysOnTop();
    if (wasTop) win.setAlwaysOnTop(false);
    try {
      return await fn();
    } finally {
      if (wasTop) win.setAlwaysOnTop(true, "screen-saver");
    }
  };

  ipcMain.handle("cp:pick-folder", () => withDialog(async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Working directory",
      buttonLabel: "Use folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  }));

  ipcMain.handle("cp:pick-pet", (_e, kind) => withDialog(async () => {
    const properties = kind === "folder" ? ["openDirectory"] : ["openFile"];
    const res = await dialog.showOpenDialog(win, {
      title: "Import pet",
      buttonLabel: "Import",
      properties,
      filters: kind === "folder" ? undefined : [{ name: "Pet pack", extensions: ["zip"] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    try {
      const r = await fetch(`${BRAIN}/api/pets/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: res.filePaths[0] }),
      });
      return { ok: r.ok, ...(await r.json()) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }));

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
    grab = {
      dx: p.x - b.x,
      dy: p.y - b.y,
      // the sprite box inside the window; only that has to stay on screen
      pet: p.pet ?? { x: 0, y: 0, width: b.width, height: b.height },
    };
  });
  ipcMain.on("cp:drag-move", (_e, p) => {
    if (!grab) return;
    const b = win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const pet = grab.pet;
    // allow the window to hang off-screen; keep the pet itself inside the work area
    const minX = area.x - pet.x;
    const maxX = area.x + area.width - (pet.x + pet.width);
    const minY = area.y - pet.y;
    const maxY = area.y + area.height - (pet.y + pet.height);
    const x = Math.min(Math.max(minX, p.x - grab.dx), maxX);
    const y = Math.min(Math.max(minY, p.y - grab.dy), maxY);
    place({ x, y });
  });

  // Nudge the window without touching its size (used to keep the pet still when
  // the panel flips above/below it).
  ipcMain.on("cp:move-by", (_e, d) => {
    if (!d) return;
    const b = win.getBounds();
    place({ x: b.x + (d.dx || 0), y: b.y + (d.dy || 0) });
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
