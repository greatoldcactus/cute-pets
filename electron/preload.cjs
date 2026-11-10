// Minimal bridge between the pet renderer and the desktop shell.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cp", {
  setExpanded: (on) => ipcRenderer.send("cp:expanded", on),
  setIgnore: (ignore) => ipcRenderer.send("cp:ignore-mouse", ignore),
  quit: () => ipcRenderer.send("cp:quit"),
});
