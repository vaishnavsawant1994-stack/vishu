"use strict";

const { spawn } = require("node:child_process");

/**
 * Terminate the whole frozen PyInstaller process tree on Windows.
 * This covers the frozen process and any subprocesses while keeping
 * the API and SQLite handles from lingering. The caller owns the process.
 */
function stopBackendProcess(backend, { platform = process.platform, launcher = spawn } = {}) {
  if (!backend || !Number.isInteger(backend.pid)) return false;
  if (platform !== "win32") {
    if (backend.exitCode === null) backend.kill();
    return true;
  }
  try {
    const killer = launcher("taskkill", ["/PID", String(backend.pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    killer.on("error", () => {
      try { backend.kill(); } catch (_ignored) {}
    });
    killer.unref();
  } catch (_error) {
    try { backend.kill(); } catch (_ignored) {}
  }
  return true;
}

module.exports = { stopBackendProcess };
