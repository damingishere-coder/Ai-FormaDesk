import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, "data/blender-mcp-runtime");
fs.mkdirSync(runtime, { recursive: true });
const run = (
  command: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
) => {
  const r = spawnSync(command, args, {
    cwd: runtime,
    stdio: "inherit",
    env: { ...process.env, UV_SYSTEM_CERTS: "true", ...extra },
  });
  if (r.status !== 0)
    throw new Error(`${path.basename(command)} 安装失败（退出码 ${r.status}）`);
};
const uv = path.join(runtime, "bin/uv");
if (!fs.existsSync(uv)) {
  const r = await fetch("https://astral.sh/uv/0.12.10/install.sh");
  if (!r.ok) throw new Error("下载 uv 安装器失败");
  const file = path.join(runtime, "uv-install.sh");
  fs.writeFileSync(file, await r.text());
  run("/bin/sh", [file], {
    UV_INSTALL_DIR: path.join(runtime, "bin"),
    UV_NO_MODIFY_PATH: "1",
  });
}
const python = path.join(runtime, "venv/bin/python");
const existingPython = [
  "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12",
  "/Applications/Blender 4.5 LTS.app/Contents/Resources/4.5/python/bin/python3.11",
].find((p) => fs.existsSync(p));
if (!fs.existsSync(python))
  run(uv, [
    "venv",
    "--python",
    existingPython || "3.11",
    path.join(runtime, "venv"),
  ]);
run(uv, [
  "pip",
  "install",
  "--no-config",
  "--default-index",
  "https://pypi.org/simple",
  "--python",
  python,
  "blender-mcp==1.9.1",
]);
const addon = path.join(runtime, "addons/blender_mcp.py");
fs.mkdirSync(path.dirname(addon), { recursive: true });
run(python, [
  "-c",
  "import importlib.resources,shutil,sys; shutil.copyfile(str(importlib.resources.files('blender_mcp')/'bundled'/'addon.py'),sys.argv[1])",
  addon,
]);
const hash = createHash("sha256").update(fs.readFileSync(addon)).digest("hex");
if (hash !== "f43469c8518c7021e0060e32cfe52e3beb126b0f62fbae7293106642a3ebda89")
  throw new Error("发布包插件与已核对的 GitHub 版本不同，停止接入");
fs.writeFileSync(
  path.join(runtime, "runtime.json"),
  JSON.stringify(
    {
      version: "1.9.1",
      commit: "5f8ddaf6e987c4aa0c3467fcc548838b28f64477",
      python,
      addon,
      addonSha256: hash,
    },
    null,
    2,
  ),
);
console.log(
  "Blender MCP 1.9.1 已安装到工作台独立目录；没有修改全局 Codex 或 Blender 配置。",
);
