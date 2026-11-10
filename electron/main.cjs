// cute-pets desktop shell: a transparent, frameless, always-on-top pet window.
// Usage: npx electron electron/main.cjs [--dev]
// Env:   CP_URL  brain URL (default http://127.0.0.1:4282)
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const BRAIN = process.env.CP_URL || "http://127.0.0.1:4282";
const MIN = { width: 272, height: 404 };
const EXP = { width: 496, height: 760 };
const MARGIN = 22;

let win = null;
let expanded = false;

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
