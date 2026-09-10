import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ROOT, DATA, BLENDER, PORT } from "../server/config";
const uninstall = process.argv.includes("--uninstall");
const runtime = path.join(DATA, "project-library");
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
const scripts = execFileSync(
  BLENDER,
  [
    "--background",
    "--disable-autoexec",
    "--python-expr",
    "import bpy; print('FORMA_SCRIPTS='+bpy.utils.user_resource('SCRIPTS'))",
  ],
  { encoding: "utf8" },
)
  .match(/FORMA_SCRIPTS=(.+)/)?.[1]
  .trim();
if (!scripts) throw new Error("无法确定 Blender 用户插件目录");
const target = path.join(scripts, "addons", "forma_project_library");
const prefs = path.resolve(scripts, "../config/userpref.blend");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (fs.existsSync(prefs))
  fs.copyFileSync(prefs, path.join(runtime, `preferences-${stamp}.blend`));
if (!uninstall) {
  if (fs.existsSync(target))
    fs.cpSync(target, path.join(runtime, `addon-backup-${stamp}`), {
      recursive: true,
    });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, "blender/forma_project_library/__init__.py"),
    path.join(target, "__init__.py"),
  );
  const config = {
    version: 1,
    cache: path.join(runtime, "index.json"),
    baseUrl: `http://127.0.0.1:${PORT}`,
    launcher: fs.existsSync(
      path.join(os.homedir(), "Applications/Ai-FormaDesk.app"),
    )
      ? path.join(os.homedir(), "Applications/Ai-FormaDesk.app")
      : path.join(ROOT, "启动 Ai-FormaDesk.command"),
  };
  fs.writeFileSync(path.join(target, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(runtime, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
}
const script = path.join(runtime, uninstall ? "disable.py" : "enable.py");
fs.writeFileSync(
  script,
  `import bpy, addon_utils, json\nbefore=list(bpy.context.preferences.addons.keys())\naddon_utils.${uninstall ? "disable" : "enable"}('forma_project_library', default_set=True${uninstall ? "" : ", persistent=True"})\nbpy.ops.wm.save_userpref()\nprint('FORMA_LIBRARY_SETUP',json.dumps({'before':before,'after':list(bpy.context.preferences.addons.keys())}))\n`,
);
const output = execFileSync(
  BLENDER,
  [
    "--background",
    "--disable-autoexec",
    "--python-exit-code",
    "1",
    "--python",
    script,
  ],
  { encoding: "utf8" },
);
console.log(output);
if (uninstall) fs.rmSync(target, { recursive: true, force: true });
console.log(
  uninstall
    ? "已卸载作品入口；其他设置保留。"
    : `已安装 FormaDesk 我的作品：${target}`,
);
