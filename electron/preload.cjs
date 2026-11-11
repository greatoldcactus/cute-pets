// Minimal bridge between the pet renderer and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cp", {
  setIgnore: (ignore) => ipcRenderer.send("cp:ignore-mouse", ignore),
  // Linux: the pet window hugs the sprite + bubbles. Click-through cannot take
  // mouse input back there (no mouse forwarding), so the window is resized instead.
  setWindowRect: (rect) => ipcRenderer.send("cp:window-rect", rect),
  useResize: process.platform === "linux",
  // Sandboxed preloads cannot require() app files, so ask the shell instead.
  sizes: ipcRenderer.sendSync("cp:window-sizes"),
  // Two-window surface: the pet opens/closes the shell-owned panel window.
  panel: (info) => ipcRenderer.send("cp:panel", info),
  panelSize: (info) => ipcRenderer.send("cp:panel-size", info),
  petMenu: () => ipcRenderer.send("cp:pet-menu"),
  bubbleMenu: (info) => ipcRenderer.send("cp:bubble-menu", info),
  onPanel: (cb) => ipcRenderer.on("cp:panel-state", (_e, s) => cb(s)),
  onPanelCommand: (cb) => ipcRenderer.on("cp:panel-command", (_e, c) => cb(c)),
  quit: () => ipcRenderer.send("cp:quit"),
  dragBegin: (p) => ipcRenderer.send("cp:drag-begin", p),
  moveBy: (dx, dy) => ipcRenderer.send("cp:move-by", { dx, dy }),
  dragMove: (p) => ipcRenderer.send("cp:drag-move", p),
  dragEnd: () => ipcRenderer.send("cp:drag-end"),
  setFacing: (facing) => ipcRenderer.send("cp:facing-set", facing),
  onFacing: (cb) => ipcRenderer.on("cp:facing", (_e, facing) => cb(facing)),
  importPet: (kind) => ipcRenderer.invoke("cp:pick-pet", kind),
  pickFolder: () => ipcRenderer.invoke("cp:pick-folder"),
});
