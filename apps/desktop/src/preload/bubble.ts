import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bubble", {
  onRender: (callback: (payload: unknown) => void) => ipcRenderer.on("bubble:render", (_event, payload: unknown) => callback(payload)),
  onClear: (callback: () => void) => ipcRenderer.on("bubble:clear", callback),
  rendered: (payload: { sequence: number; width: number; height: number }) => ipcRenderer.send("bubble:rendered", payload),
  resized: (payload: { sequence: number; width: number; height: number }) => ipcRenderer.invoke("bubble:resized", payload),
  markReady: () => ipcRenderer.send("bubble:ready"),
  setMousePassThrough: (ignore: boolean) => ipcRenderer.send("bubble:set-mouse-pass-through", ignore),
  dismiss: () => ipcRenderer.send("bubble:dismiss"),
  chooseAction: (index: number) => ipcRenderer.send("bubble:action", index),
});
