import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Live tests own a dedicated temporary DATA; they never attach to an app. */
export function liveEnvironment() {
  if (process.env.FORMA_LIVE_TESTS !== "1")
    throw new Error("真实浏览器验收必须显式设置 FORMA_LIVE_TESTS=1；默认入口只允许 mock");
  const configured = process.env.FORMA_LIVE_DATA_DIR;
  if (!configured || !path.isAbsolute(configured) || !fs.existsSync(configured))
    throw new Error("请用 mktemp -d 创建独立 formadesk-live-* 临时目录并设置 FORMA_LIVE_DATA_DIR");
  const stat = fs.lstatSync(configured);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error("FORMA_LIVE_DATA_DIR 必须是实际目录，不能是符号链接或文件");
  const dataDir = fs.realpathSync(configured);
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  if (!dataDir.startsWith(temporaryRoot + path.sep) || !path.basename(dataDir).startsWith("formadesk-live-"))
    throw new Error("FORMA_LIVE_DATA_DIR 必须是系统临时目录内独立的 formadesk-live-* 目录");
  const baseURL = process.env.FORMA_LIVE_URL;
  if (!baseURL) throw new Error("请显式设置独立后端 FORMA_LIVE_URL，如 http://127.0.0.1:19145");
  const url = new URL(baseURL);
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash || !Number.isInteger(port) || port < 1024 || port > 65535 ||
      [8765, 5173, Number(process.env.FORMA_MOCK_PORT || 19143)].includes(port))
    throw new Error("FORMA_LIVE_URL 必须使用 127.0.0.1 独立端口，不能指向常用服务或 mock Vite");
  return { dataDir, baseURL: url.origin, port };
}
