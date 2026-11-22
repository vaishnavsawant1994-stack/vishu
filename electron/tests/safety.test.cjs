"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isAllowedTextFile, appendActionAudit } = require("../safety.cjs");

test("Windows action accepts only small plain text files", () => {
  const regular = { isFile: () => true, size: 99_999 };
  assert.equal(isAllowedTextFile("C:\\Users\\Vishu\\note.md", regular), true);
  assert.equal(isAllowedTextFile("C:\\Users\\Vishu\\script.ps1", regular), false);
  assert.equal(isAllowedTextFile("C:\\Users\\Vishu\\large.txt", { isFile: () => true, size: 100_001 }), false);
  assert.equal(isAllowedTextFile("C:\\Users\\Vishu\\folder.txt", { isFile: () => false, size: 1 }), false);
});

test("action audit stores append-only local JSON records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vishu-audit-"));
  try {
    appendActionAudit(root, { action: "open-selected-text", decision: "authorized", file: "notes.txt" });
    appendActionAudit(root, { action: "open-selected-text", decision: "completed", file: "notes.txt" });
    const lines = fs.readFileSync(path.join(root, "audit", "actions.jsonl"), "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).decision), ["authorized", "completed"]);
    assert.equal(lines.join("").includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
