import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "forma-desktop-smoke-"));
// Test distribution portability: Node must not find missing packages in a
// source checkout above the application directory.
let packagedExecutable;
if (process.env.FORMA_DESKTOP_EXECUTABLE) {
  const source = path.resolve(process.env.FORMA_DESKTOP_EXECUTABLE);
  const appRoot = source.slice(0, source.indexOf(".app/") + 4);
  assert.ok(
    source.includes(".app/Contents/MacOS/"),
    "Expected a macOS app executable",
  );
  const isolatedApp = path.join(home, path.basename(appRoot));
  execFileSync("/usr/bin/ditto", [appRoot, isolatedApp]);
  packagedExecutable = path.join(isolatedApp, path.relative(appRoot, source));
}
const evidence = path.join(root, "build/desktop-evidence");
fs.mkdirSync(evidence, { recursive: true });
const data = path.join(home, "data");
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    path.join(root, "scripts/desktop-fixture.ts"),
  ],
  {
    cwd: root,
    env: { ...process.env, ZAOWU_DATA_DIR: data },
    stdio: "inherit",
    timeout: 180000,
  },
);
const fixture = JSON.parse(
  fs.readFileSync(path.join(data, "fixture.json"), "utf8"),
);
let instance, backendPid, baseURL;
const errors = [];
const checks = [];
async function launch() {
  instance = await electron.launch({
    ...(packagedExecutable
      ? { executablePath: packagedExecutable, args: [] }
      : { args: [root] }),
    cwd: packagedExecutable ? home : root,
    env: {
      ...process.env,
      FORMA_DESKTOP_TEST_HOME: home,
      ...(process.env.FORMA_DESKTOP_MINIMAL_PATH
        ? { PATH: "/usr/bin:/bin" }
        : {}),
    },
    timeout: 45000,
  });
  const page = await instance.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForURL("http://127.0.0.1:*/", { timeout: 45000 });
  baseURL = new URL(page.url()).origin;
  await page.evaluate(
    (id) => localStorage.setItem("forma-project", id),
    fixture.pid,
  );
  await page.reload();
  await expect(page.locator("canvas").first()).toBeVisible({ timeout: 30000 });
  await expect(
    page.getByRole("button", { name: "午后工作角", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  backendPid = JSON.parse(
    fs.readFileSync(path.join(data, ".desktop-owner.json"), "utf8"),
  ).pid;
  return page;
}
try {
  let page = await launch();
  checks.push("独立窗口加载真实 GLB");
  const preferences = await instance.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows()[0];
    const p = w.webContents.getLastWebPreferences();
    return {
      node: p.nodeIntegration,
      isolated: p.contextIsolation,
      sandbox: p.sandbox,
      packaged: app.isPackaged,
    };
  });
  assert.deepEqual(
    [preferences.node, preferences.isolated, preferences.sandbox],
    [false, true, true],
  );
  checks.push("界面 Node 禁用、上下文隔离、沙箱启用");
  assert.equal((await fetch(baseURL + "/api/session")).status, 403);
  checks.push("外部浏览器无法建立桌面会话");
  const health = await page.evaluate(async () => {
    for (let i = 0; i < 120; i++) {
      const h = await (await fetch("/api/health")).json();
      if (!h.checking) return h;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("environment timeout");
  });
  assert.equal(health.blender.ok, true);
  assert.equal(health.sandbox.ok, true);
  checks.push("打包资源路径下 Blender 与执行/渲染沙箱通过");
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(evidence, "desktop.png") });
  const screenshot = await instance.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  fs.writeFileSync(
    path.join(evidence, "window.png"),
    Buffer.from(screenshot, "base64"),
  );
  const exportPath = path.join(home, "downloaded-scene.glb");
  await instance.evaluate(({ session }, file) => {
    session
      .fromPartition("forma-desktop")
      .on("will-download", (_e, item) => item.setSavePath(file));
  }, exportPath);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("tab", { name: "模型" }).click();
  const link = page.locator(`a[href*="${fixture.artifacts.glb}"]`);
  // The model selector may initially show .blend.
  if (!(await link.count()))
    await page.getByRole("radio", { name: /GLB/i }).check();
  await page.locator(`a[href*="${fixture.artifacts.glb}"]`).click();
  await expect
    .poll(
      () => (fs.existsSync(exportPath) ? fs.statSync(exportPath).size : 0),
      { timeout: 15000 },
    )
    .toBeGreaterThan(100);
  assert.equal(fs.readFileSync(exportPath).subarray(0, 4).toString(), "glTF");
  checks.push("真实 GLB 原生下载流程完成");
  await page.screenshot({ path: path.join(evidence, "export.png") });
  if (process.env.FORMA_DESKTOP_FULL === "1") {
    const blendPath = path.join(home, "downloaded-scene.blend");
    await instance.evaluate(({ session }, file) => {
      session
        .fromPartition("forma-desktop")
        .on("will-download", (_e, item) => item.setSavePath(file));
    }, blendPath);
    await page.getByRole("radio", { name: /Blender 源文件/ }).check();
    await page.getByRole("link", { name: "下载模型 · .blend" }).click();
    await expect
      .poll(
        () => (fs.existsSync(blendPath) ? fs.statSync(blendPath).size : 0),
        { timeout: 15000 },
      )
      .toBeGreaterThan(100);
    assert.equal(
      fs.readFileSync(blendPath).subarray(0, 7).toString(),
      "BLENDER",
    );
    checks.push("真实 Blender 源文件下载完成");
    await page.getByRole("tab", { name: "图片", exact: true }).click();
    await page.getByLabel("图片宽度").fill("512");
    await page.getByLabel("图片高度").fill("512");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await expect(page.getByRole("link", { name: "下载原图" })).toBeVisible({
      timeout: 180000,
    });
    const pngPath = path.join(home, "render.png");
    await instance.evaluate(({ session }, file) => {
      session
        .fromPartition("forma-desktop")
        .on("will-download", (_e, item) => item.setSavePath(file));
    }, pngPath);
    await page.getByRole("link", { name: "下载原图" }).click();
    await expect
      .poll(() => (fs.existsSync(pngPath) ? fs.statSync(pngPath).size : 0), {
        timeout: 15000,
      })
      .toBeGreaterThan(100);
    assert.equal(fs.readFileSync(pngPath).subarray(1, 4).toString(), "PNG");
    checks.push("真实 Blender 512×512 PNG 渲染与下载完成");
    await page.screenshot({ path: path.join(evidence, "image-export.png") });
    await page.getByRole("tab", { name: "视频", exact: true }).click();
    await page.getByLabel("视频宽度").fill("640");
    await page.getByLabel("视频高度").fill("360");
    await page.getByRole("button", { name: "进入录制模式" }).click();
    await page.getByRole("button", { name: "开始录制", exact: true }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "停止录制", exact: true }).click();
    const result = page.getByRole("dialog", { name: "录制结果" });
    await expect(result).toBeVisible();
    await expect
      .poll(() =>
        result.locator("video").evaluate((v) => [v.videoWidth, v.videoHeight]),
      )
      .toEqual([640, 360]);
    await result
      .getByRole("button", { name: "保存到作品", exact: true })
      .click();
    await expect(
      result.getByRole("button", { name: "已保存到作品" }),
    ).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "退出录制模式" }).click();
    const videoPath = path.join(home, "recording.webm");
    await instance.evaluate(({ session }, file) => {
      session
        .fromPartition("forma-desktop")
        .on("will-download", (_e, item) => item.setSavePath(file));
    }, videoPath);
    await page.getByRole("link", { name: "下载视频", exact: true }).click();
    await expect
      .poll(
        () => (fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0),
        { timeout: 15000 },
      )
      .toBeGreaterThan(1000);
    checks.push("桌面 Canvas 640×360 实时录制、保存到作品与原生下载完成");
  }
  await instance.close();
  instance = null;
  await expect
    .poll(
      () => {
        try {
          process.kill(backendPid, 0);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 15000 },
    )
    .toBe(false);
  assert.equal(fs.existsSync(path.join(data, ".desktop-owner.json")), false);
  checks.push("退出释放后台进程与数据锁");
  page = await launch();
  checks.push("重启后作品与模型恢复");
  assert.equal(errors.length, 0, errors.join("\n"));
  await instance.close();
  instance = null;
  fs.writeFileSync(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: true,
        packaged: preferences.packaged,
        isolatedApp: packagedExecutable || null,
        checks,
        health: {
          blender: health.blender.ok,
          sandbox: health.sandbox.ok,
          codex: health.codex.ok,
        },
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      { passed: true, packaged: preferences.packaged, checks },
      null,
      2,
    ),
  );
} catch (e) {
  fs.writeFileSync(path.join(evidence, "failure.txt"), String(e.stack));
  if (instance) {
    try {
      await (
        await instance.firstWindow()
      ).screenshot({ path: path.join(evidence, "failure.png") });
    } catch {}
  }
  throw e;
} finally {
  if (instance) await instance.close();
  console.log("Test data retained for diagnosis:", home);
}
