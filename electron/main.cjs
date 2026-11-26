"use strict";

const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { isAllowedTextFile, appendActionAudit } = require("./safety.cjs");
const { resolveVoskModelPath } = require("./runtime.cjs");
const { captureSelectedScreen, registerMediaHandlers } = require("./media.cjs");
const { registerSingleInstance } = require("./lifecycle.cjs");

let backend = null;
let backendPort = null;
let backendFailure = null;
const sessionToken = randomBytes(32).toString("hex");
const activeStreams = new Map();
let mainWindow = null;
const isPrimaryInstance = registerSingleInstance(app, () => mainWindow);

function trustedOwner(event) {
  const owner = event && BrowserWindow.fromWebContents(event.sender);
  if (!owner || !owner.webContents || event.senderFrame !== owner.webContents.mainFrame ||
      event.sender.isDestroyed()) {
    throw new Error("This operation must originate from the active VISHU main window.");
  }
  return owner;
}

function getVoskModelPath() {
  return resolveVoskModelPath({
    env: process.env,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  });
}

function obtainPort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      const port = address.port;
      listener.close(() => resolve(port));
    });
  });
}

function isAllowedRequest(method, route) {
  if (method === "GET") {
    return route === "/api/health" ||
      route === "/api/conversations" ||
      /^\/api\/conversations\/[a-f0-9-]{36}\/messages$/.test(route);
  }
  if (method === "POST") {
    return route === "/api/chat" || route === "/api/conversations" ||
      route === "/api/chat/stream" || route === "/api/transcribe" || route === "/api/screen";
  }
  if (method === "DELETE") {
    return /^\/api\/conversations\/[a-f0-9-]{36}$/.test(route);
  }
  return false;
}

async function waitUntilHealthy() {
  for (let i = 0; i < 100; i += 1) {
    if (backendFailure) {
      throw backendFailure;
    }
    if (backend && backend.exitCode !== null) {
      throw new Error("The VISHU Python backend exited during startup.");
    }
    try {
      const response = await fetch("http://127.0.0.1:" + backendPort + "/api/health", {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return;
    } catch (_ignored) {
      // Wait for uvicorn to finish booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("The VISHU local API did not become ready.");
}

async function startBackend() {
  backendPort = await obtainPort();
  const backendDir = path.resolve(__dirname, "..", "backend");
  const dataDir = app.getPath("userData");
  fs.mkdirSync(dataDir, { recursive: true });
  if (app.isPackaged) {
    const executable = path.join(process.resourcesPath, "backend", "VISHUBackend.exe");
    backend = spawn(executable, ["--port", String(backendPort)], {
      cwd: dataDir,
      env: {
        ...process.env,
        VISHU_API_TOKEN: sessionToken,
        VISHU_DB_PATH: path.join(dataDir, "vishu.sqlite3"),
        VISHU_VOSK_MODEL_PATH: getVoskModelPath()
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } else {
    const python = process.env.VISHU_PYTHON ||
      (process.platform === "win32" ? "python" : "python3");
    backend = spawn(
      python,
      ["-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", String(backendPort)],
      {
        cwd: backendDir,
        env: {
          ...process.env,
          VISHU_API_TOKEN: sessionToken,
          VISHU_DB_PATH: path.join(dataDir, "vishu.sqlite3"),
          VISHU_VOSK_MODEL_PATH: getVoskModelPath()
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );
  }
  backend.on("error", (error) => {
    backendFailure = error;
  });
  backend.stderr.on("data", (bytes) => {
    process.stderr.write("[VISHU API] " + String(bytes));
  });
  await waitUntilHealthy();
}

ipcMain.handle("vishu:api", async (event, input) => {
  trustedOwner(event);
  if (!input || typeof input !== "object" || !backendPort) {
    throw new Error("VISHU backend is not ready.");
  }
  const { method, path: route, body } = input;
  if (typeof route !== "string" || !isAllowedRequest(method, route)) {
    throw new Error("This API action is not authorized.");
  }
  const response = await fetch("http://127.0.0.1:" + backendPort + route, {
    method,
    headers: {
      Authorization: "Bearer " + sessionToken,
      "Content-Type": "application/json"
    },
    body: method === "POST" ? JSON.stringify(body || {}) : undefined,
    signal: AbortSignal.timeout(80000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof payload.detail === "string"
      ? payload.detail
      : "VISHU request failed (HTTP " + response.status + ").");
  }
  return payload;
});

ipcMain.handle("vishu:open-text-file", async (event) => {
  const owner = trustedOwner(event);
  const choice = await dialog.showOpenDialog(owner, {
    title: "Choose a text file to share with VISHU",
    properties: ["openFile"],
    filters: [{ name: "Text and data files", extensions: ["txt", "md", "csv", "json", "log"] }]
  });
  if (choice.canceled || choice.filePaths.length !== 1) return null;
  const filePath = choice.filePaths[0];
  if (!/\.(txt|md|csv|json|log)$/i.test(filePath)) throw new Error("That file type is not supported.");
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 100_000) throw new Error("Choose a text file smaller than 100 KB.");
  const content = fs.readFileSync(filePath, "utf8");
  return { name: path.basename(filePath), content };
});

ipcMain.handle("vishu:capture-screen", (event) => captureSelectedScreen({
  event,
  window: BrowserWindow.fromWebContents(event.sender),
  dialog,
  desktopCapturer,
  logError: (label, error) => process.stderr.write(
    "[VISHU media] " + label + ": " + String(error?.message || error) + "\n"
  )
}));

function recordAction(eventRecord) {
  appendActionAudit(app.getPath("userData"), eventRecord);
}

ipcMain.handle("vishu:open-selected-text", async (event) => {
  const owner = trustedOwner(event);
  const choice = await dialog.showOpenDialog(owner, {
    title: "Choose a text document to open",
    properties: ["openFile"],
    filters: [{ name: "Text and data files", extensions: ["txt", "md", "csv", "json", "log"] }]
  });
  if (choice.canceled || choice.filePaths.length !== 1) {
    recordAction({ action: "open-selected-text", decision: "cancelled", file: null });
    return { opened: false, cancelled: true };
  }
  const filePath = choice.filePaths[0];
  if (!isAllowedTextFile(filePath, fs.statSync(filePath))) {
    recordAction({ action: "open-selected-text", decision: "rejected", file: path.basename(filePath) });
    throw new Error("Only plain text and data files can be opened by this action.");
  }
  const consent = await dialog.showMessageBox(owner, {
    type: "question",
    buttons: ["Open file", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Confirm Windows action",
    message: "Open this selected text file with its Windows default application?",
    detail: path.basename(filePath)
  });
  if (consent.response !== 0) {
    recordAction({ action: "open-selected-text", decision: "denied", file: path.basename(filePath) });
    return { opened: false, cancelled: true };
  }
  recordAction({ action: "open-selected-text", decision: "authorized", file: path.basename(filePath) });
  const failure = await shell.openPath(filePath);
  if (failure) {
    recordAction({ action: "open-selected-text", decision: "failed", file: path.basename(filePath) });
    throw new Error("Windows could not open the selected text file.");
  }
  recordAction({ action: "open-selected-text", decision: "completed", file: path.basename(filePath) });
  return { opened: true };
});

ipcMain.on("vishu:cancel-stream", (event, streamId) => {
  try { trustedOwner(event); } catch (_error) { return; }
  if (typeof streamId !== "string") return;
  const key = event.sender.id + ":" + streamId;
  activeStreams.get(key)?.abort();
});

ipcMain.handle("vishu:chat-stream", async (event, input) => {
  trustedOwner(event);
  if (!input || typeof input.streamId !== "string" || input.streamId.length > 80 ||
      !input.body || typeof input.body !== "object" ||
      !isAllowedRequest("POST", "/api/chat/stream") || !backendPort) {
    throw new Error("This streaming action is not authorized.");
  }
  const key = event.sender.id + ":" + input.streamId;
  if (activeStreams.has(key)) throw new Error("A stream with this ID is already active.");
  const controller = new AbortController();
  activeStreams.set(key, controller);
  const timeout = setTimeout(() => controller.abort(), 80000);
  try {
    const response = await fetch("http://127.0.0.1:" + backendPort + "/api/chat/stream", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + sessionToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(typeof payload.detail === "string" ? payload.detail : "VISHU streaming request failed.");
    }
    if (!response.body) throw new Error("VISHU did not provide a response stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const sendFrame = (frame) => {
      const line = frame.split(/\r?\n/).find((part) => part.startsWith("data:"));
      if (!line) return;
      const message = JSON.parse(line.slice(5).trim());
      if (!event.sender.isDestroyed()) {
        event.sender.send("vishu:chat-stream-event", { streamId: input.streamId, ...message });
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value || new Uint8Array(), { stream: !done });
      const frames = buffered.split(/\r?\n\r?\n/);
      buffered = frames.pop() || "";
      frames.forEach(sendFrame);
      if (done) {
        if (buffered.trim()) sendFrame(buffered);
        break;
      }
    }
    return { complete: true };
  } catch (error) {
    if (controller.signal.aborted) return { complete: false, cancelled: true };
    throw error;
  } finally {
    clearTimeout(timeout);
    if (activeStreams.get(key) === controller) activeStreams.delete(key);
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 810,
    minWidth: 720,
    minHeight: 550,
    backgroundColor: "#080e1c",
    title: "VISHU",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow = window;
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  registerMediaHandlers({
    session: window.webContents.session,
    window,
    dialog,
    logError: (label, error) => process.stderr.write(
      "[VISHU media] " + label + ": " + String(error?.message || error) + "\n"
    )
  });
  const devUrl = "http://127.0.0.1:5173";
  window.webContents.on("will-navigate", (event, target) => {
    if (!app.isPackaged && target.startsWith(devUrl + "/")) return;
    event.preventDefault();
  });
  if (app.isPackaged) {
    window.loadFile(path.resolve(__dirname, "..", "dist", "index.html"));
  } else {
    window.loadURL(devUrl);
  }
}

if (isPrimaryInstance) app.whenReady().then(async () => {
  try {
    await startBackend();
    createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "VISHU could not start",
      String(error && error.message ? error.message : error) +
      (app.isPackaged
        ? "\n\nRestart VISHU and verify your local model service is available."
        : "\n\nInstall Python dependencies and verify VISHU_PYTHON.")
    );
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

if (!isPrimaryInstance) app.quit();

app.on("before-quit", () => {
  for (const controller of activeStreams.values()) controller.abort();
  activeStreams.clear();
  if (backend && backend.exitCode === null) {
    backend.kill();
  }
});
