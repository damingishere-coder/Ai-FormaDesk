import path from "node:path";
import os from "node:os";
import fs from "node:fs";
export const ROOT = path.resolve(import.meta.dirname, "..");
const configuredData = path.resolve(
  process.env.ZAOWU_DATA_DIR || path.join(ROOT, "data"),
);
fs.mkdirSync(configuredData, { recursive: true, mode: 0o700 });
export const DATA = fs.realpathSync(configuredData);
export const BLENDER =
  process.env.ZAOWU_BLENDER ||
  "/Applications/Blender 4.5 LTS.app/Contents/MacOS/Blender";
export const CODEX =
  process.env.ZAOWU_CODEX ||
  (fs.existsSync(path.join(os.homedir(), ".local/bin/codex"))
    ? path.join(os.homedir(), ".local/bin/codex")
    : "codex");
export const PORT = Number(process.env.ZAOWU_PORT || 8765);
export const MODEL = "gpt-6-astra";
export const EFFORT = "high";
export function limits() {
  const file = path.join(DATA, "settings.json");
  const v = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  return {
    modelingMs:
      Math.min(600, Math.max(10, Number(v.modelingSeconds) || 120)) * 1000,
    renderingMs:
      Math.min(900, Math.max(10, Number(v.renderingSeconds) || 180)) * 1000,
  };
}
