/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("driveClient", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  chooseFolder: () => ipcRenderer.invoke("choose-folder"),
  setup: (values) => ipcRenderer.invoke("setup", values),
});
