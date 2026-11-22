"use strict";

const { app, BrowserWindow, ipcMain, dialog, desktopCapturer } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");

let backend = null;
let backendPort = null;
let backendFailure = null;
const sessionToken = randomBytes(32).toString("hex");

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
      route === "/api/transcribe" || route === "/api/screen";
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
        VISHU_DB_PATH: path.join(dataDir, "vishu.sqlite3")
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
          VISHU_DB_PATH: path.join(dataDir, "vishu.sqlite3")
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

ipcMain.handle("vishu:api", async (_event, input) => {
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
  const owner = BrowserWindow.fromWebContents(event.sender);
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

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler(async (_webContents, permission, callback) => {
    if (permission !== "media") return callback(false);
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      buttons: ["Allow microphone", "Deny"],
      defaultId: 1,
      cancelId: 1,
      title: "Microphone access",
      message: "Allow VISHU to use your microphone for this recording?"
    });
    callback(answer.response === 0);
  });
  window.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const answer = await dialog.showMessageBox(window, {
        type: "question",
        buttons: [...sources.map((source) => source.name), "Cancel"],
        defaultId: sources.length,
        cancelId: sources.length,
        title: "Choose what VISHU may view",
        message: "Choose one screen or window. VISHU captures one still image and sends it to your configured model for this request only."
      });
      const source = sources[answer.response];
      callback(source ? { video: source } : {});
    } catch (_error) {
      callback({});
    }
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

app.whenReady().then(async () => {
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

app.on("before-quit", () => {
  if (backend && backend.exitCode === null) {
    backend.kill();
  }
});
