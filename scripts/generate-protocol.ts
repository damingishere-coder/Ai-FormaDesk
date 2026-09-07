import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CODEX, ROOT } from "../server/config";
import { runProcess } from "../server/process";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "forma-protocol-"));
const r = await runProcess(CODEX, ["app-server", "generate-ts", "--out", out]);
if (r.code !== 0) throw new Error(r.stderr || "官方协议生成失败");
const files = new Set<string>();
function visit(rel: string) {
  if (files.has(rel)) return;
  const file = path.join(out, rel);
  const text = fs.readFileSync(file, "utf8");
  files.add(rel);
  for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g))
    visit(path.normalize(path.join(path.dirname(rel), m[1])) + ".ts");
}
visit("v2/ThreadStartParams.ts");
visit("v2/TurnStartParams.ts");
const target = path.join(ROOT, "server/protocol");
function clean(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) clean(p);
    else if (
      entry.name.endsWith(".ts") &&
      fs.readFileSync(p, "utf8").includes("GENERATED CODE!")
    )
      fs.rmSync(p);
  }
}
clean(target);
for (const rel of files) {
  fs.mkdirSync(path.dirname(path.join(target, rel)), { recursive: true });
  fs.copyFileSync(path.join(out, rel), path.join(target, rel));
}
fs.rmSync(out, { recursive: true });
console.log(`已从官方 CLI 生成 ${files.size} 个实际依赖的协议文件。`);
