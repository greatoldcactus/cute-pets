// cute-pets desktop shell.
// Three surfaces, three windows:
//   pet window      min.html#pet      sprite only, fixed size
//   bubbles window  min.html#bubbles  the bubble stack, sized to its content
//   panel window    min.html#panel    sessions/chat/settings, shown on demand
// The sprite window never changes size, so nothing can make the pet jump when a
// bubble appears/disappears or when the panel opens.
// Usage: npx electron electron/main.cjs [--dev]
const { app, BrowserWindow, ipcMain, screen, dialog, Menu, clipboard } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const BRAIN = process.env.CP_URL || "http://127.0.0.1:4280";
const { FULL, PET, MARGIN } = require("./sizes.cjs");

const PANEL_W = FULL.width; // 560
const PANEL_MAX_H = 574;
const PANEL_MIN_H = 340;
const PANEL_GAP = 6;
const BUBBLE_GAP = 2;
const MIN_VISIBLE = 40; // px of the pet/window that must stay on a real display

let petWin = null;
let bubbleWin = null;
let panelWin = null;
let panelOpen = false;
let panelPending = null; // command queued until the panel page finishes loading
let bubbleSize = { width: 0, height: 0 };
let grab = null;

// The pet window is a fixed size; move it without ever resizing it.
function place(bounds, { save = false, panel = false } = {}) {
  petWin.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: PET.width, height: PET.height }, false);
  positionBubbles();
  if (panel && panelOpen && panelWin && !panelWin.isDestroyed()) panelWin.setBounds(panelPlacement(), false);
  if (save) rememberPosition();
}

// ---- displays -----------------------------------------------------------
// Coordinates are Electron DIP screen coordinates. The virtual area lets the
// pet cross the seam between adjacent monitors instead of being clamped to the
// display it started on.
function displayAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

function virtualWorkArea() {
  const areas = displayAreas();
  if (!areas.length) return screen.getPrimaryDisplay().workArea;
  const x = Math.min(...areas.map((a) => a.x));
  const y = Math.min(...areas.map((a) => a.y));
  const right = Math.max(...areas.map((a) => a.x + a.width));
  const bottom = Math.max(...areas.map((a) => a.y + a.height));
  return { x, y, width: right - x, height: bottom - y };
}

function visibleEnough(rect) {
  const needW = Math.min(MIN_VISIBLE, rect.width);
  const needH = Math.min(MIN_VISIBLE, rect.height);
  return displayAreas().some((a) => {
    const w = Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x);
    const h = Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y);
    return w >= needW && h >= needH;
  });
}

// Clamp a window position so `pet` (a rect relative to that window) stays on
// the virtual desktop. If the monitors leave a hole, snap to the nearest real
// work area so the pet cannot disappear into it.
function clampPetWindow(x, y, pet) {
  const area = virtualWorkArea();
  const minX = area.x - pet.x;
  const maxX = area.x + area.width - (pet.x + pet.width);
  const minY = area.y - pet.y;
  const maxY = area.y + area.height - (pet.y + pet.height);
  let nx = Math.max(minX, Math.min(Math.round(x), maxX));
  let ny = Math.max(minY, Math.min(Math.round(y), maxY));
  const rect = { x: nx + pet.x, y: ny + pet.y, width: pet.width, height: pet.height };
  if (visibleEnough(rect)) return { x: nx, y: ny };

  const nearest = screen.getDisplayNearestPoint({
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  }).workArea;
  nx = Math.max(nearest.x - pet.x, Math.min(nx, nearest.x + nearest.width - (pet.x + pet.width)));
  ny = Math.max(nearest.y - pet.y, Math.min(ny, nearest.y + nearest.height - (pet.y + pet.height)));
  return { x: Math.round(nx), y: Math.round(ny) };
}

function repositionPanel() {
  if (panelOpen && panelWin && !panelWin.isDestroyed()) panelWin.setBounds(panelPlacement(), false);
}

function rememberPosition() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const pos = { x: b.x, y: b.y };
  if (config.petPosition?.x === pos.x && config.petPosition?.y === pos.y) return;
  config.petPosition = pos;
  saveConfig({ ...readConfig(), petPosition: pos });
}

function startupPetPosition(primaryArea) {
  const saved = config.petPosition;
  const fallback = {
    x: primaryArea.x + primaryArea.width - PET.width - MARGIN,
    y: primaryArea.y + primaryArea.height - PET.height - MARGIN,
  };
  if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback;
  const pos = { x: Math.round(saved.x), y: Math.round(saved.y) };
  if (visibleEnough({ ...pos, width: PET.width, height: PET.height })) return pos;
  return clampPetWindow(pos.x, pos.y, { x: 0, y: 0, width: PET.width, height: PET.height });
}

function movePetToDisplay(display) {
  const area = display.workArea;
  const pos = clampPetWindow(
    area.x + area.width - PET.width - MARGIN,
    area.y + area.height - PET.height - MARGIN,
    { x: 0, y: 0, width: PET.width, height: PET.height },
  );
  place(pos, { save: true, panel: true });
}

function keepPetOnScreen() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  if (!visibleEnough({ x: b.x, y: b.y, width: b.width, height: b.height })) {
    const pos = clampPetWindow(b.x, b.y, { x: 0, y: 0, width: b.width, height: b.height });
    place(pos, { panel: true });
    return;
  }
  positionBubbles();
  repositionPanel();
}


// ---- config -------------------------------------------------------------
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
config.auras = config.auras !== false;

// ---- placement ----------------------------------------------------------
function workArea(win) {
  return screen.getDisplayMatching(win.getBounds()).workArea;
}

// The bubbles hug the sprite's top-right corner. Their window is sized by the
// bubble face; this only positions it, so the pet window itself never changes.
function bubblePlacement() {
  const b = petWin.getBounds();
  const area = workArea(petWin);
  const w = Math.max(1, Math.round(bubbleSize.width));
  const h = Math.max(1, Math.round(bubbleSize.height));
  const x = Math.max(area.x, Math.min(b.x + b.width - w, area.x + area.width - w));
  let y = b.y - h - BUBBLE_GAP;
  if (y < area.y) y = b.y + b.height + BUBBLE_GAP; // no room above: below the pet
  y = Math.max(area.y, Math.min(y, area.y + area.height - h));
  return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

function positionBubbles() {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  const visible = !panelOpen && bubbleSize.width > 1 && bubbleSize.height > 1;
  if (!visible) {
    if (bubbleWin.isVisible()) bubbleWin.hide();
    return;
  }
  bubbleWin.setBounds(bubblePlacement(), false);
  if (!bubbleWin.isVisible()) bubbleWin.showInactive();
}

function panelPlacement() {
  const b = petWin.getBounds();
  const area = workArea(petWin);
  const right = b.x + b.width;
  const top = b.y;
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
  const area = workArea(petWin);
  const right = b.x + b.width;
  const top = b.y;
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
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send("cp:panel-state", { open: true });
    petWin.webContents.send("cp:tooltip", { show: false });
  }
  positionBubbles();
}

function hidePanel() {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelOpen = false;
  if (panelWin.isVisible()) panelWin.hide();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send("cp:panel-state", { open: false });
  positionBubbles();
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
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const items = [
    { label: "New chat…", click: () => showPanel({ action: "new" }) },
    { label: "Sessions", click: () => showPanel({ view: "chat" }) },
    { label: "Pets", click: () => showPanel({ view: "pets" }) },
    { label: "Settings", click: () => showPanel({ view: "settings" }) },
  ];
  if (displays.length > 1) {
    items.push({ type: "separator" }, {
      label: "Move to display",
      submenu: displays.map((d, i) => ({
        label: `${d.label || `Display ${i + 1}`} · ${d.workArea.width}×${d.workArea.height}${d.id === primary.id ? " (primary)" : ""}`,
        click: () => movePetToDisplay(d),
      })),
    });
  }
  items.push(
    { type: "separator" },
    { label: panelOpen ? "Hide panel" : "Show panel", click: togglePanel },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  );
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
  Menu.buildFromTemplate(items).popup({ window: bubbleWin || petWin });
}

// ---- windows ------------------------------------------------------------
const WEB_PREFS = {
  preload: path.join(__dirname, "preload.cjs"),
  contextIsolation: true,
  nodeIntegration: false,
};

function load(w, surface) {
  w.loadURL(`${BRAIN}/min.html#${surface}`);
}

app.whenReady().then(() => {
  const area = screen.getPrimaryDisplay().workArea;
  const start = startupPetPosition(area);

  petWin = new BrowserWindow({
    width: PET.width,
    height: PET.height,
    x: start.x,
    y: start.y,
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
    webPreferences: WEB_PREFS,
  });
  petWin.on("maximize", () => {
    if (petWin.isMaximized()) petWin.unmaximize();
    const b = petWin.getBounds();
    place({ x: b.x, y: b.y });
  });
  petWin.on("resize", () => {
    const b = petWin.getBounds();
    if (b.width !== PET.width || b.height !== PET.height) {
      petWin.setBounds({ x: b.x, y: b.y, width: PET.width, height: PET.height }, false);
      positionBubbles();
    }
  });
  petWin.setAlwaysOnTop(true, "screen-saver");
  petWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  bubbleWin = new BrowserWindow({
    width: 320,
    height: 400,
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    fullscreenable: false,
    maximizable: false,
    webPreferences: WEB_PREFS,
  });
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  bubbleWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

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
    webPreferences: WEB_PREFS,
  });
  panelWin.setAlwaysOnTop(true, "screen-saver");
  panelWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  load(petWin, "pet");
  load(bubbleWin, "bubbles");
  load(panelWin, "panel");

  // Keep the pet reachable when monitors are plugged/unplugged or their work
  // areas change (dock, taskbar, resolution).
  screen.on("display-added", keepPetOnScreen);
  screen.on("display-removed", keepPetOnScreen);
  screen.on("display-metrics-changed", keepPetOnScreen);

  // Bubbles face -> shell: content size (and therefore window size).
  ipcMain.on("cp:bubbles-size", (_e, s) => {
    bubbleSize = { width: Number(s?.width) || 0, height: Number(s?.height) || 0 };
    positionBubbles();
  });
  // Bubbles face -> pet face: the tooltip is drawn in the pet window (it can be
  // pointer-transparent there without needing an extra window).
  ipcMain.on("cp:tooltip", (_e, info) => {
    if (petWin && !petWin.isDestroyed()) {
      petWin.webContents.send("cp:tooltip", { show: Boolean(info?.show), html: info?.html || "" });
    }
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
  ipcMain.on("cp:quit", () => app.quit());
  // The renderer's clipboard API needs document focus; the main-process clipboard
  // works even when the panel was clicked while another window was focused.
  ipcMain.handle("cp:clipboard-write", (_e, text) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });

  // Import a pet pack (.zip file or a folder) through a native dialog, then let
  // the brain copy it into ~/.cute-pets/pets/<id>/.
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

  ipcMain.on("cp:auras-set", (_e, on) => {
    config.auras = Boolean(on);
    saveConfig({ ...readConfig(), auras: config.auras });
    for (const w of [petWin, panelWin]) {
      if (w && !w.isDestroyed()) w.webContents.send("cp:auras", config.auras);
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
    // The virtual desktop, not the display the pet happens to be on: otherwise
    // the clamp stops the sprite at the seam and it can never reach monitor 2.
    const pos = clampPetWindow(p.x - grab.dx, p.y - grab.dy, grab.pet);
    place(pos);
  });
  ipcMain.on("cp:drag-end", () => {
    if (!grab) return;
    grab = null;
    rememberPosition();
  });

  const sendFacing = (w) => () => w.webContents.send("cp:facing", config.facing);
  const sendAuras = (w) => () => w.webContents.send("cp:auras", config.auras);
  petWin.webContents.on("did-finish-load", sendFacing(petWin));
  petWin.webContents.on("did-finish-load", sendAuras(petWin));
  panelWin.webContents.on("did-finish-load", () => {
    sendFacing(panelWin)();
    sendAuras(panelWin)();
    if (panelPending) {
      panelWin.webContents.send("cp:panel-command", panelPending);
      panelPending = null;
    }
  });
  // after the bubbles page loads it reports its size; if the panel is open it
  // stays hidden, otherwise it appears on its own
  bubbleWin.webContents.on("did-finish-load", positionBubbles);

  if (process.argv.includes("--dev")) startDevServer();
});

// Dev-only: capture/eval any window.
// GET/POST http://127.0.0.1:4290/{shot,eval,size}[?file=&js=]         pet
//                              /bubble-…                            bubbles
//                              /panel-…                             panel
function startDevServer() {
  const target = (url) =>
    url.pathname.startsWith("/panel-") ? panelWin
      : url.pathname.startsWith("/bubble-") ? bubbleWin
        : petWin;
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const win = target(url);
      const leaf = url.pathname.replace(/^\/(panel|bubble)-/, "/");
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
