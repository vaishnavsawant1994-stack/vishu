"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vishu", Object.freeze({
  request: (method, path, body) =>
    ipcRenderer.invoke("vishu:api", { method, path, body }),
  openTextFile: () => ipcRenderer.invoke("vishu:open-text-file"),
  captureScreen: () => ipcRenderer.invoke("vishu:capture-screen"),
  openSelectedText: () => ipcRenderer.invoke("vishu:open-selected-text"),
  launchApplication: (appId) => ipcRenderer.invoke("vishu:launch-application", appId),
  chatStream: (streamId, body) => ipcRenderer.invoke("vishu:chat-stream", { streamId, body }),
  cancelStream: (streamId) => ipcRenderer.send("vishu:cancel-stream", streamId),
  onChatStream: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("vishu:chat-stream-event", listener);
    return () => ipcRenderer.removeListener("vishu:chat-stream-event", listener);
  }
}));
