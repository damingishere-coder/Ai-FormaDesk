import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LiveEnvironment = { dataDir: string; baseURL?: string };

/** Call before importing a DATA writer, launching tools, or making requests. */
export function requireLiveEnvironment(options: { ai?: boolean; http?: boolean } = {}): LiveEnvironment {
  if (process.env.FORMA_LIVE_TESTS !== "1")
    throw new Error("真实验收脚本必须显式设置 FORMA_LIVE_TESTS=1；未加载后台或执行真实工具。");
  const configured = process.env.ZAOWU_DATA_DIR;
  if (!configured || !path.isAbsolute(configured) || !fs.existsSync(configured))
    throw new Error("请用 mktemp -d 创建新隔离目录，并设置绝对路径 ZAOWU_DATA_DIR。");
  const stat = fs.lstatSync(configured);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("ZAOWU_DATA_DIR 必须是实际目录，不能是符号链接或文件。");
  const dataDir = fs.realpathSync(configured);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (!dataDir.startsWith(temporaryRoot + path.sep) || !path.basename(dataDir).startsWith("formadesk-live-"))
    throw new Error("ZAOWU_DATA_DIR 必须是系统临时目录内独立的 formadesk-live-* 目录；不能使用源码或用户作品。");
  if (options.ai && process.env.FORMA_REAL_AI !== "1")
    throw new Error("该脚本会调用真实 AI，还必须显式设置 FORMA_REAL_AI=1。");
  if (!options.http) return { dataDir };
  const configuredURL = process.env.FORMA_LIVE_URL;
  if (!configuredURL) throw new Error("HTTP/浏览器脚本必须显式设置独立后台 FORMA_LIVE_URL。");
  const url = new URL(configuredURL);
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      [8765, 5173, Number(process.env.FORMA_MOCK_PORT || 19143)].includes(port))
    throw new Error("FORMA_LIVE_URL 必须使用 127.0.0.1 的独立端口，不能使用 8765/5173 或 mock Vite。");
  // The URL alone does not establish which DATA a running backend owns. Its
  // public local cache must bind this exact test directory to this exact origin.
  const cacheFile = path.join(dataDir, "project-library", "index.json");
  if (!fs.existsSync(cacheFile))
    throw new Error("隔离后台尚未就绪：先用同一 ZAOWU_DATA_DIR 和独立 ZAOWU_PORT 启动源码后台。");
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  if (cache.dataRoot !== dataDir || cache.baseUrl !== url.origin)
    throw new Error("FORMA_LIVE_URL 与 ZAOWU_DATA_DIR 的后台记录不匹配，已拒绝连接。");
  return { dataDir, baseURL: url.origin };
}
