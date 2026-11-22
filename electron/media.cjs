"use strict";

function registerMediaHandlers({ session, window, dialog, logError = () => {} }) {
  const ownsRequest = (webContents) => Boolean(
    webContents && !webContents.isDestroyed() && webContents === window.webContents
  );
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler(async (webContents, permission, callback, details = {}) => {
    if (!ownsRequest(webContents)) return callback(false);
    if (permission !== "media" || !details.mediaTypes?.includes("audio")) {
      return callback(false);
    }

    try {
      const answer = await dialog.showMessageBox(window, {
        type: "question",
        buttons: ["Allow microphone", "Deny"],
        defaultId: 1,
        cancelId: 1,
        title: "Microphone access",
        message: "Allow VISHU to use your microphone for this recording?"
      });
      callback(answer.response === 0);
    } catch (error) {
      logError("Microphone permission prompt failed", error);
      callback(false);
    }
  });

}

async function captureSelectedScreen({ event, window, dialog, desktopCapturer, logError = () => {} }) {
  if (!window?.webContents || !event || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("Screen capture can only be requested by VISHU's main window.");
  }
  const consent = await dialog.showMessageBox(window, {
    type: "question",
    buttons: ["Choose a screen or window", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Allow screen understanding?",
    message: "VISHU will make temporary previews so you can choose one screen or window. Only the image you select will be sent to your configured vision model for this request."
  });
  if (consent.response !== 0) return null;

  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1600, height: 900 },
      fetchWindowIcons: false
    });
    if (!sources.length) return null;
    const answer = await dialog.showMessageBox(window, {
      type: "question",
      buttons: [...sources.map((source) => source.name), "Cancel"],
      defaultId: sources.length,
      cancelId: sources.length,
      title: "Choose what VISHU may view",
      message: "Choose one source. Only its still image will be shared for this request."
    });
    const source = answer.response >= 0 && answer.response < sources.length
      ? sources[answer.response]
      : null;
    if (!source?.thumbnail || source.thumbnail.isEmpty()) return null;
    return { image_data_url: source.thumbnail.toDataURL() };
  } catch (error) {
    logError("Screen capture selection failed", error);
    throw new Error("Windows could not create a preview of the selected screen or window.");
  }
}

module.exports = { captureSelectedScreen, registerMediaHandlers };
