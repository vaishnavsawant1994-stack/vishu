"use strict";

/**
 * Enforce one VISHU desktop process per user data directory and focus the
 * existing window when the shortcut or installer is launched twice.
 */
function registerSingleInstance(app, getWindow) {
  if (!app.requestSingleInstanceLock()) return false;
  app.on("second-instance", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}

module.exports = { registerSingleInstance };
