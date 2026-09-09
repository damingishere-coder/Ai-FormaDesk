import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockDesktopData } from "../server/data-lock";
const require = createRequire(import.meta.url);
const { sameOrigin, safeExternal } = require("../desktop/policy.cjs");
describe("desktop navigation boundaries", () => {
  it("checks parsed origins rather than string prefixes", () => {
    expect(
      sameOrigin("http://127.0.0.1:4567/api/projects", "http://127.0.0.1:4567"),
    ).toBe(true);
    for (const url of [
      "http://127.0.0.1:4567@evil.example",
      "http://127.0.0.1:45678/",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ])
      expect(sameOrigin(url, "http://127.0.0.1:4567")).toBe(false);
  });
  it("only sends ordinary HTTPS links to the external browser", () => {
    expect(
      safeExternal("https://github.com/damingishere-coder/Ai-FormaDesk"),
    ).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:password@example.com",
      "custom:run",
      "http://example.com",
    ])
      expect(safeExternal(url)).toBe(false);
  });
});
it("refuses a second live backend and releases its own directory lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forma-desktop-lock-"));
  try {
    const release = lockDesktopData(dir);
    expect(() => lockDesktopData(dir)).toThrow(/另一个/);
    release();
    const releaseAgain = lockDesktopData(dir);
    releaseAgain();
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
