import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pet", {
  getCharacter: () => ipcRenderer.invoke("pet:get-character"),
  getBadgeDisplay: () => ipcRenderer.invoke("pet:get-badge-display"),
  onBadgePlacement: (callback: (placement: unknown) => void) => ipcRenderer.on("pet:badge-placement", (_event, placement: unknown) => callback(placement)),
  clickBadge: (pluginId: string, id: string) => ipcRenderer.invoke("pet:click-badge", pluginId, id),
  onBadges: (callback: (badges: unknown) => void) => ipcRenderer.on("pet:badges", (_event, badges: unknown) => callback(badges)),
  onBubbleVisible: (callback: (visible: unknown) => void) => ipcRenderer.on("pet:bubble-visible", (_event, visible: unknown) => callback(visible)),
  onCharacter: (callback: (payload: unknown) => void) => ipcRenderer.on("pet:character", (_event, payload: unknown) => callback(payload)),
  onFrame: (callback: (payload: unknown) => void) => ipcRenderer.on("pet:frame", (_event, payload: unknown) => callback(payload)),
  onScaleChanged: (callback: () => void) => ipcRenderer.on("pet:scale-changed", callback),
  frameRendered: (sequence: number) => ipcRenderer.send("pet:frame-rendered", sequence),
  characterRendered: (version: number) => ipcRenderer.send("pet:character-rendered", version),
  markReady: () => ipcRenderer.send("pet:first-draw-complete"),
  setMousePassThrough: (ignore: boolean) => ipcRenderer.send("pet:set-mouse-pass-through", ignore),
  startDrag: () => ipcRenderer.send("pet:drag-start"),
  endDrag: () => ipcRenderer.send("pet:drag-end"),
  showContextMenu: () => ipcRenderer.send("pet:context-menu"),
});
