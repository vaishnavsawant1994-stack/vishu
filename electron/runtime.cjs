"use strict";

const path = require("node:path");

function resolveVoskModelPath({ env = process.env, packaged, resourcesPath }) {
  const configured = env.VISHU_VOSK_MODEL_PATH;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return packaged ? path.join(resourcesPath, "vosk-model") : "";
}

module.exports = { resolveVoskModelPath };
