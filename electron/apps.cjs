"use strict";

const { spawn } = require("node:child_process");

const APPLICATIONS = Object.freeze({
  notepad: Object.freeze({ label: "Notepad", executable: "notepad.exe" }),
  calculator: Object.freeze({ label: "Calculator", executable: "calc.exe" }),
  explorer: Object.freeze({ label: "File Explorer", executable: "explorer.exe" })
});

function resolveApplication(id) {
  if (typeof id !== "string" || !Object.hasOwn(APPLICATIONS, id)) return null;
  return APPLICATIONS[id];
}

function launchAllowedApplication(id, { platform = process.platform, launcher = spawn } = {}) {
  const application = resolveApplication(id);
  if (platform !== "win32" || !application) {
    return Promise.reject(new Error("This Windows application is not allowed."));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = launcher(application.executable, [], {
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("spawn", () => {
      child.unref();
      resolve({ launched: true });
    });
    child.once("error", reject);
  });
}

module.exports = { resolveApplication, launchAllowedApplication };
