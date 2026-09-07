import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const base = "http://127.0.0.1:18878",
  out = path.resolve("data/v3-evidence");
fs.mkdirSync(out, { recursive: true });
async function api(page: Page, route: string, body?: unknown) {
  return page.evaluate(
    async ({ route, body }) => {
      const { token } = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + route, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forma-Session": token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(v));
      return v;
    },
    { route, body },
  );
}
async function open(page: Page, pid: string) {
  await page.evaluate((id) => localStorage.setItem("forma-project", id), pid);
  await page.reload();
  await page.getByLabel("创作想法", { exact: true }).waitFor();
}
test("真实建模、可调聊天、实时录制与上传", async ({ page }) => {
  test.setTimeout(600000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1195, height: 762 });
  await page.goto(base);
  await expect
    .poll(async () => !!(await api(page, "/health")).ok, { timeout: 60000 })
    .toBe(true);
  const p = await api(page, "/projects", { name: "V3 录制验收 " + Date.now() });
  fs.writeFileSync(path.join(out, "project.json"), JSON.stringify(p));
  await open(page, p.id);
  const input = page.getByLabel("创作想法", { exact: true });
  await input.fill("保留我的创作草稿");
  const chat = page.locator(".composer-wrap");
  await expect(chat).toHaveClass(/expanded/);
  await page.waitForTimeout(350);
  const before = (await chat.boundingBox())!;
  const handle = page.getByLabel("移动创作对话");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 15);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 60, { steps: 10 });
  await page.mouse.up();
  const moved = (await chat.boundingBox())!;
  expect(moved.x).toBeLessThan(before.x);
  const corner = (await page
    .getByLabel("调整聊天窗口 se", { exact: true })
    .boundingBox())!;
  await page.mouse.move(corner.x + 8, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x + 90, corner.y + 20, { steps: 8 });
  await page.mouse.up();
  expect((await chat.boundingBox())!.width).toBeGreaterThan(before.width);
  await page.screenshot({ path: path.join(out, "chat-desktop.png") });
  await page.reload();
  expect((await chat.boundingBox())!.width).toBeGreaterThan(before.width);
  const j = await api(page, `/projects/${p.id}/generate`, {
    baseRevisionId: null,
    prompt:
      "创建一个简单展示模型：左边红色立方体，右边蓝色球体，中间一根黄色细柱。三者放在浅灰色小底座上。保持低多边形，便于从不同角度辨认。不添加地面、灯光或相机。",
  });
  await page.reload();
  await expect(page.getByLabel("建模流程")).toBeVisible();
  await page.screenshot({ path: path.join(out, "build-running.png") });
  let result: any;
  await expect
    .poll(
      async () => {
        result = await api(page, `/jobs/${j.id}`);
        return result.status;
      },
      { timeout: 480000, intervals: [1000, 2000, 4000] },
    )
    .toBe("succeeded");
  fs.writeFileSync(
    path.join(out, "real-job.json"),
    JSON.stringify(result, null, 2),
  );
  expect(result.events.map((e: any) => e.index)).toEqual(
    expect.arrayContaining([1, 2, 3, 4, 5]),
  );
  await expect(page.locator(".flow-summary")).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "收起创作对话", exact: true }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("button", { name: "视频", exact: true }).click();
  await page.getByRole("button", { name: "进入录制模式" }).click();
  await page.getByRole("button", { name: "开始录制" }).click();
  await page.mouse.move(510, 280);
  await page.mouse.down();
  await page.mouse.move(780, 350, { steps: 35 });
  await page.mouse.up();
  await page.mouse.wheel(0, -150);
  await page.waitForTimeout(400);
  await page.mouse.move(550, 330);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(610, 370, { steps: 20 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "停止录制", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "录制结果" })).toBeVisible();
  const video = page.locator(".video-review video");
  await expect
    .poll(() => video.evaluate((e: HTMLVideoElement) => e.readyState))
    .toBeGreaterThan(1);
  expect(
    await video.evaluate((e: HTMLVideoElement) => [
      e.videoWidth,
      e.videoHeight,
    ]),
  ).toEqual([1280, 720]);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载视频", exact: true }).click();
  const d = await download;
  await d.saveAs(path.join(out, d.suggestedFilename()));
  await page.getByRole("button", { name: "保存到作品", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存到作品" })).toBeVisible({
    timeout: 60000,
  });
  await page.screenshot({ path: path.join(out, "real-video.png") });
  const snapshot = await api(page, `/projects/${p.id}/scene`);
  fs.writeFileSync(
    path.join(out, "recording.json"),
    JSON.stringify(snapshot.videos.at(-1), null, 2),
  );
  expect(snapshot.videos.at(-1).trajectory.samples.length).toBeGreaterThan(5);
  const captured = snapshot.videos.at(-1);
  const fine = await api(page, `/projects/${p.id}/videos`, {
    ...captured.trajectory,
    settings: { ...captured.settings, mode: "blender" },
  });
  fs.writeFileSync(path.join(out, "blender-video.json"), JSON.stringify(fine));
  const renderJob = await api(
    page,
    `/projects/${p.id}/videos/${fine.id}/render`,
    {},
  );
  let rendered: any;
  await expect
    .poll(
      async () => {
        rendered = await api(page, `/jobs/${renderJob.id}`);
        return rendered.status;
      },
      { timeout: 240000, intervals: [1000, 2000] },
    )
    .toBe("succeeded");
  fs.writeFileSync(
    path.join(out, "blender-video-job.json"),
    JSON.stringify(rendered, null, 2),
  );
  const media = await page.request.get(
    `${base}/api/artifacts/${rendered.renderArtifactId}`,
  );
  fs.writeFileSync(path.join(out, "blender-video.mp4"), await media.body());

  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "退出录制模式" }).click();
  await page.getByRole("button", { name: "关闭导出" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("窄屏多行草稿\n第二行\n第三行");
  await page.screenshot({ path: path.join(out, "chat-mobile.png") });
  expect((await chat.boundingBox())!.width).toBeLessThanOrEqual(366);
});

test("双视频关键帧、窄屏布局和录制退出恢复", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto(base);
  const p = JSON.parse(fs.readFileSync(path.join(out, "project.json"), "utf8"));
  await open(page, p.id);
  const snapshot = await api(page, `/projects/${p.id}/scene`);
  const ids = ["recording.json", "blender-video.json"].map(
    (file) => JSON.parse(fs.readFileSync(path.join(out, file), "utf8")).id,
  );
  const videos = snapshot.videos.filter(
    (v: any) => v.status === "ready" && ids.includes(v.id),
  );
  expect(videos.length).toBeGreaterThanOrEqual(2);
  for (const v of videos) {
    const frames = await page.evaluate(async (v: any) => {
      const el = document.createElement("video");
      el.src = `/api/artifacts/${v.artifactId}`;
      el.muted = true;
      await new Promise<void>((resolve, reject) => {
        el.onloadeddata = () => resolve();
        el.onerror = () => reject(new Error("decode failed"));
      });
      const canvas = document.createElement("canvas");
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      const ctx = canvas.getContext("2d")!;
      const frames = [];
      for (const time of [0.1, Math.min(1.6, el.duration - 0.1)]) {
        el.currentTime = time;
        await new Promise<void>((resolve) => {
          el.onseeked = () => resolve();
        });
        ctx.drawImage(el, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let red = 0,
          blue = 0,
          rx = 0,
          ry = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > data[i + 1] * 1.3 && data[i] > data[i + 2] * 1.3) {
            red++;
            rx += (i / 4) % canvas.width;
            ry += Math.floor(i / 4 / canvas.width);
          }
          if (data[i + 2] > data[i] * 1.2 && data[i + 2] > data[i + 1] * 1.1)
            blue++;
        }
        frames.push({
          red,
          blue,
          center: [rx / red, ry / red],
          png: canvas.toDataURL(),
        });
      }
      el.removeAttribute("src");
      el.load();
      return {
        width: canvas.width,
        height: canvas.height,
        duration: el.duration,
        frames,
      };
    }, v);
    expect(frames.width).toBe(1280);
    expect(frames.height).toBe(720);
    for (let i = 0; i < frames.frames.length; i++) {
      const frame = frames.frames[i];
      expect(frame.red).toBeGreaterThan(1000);
      expect(frame.blue).toBeGreaterThan(1000);
      fs.writeFileSync(
        path.join(out, `${v.settings.mode}-frame-${i}.png`),
        Buffer.from(frame.png.split(",")[1], "base64"),
      );
    }
    expect(
      Math.abs(frames.frames[0].center[0] - frames.frames[1].center[0]),
    ).toBeGreaterThan(10);
    fs.writeFileSync(
      path.join(out, `${v.settings.mode}-metrics.json`),
      JSON.stringify(frames.frames.map(({ png, ...rest }: any) => rest)),
    );
  }
  await page.setViewportSize({ width: 1195, height: 762 });
  const input = page.getByLabel("创作想法", { exact: true });
  await input.fill("草稿不能被录制清空");
  await page.getByRole("button", { name: "恢复默认布局" }).click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, "chat-desktop-final.png") });
  const normal = (await page.locator(".composer-wrap").boundingBox())!;
  expect(normal.height).toBeGreaterThan(500);
  await page.getByRole("button", { name: "收起创作对话", exact: true }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("button", { name: "视频", exact: true }).click();
  await page.getByRole("button", { name: "进入录制模式" }).click();
  await page.getByRole("button", { name: "开始录制" }).click();
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "录制结果" })).toBeVisible();
  await page.getByRole("button", { name: "退出录制模式" }).click();
  await page.getByRole("button", { name: "关闭导出" }).click();
  await expect(input).toHaveValue("草稿不能被录制清空");
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("第一行\n第二行\n第三行\n第四行");
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, "chat-mobile-final.png") });
  const rect = (await page.locator(".composer-wrap").boundingBox())!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.width).toBe(366);
  expect(rect.y + rect.height).toBeLessThanOrEqual(844);
  expect((await input.boundingBox())!.height).toBeGreaterThan(70);
});

test("流程修复、断线、失败与预览加载失败状态", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1195, height: 762 });
  await page.goto(base);
  const p = JSON.parse(fs.readFileSync(path.join(out, "project.json"), "utf8"));
  const snapshot = await api(page, `/projects/${p.id}/scene`);
  const id = crypto.randomUUID();
  let current: any = {
    id,
    projectId: p.id,
    type: "generate",
    baseRevisionId: snapshot.project.currentRevisionId,
    status: "running",
    stage: "修复脚本（1/2）",
    stageIndex: 1,
    attempt: 1,
    title: "流程交互模拟",
    createdAt: new Date(Date.now() - 350000).toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    resultRevisionId: null,
    message: "",
    events: [
      {
        stage: "生成脚本",
        index: 1,
        at: new Date(Date.now() - 350000).toISOString(),
      },
      {
        stage: "修复脚本（1/2）",
        index: 1,
        at: new Date(Date.now()-350000).toISOString(),
        error: "模拟 Blender 执行失败",
      },
    ],
    estimate: { low: 120, high: 300, source: "initial" },
  };
  await page.route(`**/api/projects/${p.id}/scene`, (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        activeJob: current.status === "running" ? current : null,
        jobs: [current],
      },
    }),
  );
  await page.route(`**/api/jobs/${id}/events`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(current)}\n\n`,
    }),
  );
  await page.route(`**/api/jobs/${id}`, (route) =>
    route.fulfill({ json: current }),
  );
  await open(page, p.id);
  const flow = page.getByLabel("建模流程");
  await expect(flow).toBeVisible();
  await expect(flow).toContainText("比预计耗时更久");
  await expect(flow.locator(".build-stages .active b")).toHaveText("创作脚本");
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, "build-flow-final.png") });
  await flow.getByRole("button", { name: "查看对话" }).click();
  await expect(flow).toBeHidden();
  await page.locator(".flow-summary").click();
  await expect(flow).toBeVisible();
  current = { ...current, stage: "执行建模", stageIndex: 2 };
  await expect(flow.locator(".build-stages .active b")).toHaveText(
    "Blender 建模",
    { timeout: 10000 },
  );
  await page.route(`**/api/jobs/${id}`, (route) => route.abort());
  await page.route(`**/api/jobs/${id}/events`, (route) => route.abort());
  await page.reload();
  await expect(flow).toContainText("正在重新连接", { timeout: 20000 });
  await page.unroute(`**/api/jobs/${id}`);
  await page.unroute(`**/api/jobs/${id}/events`);
  current = {
    ...current,
    status: "failed",
    stage: "失败",
    error: "模拟模型检查失败",
    stageIndex: 3,
    updatedAt: new Date().toISOString(),
  };
  await page.reload();
  await expect(flow.locator(".failed b")).toHaveText("检查模型");
  await expect(flow).toContainText("模拟模型检查失败");
  current = {
    ...current,
    status: "succeeded",
    stage: "完成",
    stageIndex: 5,
    resultRevisionId: snapshot.project.currentRevisionId,
  };
  await page.route("**/api/artifacts/*", (route) => route.abort());
  await page.reload();
  await page.getByRole("button", { name: "展开创作对话", exact: true }).click();
  await page.locator(".flow-summary").click();
  await expect(flow).toContainText("预览加载失败");
  await expect(
    flow.getByRole("button", { name: "重新加载预览" }),
  ).toBeVisible();
  await page.unroute("**/api/artifacts/*");
  await flow.getByRole("button", { name: "重新加载预览" }).click();
  await expect(flow).toBeHidden({ timeout: 30000 });
});

test("WebM 回退、视频上传失败保留并重试", async ({ page }) => {
  test.setTimeout(120000);
  await page.addInitScript(() => {
    const support = MediaRecorder.isTypeSupported;
    MediaRecorder.isTypeSupported = (type: string) =>
      !type.includes("mp4") && support.call(MediaRecorder, type);
  });
  await page.goto(base);
  const p = JSON.parse(fs.readFileSync(path.join(out, "project.json"), "utf8"));
  await open(page, p.id);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("button", { name: "视频", exact: true }).click();
  await page.getByRole("button", { name: "进入录制模式" }).click();
  await expect(page.getByLabel("视频录制")).toContainText("WEBM");
  await page.getByRole("button", { name: "开始录制" }).click();
  await page.waitForTimeout(500);
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "停止录制", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "录制结果" })).toBeVisible();
  const pending = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载视频", exact: true }).click();
  await (await pending).saveAs(path.join(out, "fallback.webm"));
  await page.route("**/videos/*/upload", (route) =>
    route.fulfill({ status: 500, json: { error: "模拟上传失败" } }),
  );
  await page.getByRole("button", { name: "保存到作品", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("模拟上传失败");
  await expect(page.locator(".video-review video")).toBeVisible();
  await page.unroute("**/videos/*/upload");
  await page.getByRole("button", { name: "保存到作品", exact: true }).click();
  await expect(page.getByRole("button", { name: "已保存到作品" })).toBeVisible({
    timeout: 60000,
  });
});
