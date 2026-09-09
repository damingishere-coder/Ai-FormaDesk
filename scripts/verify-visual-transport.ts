import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { visualRequest } from "../server/visual-ai";
import { DATA } from "../server/config";
const root = path.resolve("data/visual-transport-proof");
fs.mkdirSync(root, { recursive: true });
const results = [];
for (const mode of ["cancel", "timeout"]) {
  const ctrl = new AbortController();
  const timer =
    mode === "cancel" ? setTimeout(() => ctrl.abort(), 4000) : undefined;
  const start = Date.now();
  let error = "";
  try {
    await visualRequest({
      cwd: root,
      prompt: "用 JSON 说明正交视图，不生成图片。",
      images: [],
      signal: ctrl.signal,
      timeoutMs: mode === "timeout" ? 100 : 30000,
      schema: {
        type: "object",
        properties: { explanation: { type: "string" } },
        required: ["explanation"],
        additionalProperties: false,
      },
    });
  } catch (e) {
    error = (e as Error).message;
  } finally {
    clearTimeout(timer);
  }
  assert.match(error, mode === "cancel" ? /取消/ : /时限/);
  const records = path.join(DATA, "runtime-processes");
  const remaining = fs.existsSync(records)
    ? fs
        .readdirSync(records)
        .filter((n) => n.endsWith(".json"))
        .map((n) => JSON.parse(fs.readFileSync(path.join(records, n), "utf8")))
        .filter((r) => r.cwd === root)
    : [];
  assert.equal(remaining.length, 0);
  results.push({
    mode,
    error,
    elapsedMs: Date.now() - start,
    remainingProcesses: remaining.length,
  });
}
fs.writeFileSync(
  path.join(root, "results.json"),
  JSON.stringify(results, null, 2),
);
console.log(JSON.stringify(results));
