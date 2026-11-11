// cute-pets desktop shell.
// Two surfaces, two windows:
//   pet window    min.html#pet     sprite + bubbles, hugs its content
//   panel window  min.html#panel   sessions/chat/settings, shown on demand
// Keeping them apart means opening the panel never resizes the pet window, so the
// sprite cannot move on a click. Usage: npx electron electron/main.cjs [--dev]
const { app, BrowserWindow, ipcMain, screen, dialog, Menu } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BRAIN = process.env.CP_URL || "http://127.0.0.1:4280";
const { FULL: WIN, SMALL, MARGIN } = require("./sizes.cjs");
const LINUX = process.platform === "linux";

// .petzone in faces/web/min.html: 260x222, pinned to the pet window's bottom-right.
const PET_ZONE = { width: 260, height: 222 };
const PANEL_W = WIN.width; // 560
const PANEL_MAX_H = 574;
const PANEL_MIN_H = 340;
const PANEL_GAP = 6;

let petWin = null;
let panelWin = null;
let panelOpen = false;
let panelPending = null; // command queued until the panel page finishes loading
let grab = null;
let size = { ...SMALL }; // pet window size (hugged on Linux, fixed elsewhere)

// Always size from the tracked size: getBounds() returns scaled pixels while
// setBounds() takes DIPs, so feeding one into the other inflates the window on
// every move (that was the drift that also made the panel miss the screen).
function place(bounds) {
  petWin.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: size.width, height: size.height }, false);
}

// ---- config -------------------------------------------------------------
// ~/.cute-pets/config.json is shared with the brain (brain.json lives there too).
// facing: "right" = sprite as authored, "left" = mirrored.
const CONFIG_PATH = path.join(os.homedir(), ".cute-pets", "config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) ?? {};
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

// ---- panel placement ----------------------------------------------------
// Anchor the panel on the sprite's right edge and put it on whichever side of the
// sprite has room. The panel window is sized to fit, so the sprite never moves.
function panelPlacement() {
  const b = petWin.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width;
  const top = b.y + b.height - PET_ZONE.height;
  const bottom = b.y + b.height;
  const roomAbove = top - area.y - 10;
  const roomBelow = area.y + area.height - bottom - 10;

  let below = false;
  let height = PANEL_MAX_H;
  if (roomAbove >= PANEL_MAX_H) height = PANEL_MAX_H;
  else if (roomAbove >= PANEL_MIN_H) height = roomAbove;
  else if (roomBelow >= PANEL_MAX_H) { below = true; height = PANEL_MAX_H; }
  else if (roomBelow >= PANEL_MIN_H) { below = true; height = roomBelow; }
  else {
    below = roomBelow > roomAbove;
    height = Math.max(220, Math.min(PANEL_MAX_H, Math.max(roomAbove, roomBelow)));
  }

  const x = Math.max(area.x, Math.min(right - PANEL_W, area.x + area.width - PANEL_W));
  let y = below ? bottom + PANEL_GAP : top - height - PANEL_GAP;
  y = Math.max(area.y, Math.min(y, area.y + area.height - height));
  return { x: Math.round(x), y: Math.round(y), width: PANEL_W, height: Math.round(height) };
}

// The new-chat popover is shorter than the panel; size the window to it instead
// of leaving a tall transparent strip above the form.
function miniPlacement(height) {
  const b = petWin.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const right = b.x + b.width;
  const top = b.y + b.height - PET_ZONE.height;
  const bottom = b.y + b.height;
  const h = Math.max(120, Math.min(PANEL_MAX_H, Math.round(height)));
  const x = Math.max(area.x, Math.min(right - PANEL_W, area.x + area.width - PANEL_W));
  let y = top - h - PANEL_GAP;
  if (y < area.y) y = bottom + PANEL_GAP;
  y = Math.max(area.y, Math.min(y, area.y + area.height - h));
  return { x: Math.round(x), y: Math.round(y), width: PANEL_W, height: h };
}

function sendPanelCommand(cmd) {
  if (!panelWin || panelWin.isDestroyed()) return;
  if (panelWin.webContents.isLoadingMainFrame()) panelPending = cmd;
  else panelWin.webContents.send("cp:panel-command", cmd);
}

function showPanel(cmd = {}) {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.setBounds(panelPlacement(), false);
  panelOpen = true;
  if (!panelWin.isVisible()) panelWin.show();
  else panelWin.focus();
  sendPanelCommand({
    open: true,
    sessionId: cmd.sessionId ?? null,
    view: cmd.view ?? null,
    action: cmd.action ?? null,
  });
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send("cp:panel-state", { open: true });
}

function hidePanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelOpen = false;
  if (panelWin.isVisible()) panelWin.hide();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send("cp:panel-state", { open: false });
}

function togglePanel() {
  if (panelOpen) hidePanel();
  else showPanel({});
}

async function brainPost(pathname, body) {
  try {
    await fetch(BRAIN + pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  } catch {}
}

// ---- native menus -------------------------------------------------------
function petMenu() {
  const items = [
    { label: "New chat…", click: () => showPanel({ action: "new" }) },
    { label: "Sessions", click: () => showPanel({ view: "chat" }) },
    { label: "Pets", click: () => showPanel({ view: "pets" }) },
    { label: "Settings", click: () => showPanel({ view: "settings" }) },
    { type: "separator" },
    { label: panelOpen ? "Hide panel" : "Show panel", click: togglePanel },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ];
  Menu.buildFromTemplate(items).popup({ window: petWin });
}

function bubbleMenu(info = {}) {
  const items = [{ label: "Open", click: () => showPanel({ sessionId: info.sessionId }) }];
  if (info.state === "running" || info.state === "waiting") {
    items.push({ label: "Stop", click: () => brainPost("/api/abort", { server: info.server, sessionId: info.sessionId }) });
  }
  items.push(
    { type: "separator" },
    { label: "Hide from pet", click: () => brainPost("/api/session/hide", { sessionId: info.sessionId, hidden: true }) },
  );
  Menu.buildFromTemplate(items).popup({ window: petWin });
}

// ---- app ----------------------------------------------------------------
app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  petWin = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: area.x + area.width - size.width - MARGIN,
    y: area.y + area.height - size.height - MARGIN,
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

  petWin.on("maximize", () => {
    if (petWin.isMaximized()) petWin.unmaximize();
    const b = petWin.getBounds();
    place({ x: b.x, y: b.y });
  });
  petWin.on("resize", () => {
    if (LINUX) return; // the face hugs the pet + bubbles; keep the requested bounds
    const b = petWin.getBounds();
    if (b.width !== SMALL.width || b.height !== SMALL.height) {
      petWin.setBounds({ x: b.x, y: b.y, width: SMALL.width, height: SMALL.height }, false);
    }
  });
  petWin.setAlwaysOnTop(true, "screen-saver");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  panelWin = new BrowserWindow({
    width: PANEL_W,
    height: PANEL_MAX_H,
    show: false,
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
  panelWin.setAlwaysOnTop(true, "screen-saver");
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  petWin.loadURL(`${BRAIN}/min.html#pet`);
  panelWin.loadURL(`${BRAIN}/min.html#panel`);

  // Linux: the pet face sends the exact window rect so the window hugs the sprite
  // and bubbles. The panel is a separate window now, so this never fires on a click.
  ipcMain.on("cp:window-rect", (_e, rect) => {
    if (!LINUX || !rect) return;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (!(width > 40 && height > 40)) return;
    size = { width, height };
    petWin.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width, height }, false);
  });
  ipcMain.on("cp:window-sizes", (e) => {
    e.returnValue = { FULL: WIN, SMALL };
  });

  // Pet -> shell: show/close the panel (and optionally carry a session or view).
  ipcMain.on("cp:panel", (_e, info) => {
    if (!info) return;
    if (!info.open) hidePanel();
    else showPanel(info);
  });
  ipcMain.on("cp:panel-close", () => hidePanel());
  ipcMain.on("cp:panel-size", (_e, info) => {
    if (!panelOpen || !panelWin || panelWin.isDestroyed()) return;
    if (info && info.full) panelWin.setBounds(panelPlacement(), false);
    else if (info && info.height) panelWin.setBounds(miniPlacement(info.height), false);
  });
  ipcMain.on("cp:pet-menu", () => petMenu());
  ipcMain.on("cp:bubble-menu", (_e, info) => bubbleMenu(info));

  // Windows/macOS: the pet face toggles click-through itself; forward keeps the
  // page receiving mouse moves so it can take input back over the sprite.
  ipcMain.on("cp:ignore-mouse", (_e, ignore) => {
    try {
      petWin.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
    } catch {}
  });

  ipcMain.on("cp:quit", () => app.quit());

  // Import a pet pack (.zip file or a folder) through a native dialog, then let
  // the brain copy it into ~/.cute-pets/pets/<id>/.
  // A native dialog owned by an always-on-top window can open *behind* it, which
  // looks like the button doing nothing. Drop the flag for the duration.
  const withDialog = async (parent, fn) => {
    const wasTop = parent.isAlwaysOnTop();
    if (wasTop) parent.setAlwaysOnTop(false);
    try {
      return await fn();
    } finally {
      if (wasTop) parent.setAlwaysOnTop(true, "screen-saver");
    }
  };
  const parentOf = (e) => BrowserWindow.fromWebContents(e.sender) || panelWin || petWin;

  ipcMain.handle("cp:pick-folder", (e) => withDialog(parentOf(e), async () => {
    const res = await dialog.showOpenDialog(parentOf(e), {
      title: "Working directory",
      buttonLabel: "Use folder",
      properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  }));

  ipcMain.handle("cp:pick-pet", (e, kind) => withDialog(parentOf(e), async () => {
    const properties = kind === "folder" ? ["openDirectory"] : ["openFile"];
    const res = await dialog.showOpenDialog(parentOf(e), {
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
    for (const w of [petWin, panelWin]) {
      if (w && !w.isDestroyed()) w.webContents.send("cp:facing", facing);
    }
  });

  // Manual dragging: the renderer reports global cursor coords, the main process
  // moves the window. Keeps click-to-open working (a click is a drag of <4px).
  ipcMain.on("cp:drag-begin", (_e, p) => {
    const b = petWin.getBounds();
    grab = {
      dx: p.x - b.x,
      dy: p.y - b.y,
      start: { x: p.x, y: p.y },
      pet: p.pet ?? { x: 0, y: 0, width: b.width, height: b.height },
    };
  });
  ipcMain.on("cp:drag-move", (_e, p) => {
    if (!grab) return;
    // a real drag dismisses the panel; a plain click must not
    if (panelOpen && Math.abs(p.x - grab.start.x) + Math.abs(p.y - grab.start.y) > 4) hidePanel();
    const b = petWin.getBounds();
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
  ipcMain.on("cp:drag-end", () => {
    grab = null;
  });

  const sendFacing = (w) => () => w.webContents.send("cp:facing", config.facing);
  petWin.webContents.on("did-finish-load", sendFacing(petWin));
  panelWin.webContents.on("did-finish-load", () => {
    sendFacing(panelWin)();
    if (panelPending) {
      panelWin.webContents.send("cp:panel-command", panelPending);
      panelPending = null;
    }
  });

  if (process.argv.includes("--dev")) startDevServer();
});

// Dev-only: capture/eval either window.
// GET/POST http://127.0.0.1:4290/{shot,eval,size}[?file=&js=]        pet window
//                              /panel-{shot,eval,size}             panel window
function startDevServer() {
  const target = (url) => (url.pathname.startsWith("/panel-") ? panelWin : petWin);
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const win = target(url);
      const leaf = url.pathname.replace(/^\/panel-/, "/");
      if (!win) { res.end("no window"); return; }
      if (leaf === "/shot") {
        const img = await win.webContents.capturePage();
        const file = url.searchParams.get("file") || path.join(__dirname, "shot.png");
        fs.writeFileSync(file, img.toPNG());
        const shotSize = img.getSize();
        res.end(`saved ${file} ${shotSize.width}x${shotSize.height}`);
        return;
      }
      if (leaf === "/size") {
        res.end(JSON.stringify(win.getBounds()));
        return;
      }
      if (leaf === "/eval") {
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
