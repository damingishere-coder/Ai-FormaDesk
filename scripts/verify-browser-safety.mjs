// Negative checks: each intentionally invalid test/config must be rejected.
// No backend, AI, Blender, or user DATA is opened by this verifier.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "formadesk-browser-guards-"));
const liveData = fs.mkdtempSync(path.join(os.tmpdir(), "formadesk-live-guard-"));
const cli = path.join(root, "node_modules/@playwright/test/cli.js");
const results = [];
function check(name, args, env, expected, accepted = false) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = (run.stdout || "") + (run.stderr || "");
  const messages = Array.isArray(expected) ? expected : [expected];
  if (run.error || (accepted ? run.status !== 0 : run.status === 0) || !messages.every(message => output.includes(message)))
    throw new Error(`${name} 没有按预期拒绝/接受：\n${output}\n${run.error || ""}`);
  results.push({ name, exitCode: run.status, expected });
}

try {
  check("live 需要 opt-in", ["test", "--config", "playwright.live.config.ts", "--list"],
    { FORMA_LIVE_TESTS: "0" }, "必须显式设置 FORMA_LIVE_TESTS=1");
  check("live 拒绝源码/用户数据目录", ["test", "--config", "playwright.live.config.ts", "--list"],
    { FORMA_LIVE_TESTS: "1", FORMA_LIVE_DATA_DIR: root, FORMA_LIVE_URL: "http://127.0.0.1:19145" }, "必须是系统临时目录内独立");
  check("live 拒绝日常服务端口", ["test", "--config", "playwright.live.config.ts", "--list"],
    { FORMA_LIVE_TESTS: "1", FORMA_LIVE_DATA_DIR: liveData, FORMA_LIVE_URL: "http://127.0.0.1:8765" }, "不能指向常用服务或 mock Vite");
  check("独立 live 配置可收集但不执行", ["test", "--config", "playwright.live.config.ts", "--list"],
    { FORMA_LIVE_TESTS: "1", FORMA_LIVE_DATA_DIR: liveData, FORMA_LIVE_URL: "http://127.0.0.1:19145", FORMA_REAL_AI: "0" }, "Listing tests:", true);

  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const configFile = path.join(temporary, "playwright.config.ts");
  const testFile = path.join(temporary, "guard.spec.ts");
  fs.writeFileSync(configFile, `import config from ${JSON.stringify(path.join(root, "playwright.config.ts"))};
export default { ...config, webServer: { ...config.webServer, cwd: ${JSON.stringify(root)} }, testDir: ${JSON.stringify(temporary)}, testMatch: "guard.spec.ts", grepInvert: undefined,
 outputDir: ${JSON.stringify(path.join(temporary, "results"))}, reporter: "line" };
`);
  fs.writeFileSync(testFile, `import { test, expect } from ${JSON.stringify(path.join(root, "tests/browser/fixtures"))};
test.beforeEach(async ({ page }) => {
 await page.route("**/api/projects", route => route.fulfill({ json: [] }));
 await page.goto("/");
});
test("未 mock API 即使调用者捕获错误也失败", async ({ page }) => {
 await page.evaluate(() => fetch("/api/unmocked-guard-probe", { method: "POST" }).catch(() => null));
});
test("直接 page.request 即使调用者捕获错误也失败", async ({ page }) => {
 await expect(page.request.post("/api/direct-guard-probe")).rejects.toThrow("不得使用");
});
test("route.continue 仍无法访问真实后台", async ({ page }) => {
 await page.route("**/api/bypass-guard-probe", route => route.continue());
 const status = await page.evaluate(async () => (await fetch("/api/bypass-guard-probe")).status);
 expect(status).toBe(599);
});
test("外部 API 即使调用者捕获错误也失败", async ({ page }) => {
 await page.evaluate(() => fetch("https://example.invalid/api/external-guard-probe").catch(() => null));
});
test("独立 request fixture 不可逃逸", async ({ request }) => {
 await request.post("/api/independent-guard-probe");
});
`);
  check("网络/API mock 护栏", ["test", "--config", configFile],
    { FORMA_MOCK_PORT: String(port) }, ["5 failed", "未 mock 的 API POST /api/unmocked-guard-probe", "不得使用 page.request/context.request", "绕过 mock 的 API /api/bypass-guard-probe", "外部请求 GET https://example.invalid/api/external-guard-probe", "不得使用独立 request fixture"]);
  console.log(JSON.stringify({ ok: true, results }, null, 2));
  console.log("BROWSER_SAFETY_GUARDS_PASSED");
} finally {
  // These directories were created by this verifier; no other DATA is touched.
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.rmSync(liveData, { recursive: true, force: true });
}
