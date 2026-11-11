// Minimal bridge between the pet renderer and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cp", {
  // Three surfaces owned by the shell: the pet opens/closes the panel window,
  // the bubbles report their content size, and the tooltip is drawn by the pet.
  panel: (info) => ipcRenderer.send("cp:panel", info),
  panelSize: (info) => ipcRenderer.send("cp:panel-size", info),
  bubblesSize: (size) => ipcRenderer.send("cp:bubbles-size", size),
  tooltip: (info) => ipcRenderer.send("cp:tooltip", info),
  onTooltip: (cb) => ipcRenderer.on("cp:tooltip", (_e, info) => cb(info)),
  petMenu: () => ipcRenderer.send("cp:pet-menu"),
  bubbleMenu: (info) => ipcRenderer.send("cp:bubble-menu", info),
  onPanel: (cb) => ipcRenderer.on("cp:panel-state", (_e, s) => cb(s)),
  onPanelCommand: (cb) => ipcRenderer.on("cp:panel-command", (_e, c) => cb(c)),
  quit: () => ipcRenderer.send("cp:quit"),
  dragBegin: (p) => ipcRenderer.send("cp:drag-begin", p),
  dragMove: (p) => ipcRenderer.send("cp:drag-move", p),
  dragEnd: () => ipcRenderer.send("cp:drag-end"),
  setFacing: (facing) => ipcRenderer.send("cp:facing-set", facing),
  onFacing: (cb) => ipcRenderer.on("cp:facing", (_e, facing) => cb(facing)),
  importPet: (kind) => ipcRenderer.invoke("cp:pick-pet", kind),
  pickFolder: () => ipcRenderer.invoke("cp:pick-folder"),
});
