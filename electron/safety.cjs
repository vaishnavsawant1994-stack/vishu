"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".log"]);

function isAllowedTextFile(filePath, stat, maxBytes = 100_000) {
  return Boolean(
    typeof filePath === "string" &&
    stat &&
    stat.isFile() &&
    stat.size <= maxBytes &&
    TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

function appendActionAudit(userDataPath, event) {
  const auditPath = path.join(userDataPath, "audit", "actions.jsonl");
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, JSON.stringify({
    at: new Date().toISOString(),
    ...event
  }) + "\n", { encoding: "utf8", mode: 0o600 });
}

module.exports = { isAllowedTextFile, appendActionAudit };
