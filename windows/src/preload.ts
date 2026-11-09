import { contextBridge, ipcRenderer } from "electron";
import type { Bridge } from "./bridge";
const bridge: Bridge = {
  sprite: (id, shiny) => ipcRenderer.invoke("companion:sprite", id, shiny),
  view: () => ipcRenderer.invoke("companion:view"),
  refresh: () => ipcRenderer.invoke("companion:refresh"),
  settings: (value) => ipcRenderer.invoke("companion:settings", value),
  addFolder: (provider) => ipcRenderer.invoke("companion:add-folder", provider),
  exportSave: () => ipcRenderer.invoke("companion:export"),
  importSave: () => ipcRenderer.invoke("companion:import"),
  show: () => ipcRenderer.invoke("companion:show"),
  subscribe(callback) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      view: Parameters<typeof callback>[0],
    ) => callback(view);
    ipcRenderer.on("companion:changed", handler);
    return () => ipcRenderer.removeListener("companion:changed", handler);
  },
};
contextBridge.exposeInMainWorld("companion", bridge);
