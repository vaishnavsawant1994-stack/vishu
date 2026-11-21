"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vishu", Object.freeze({
  request: (method, path, body) =>
    ipcRenderer.invoke("vishu:api", { method, path, body })
}));
