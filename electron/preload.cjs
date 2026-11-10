// Minimal bridge between the pet renderer and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cp", {
  setExpanded: (on) => ipcRenderer.send("cp:expanded", on),
  setIgnore: (ignore) => ipcRenderer.send("cp:ignore-mouse", ignore),
  quit: () => ipcRenderer.send("cp:quit"),
  dragBegin: (p) => ipcRenderer.send("cp:drag-begin", p),
  dragMove: (p) => ipcRenderer.send("cp:drag-move", p),
  dragEnd: () => ipcRenderer.send("cp:drag-end"),
  setFacing: (facing) => ipcRenderer.send("cp:facing-set", facing),
  onFacing: (cb) => ipcRenderer.on("cp:facing", (_e, facing) => cb(facing)),
  importPet: (kind) => ipcRenderer.invoke("cp:pick-pet", kind),
  pickFolder: () => ipcRenderer.invoke("cp:pick-folder"),
});
