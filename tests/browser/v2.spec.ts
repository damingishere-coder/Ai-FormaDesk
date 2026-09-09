import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot } from "../../src/types";
const base = process.env.FORMA_TEST_URL || "http://127.0.0.1:18877";
const evidence = path.resolve("data/v2-evidence");
async function api(page: Page, route: string, body?: unknown, method?: string) {
  return page.evaluate(
    async ({ route, body, method }) => {
      const session = await (await fetch("/api/session")).json();
      const r = await fetch("/api" + route, {
        method: method || (body === undefined ? "GET" : "POST"),
        headers: {
          "Content-Type": "application/json",
          "X-Forma-Session": session.token,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await r.json();
      return { status: r.status, value };
    },
    { route, body, method },
  );
}
async function create(page: Page, name: string) {
  return (
    await api(page, "/projects", {
      name: name + " " + crypto.randomUUID().slice(0, 6),
    })
  ).value;
}
async function openProject(page: Page, id: string) {
  await page.evaluate((id) => localStorage.setItem("forma-project", id), id);
  await page.reload();
  await page.getByRole("textbox", { name: "创作想法" }).waitFor();
}
const image = () => ({
  name: "reference.png",
  mimeType: "image/png",
  buffer: fs.readFileSync(path.join(evidence, "reference.png")),
});
test.setTimeout(120000);
test.beforeEach(async ({ page }) => {
  await page.goto(base);
});
test("图片上传重试、粘贴拖入、聊天伸展、草稿和临时预览隔离", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const p = await create(page, "图片交互测试"),
    other = await create(page, "临时预览测试");
  await openProject(page, p.id);
  const composer = page.locator(".composer-wrap"),
    input = page.getByRole("textbox", { name: "创作想法" });
  await input.fill("保留我的文字草稿");
  await expect(composer).toHaveClass(/expanded/);
  await page.route("**/attachments", async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "测试上传失败" }),
    });
  });
  await page.getByLabel("选择参考图片").setInputFiles(image());
  await expect(
    page.getByRole("button", { name: "重试", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "发送讨论" })).toBeDisabled();
  await page.unroute("**/attachments");
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".draft-image.ready")).toHaveCount(1);
  await page.getByAltText("待发送图 1").click();
  await expect(
    page.getByRole("dialog", { name: "参考图片大图" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭图片" }).click();
  await input.evaluate((el, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const d = new DataTransfer();
    d.items.add(new File([bytes], "paste.png", { type: "image/png" }));
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: d,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, image().buffer.toString("base64"));
  await expect(page.locator(".draft-image.ready")).toHaveCount(2);
  await composer.evaluate((el, encoded) => {
    const d = new DataTransfer();
    d.items.add(
      new File(
        [Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))],
        "drop.png",
        { type: "image/png" },
      ),
    );
    el.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: d,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, image().buffer.toString("base64"));
  await expect(page.locator(".draft-image.ready")).toHaveCount(3);
  await page.getByRole("button", { name: "收起创作对话" }).click();
  await expect(composer).not.toHaveClass(/expanded/);
  await expect(input).toHaveValue("保留我的文字草稿");
  await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: `预览 ${other.name}`, exact: true })
    .click();
  await expect(page.getByText("尚未建模", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("forma-project"))).toBe(
    p.id,
  );
  await page.getByRole("button", { name: "关闭作品库" }).click();
  await expect(input).toHaveValue("保留我的文字草稿");
  await expect(page.locator(".draft-image.ready")).toHaveCount(3);
  // Cross-project attachment references must be rejected by the server.
  const src = await page.getByAltText("待发送图 1").getAttribute("src");
  const aid = src!.split("/").at(-1)!;
  const cross = await api(page, `/projects/${other.id}/discuss`, {
    baseRevisionId: null,
    prompt: "图片测试",
    attachmentIds: [aid],
  });
  expect(cross.status).toBe(400);
  await page.getByRole("button", { name: "移除图 3" }).click();
  await expect(page.locator(".draft-image")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.click();
  await page.waitForTimeout(350);
  const rect = await composer.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: path.join(evidence, "mobile-upload.png") });
  expect(errors).toEqual([]);
});
test("作品回收站、撤销、恢复、确认彻底删除和最后一个作品", async ({ page }) => {
  const p = await create(page, "删除操作测试");
  await openProject(page, p.id);
  await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: `${p.name} 更多操作`, exact: true })
    .click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await expect(page.locator(".library-undo")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("forma-project")),
  ).toBeNull();
  await page
    .locator(".library-undo")
    .getByRole("button", { name: "撤销", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `预览 ${p.name}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `${p.name} 更多操作`, exact: true })
    .click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const card = page
    .locator(".project-card")
    .filter({ has: page.getByText(p.name, { exact: true }) });
  await card.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "全部作品", exact: true }).click();
  await page
    .getByRole("button", { name: `${p.name} 更多操作`, exact: true })
    .click();
  await page.getByRole("button", { name: "移入回收站", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await card.getByRole("button", { name: "彻底删除", exact: true }).click();
  await expect(
    page.getByRole("alertdialog", { name: "确认彻底删除" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保留作品", exact: true }).click();
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "彻底删除", exact: true }).click();
  await page.getByRole("button", { name: "确认彻底删除", exact: true }).click();
  await expect(card).toHaveCount(0);
  expect((await api(page, `/projects/${p.id}/scene`)).status).toBe(404);
  // Simulate only the list response to test the last-work empty UX without deleting unrelated test work.
  await page.route("**/api/projects", (r) => r.fulfill({ json: [] }));
  await page.getByRole("button", { name: "全部作品", exact: true }).click();
  await expect(page.getByText("下一个作品，从这里开始")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新建作品", exact: true }),
  ).toBeVisible();
});
test("真实模型可旋转预览、切换相机保持及图片导出设置", async ({ page }) => {
  const s: Snapshot = JSON.parse(
    fs.readFileSync(path.join(evidence, "final-scene.json"), "utf8"),
  );
  await openProject(page, s.project.id);
  await expect(page.locator("canvas")).toBeVisible();
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.getByText("实时材质预览 · 拖动旋转")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "建模工具" })).toHaveCount(
    0,
  );
  await page.mouse.move(700, 300);
  await page.mouse.down();
  await page.mouse.move(900, 350, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  // Actual render request captures the orbit camera; intercept only the enqueue request for comparison.
  const cameras: any[] = [];
  await page.route("**/render", async (r) => {
    cameras.push(r.request().postDataJSON());
    await r.fulfill({
      status: 400,
      json: { error: "相机捕获测试，不启动渲染" },
    });
  });
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByLabel("画面比例").selectOption("portrait");
  await expect(page.getByLabel("图片宽度")).toHaveValue("720");
  await expect(page.getByLabel("图片高度")).toHaveValue("1280");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "生成图片" }).click();
  await expect.poll(() => cameras.length).toBe(1);
  expect(cameras[0].settings).toEqual({
    width: 720,
    height: 1280,
    transparent: true,
  });
  expect(cameras[0].camera.fov).toBe(42);
  await page.getByRole("button", { name: "关闭提示" }).click();
  await page.getByRole("button", { name: "返回工作台" }).click();
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("button", { name: "生成图片" }).click();
  await expect.poll(() => cameras.length).toBe(2);
  expect(cameras[1].camera.position).toEqual(cameras[0].camera.position);
  expect(cameras[1].camera.target).toEqual(cameras[0].camera.target);
  await page.getByRole("button", { name: "关闭提示" }).click();
  await page.screenshot({ path: path.join(evidence, "export-settings.png") });
  await page.getByRole("button", { name: "返回工作台" }).click();
  await page.getByRole("button", { name: "查看成品图", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Blender 成品图" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭成品图" }).click();
  await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: `预览 ${s.project.name}`, exact: true })
    .click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(evidence, "quick-preview.png") });
});

test("真实浏览器：参考图讨论、方案执行、渲染与下载", async ({ page }) => {
  test.skip(process.env.FORMA_REAL_AI !== "1", "显式启用真实 Codex 验收");
  test.setTimeout(900000);
  const p = await create(page, "浏览器真实多模态验收");
  await openProject(page, p.id);
  await expect(page.getByRole("button", { name: "添加图片" })).toBeEnabled();
  await page.getByLabel("选择参考图片").setInputFiles(image());
  await expect(page.locator(".draft-image.ready")).toHaveCount(1);
  await page.getByRole("button", { name: "发送讨论" }).click();
  await expect(page.getByRole("textbox", { name: "创作想法" })).toBeEnabled({
    timeout: 600000,
  });
  const imageOnly: Snapshot = (await api(page, `/projects/${p.id}/scene`))
    .value;
  expect(imageOnly.revision).toBeNull();
  expect(imageOnly.proposals).toHaveLength(0);
  expect(imageOnly.messages.at(-1)!.text).toMatch(/参考|希望|想|用途/);

  await page
    .getByRole("textbox", { name: "创作想法" })
    .fill(
      "请参考图片的颜色和形状，创建三个简单几何物体：蓝色盒子、它正面偏左的红色小方块、上方黄色球体。盒子宽 2 米、深 0.8 米、高 0.8 米，其他尺寸和位置采用合理默认值。只创建这三个对象，不加灯光和地面。先说出图中的颜色和对应形状，然后直接给出可执行的建模方案，并引用参考图。",
    );
  await page.getByRole("button", { name: "发送讨论" }).click();
  await expect(
    page.getByRole("button", { name: "开始建模", exact: true }),
  ).toBeEnabled({ timeout: 600000 });
  let s: Snapshot = (await api(page, `/projects/${p.id}/scene`)).value;
  expect(s.revision).toBeNull();
  expect(s.messages.at(-1)!.text).toMatch(/蓝/);
  expect(s.proposals.at(-1)!.attachmentIds).toHaveLength(1);
  await page.screenshot({
    path: path.join(evidence, "real-browser-proposal.png"),
  });
  await page.getByRole("button", { name: "开始建模", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已完成", exact: true }),
  ).toBeVisible({ timeout: 600000 });
  s = (await api(page, `/projects/${p.id}/scene`)).value;
  expect(s.scene.objects.length).toBe(3);
  await page.getByRole("button", { name: "收起创作对话" }).click();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.mouse.move(730, 330);
  await page.mouse.down();
  await page.mouse.move(850, 340, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByLabel("图片宽度").fill("512");
  await page.getByLabel("图片高度").fill("512");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "生成图片" }).click();
  await expect(
    page.getByRole("dialog", { name: "Blender 成品图" }),
  ).toBeVisible({ timeout: 240000 });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载原图", exact: true }).click();
  await (await download).saveAs(path.join(evidence, "real-browser-render.png"));
  await page.screenshot({
    path: path.join(evidence, "real-browser-render-view.png"),
  });
  s = (await api(page, `/projects/${p.id}/scene`)).value;
  fs.writeFileSync(
    path.join(evidence, "real-browser-result.json"),
    JSON.stringify(s, null, 2),
  );
  // Persisted images and completed plan survive a reload.
  await page.reload();
  await page.getByRole("textbox", { name: "创作想法" }).click();
  await expect(page.getByAltText("图 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "已完成", exact: true }),
  ).toBeVisible();
});

test("模拟中断：刷新恢复待回复状态、断线恢复和取消保留对话", async ({
  page,
}) => {
  const p = await create(page, "讨论状态测试");
  await openProject(page, p.id);
  const original: Snapshot = (await api(page, `/projects/${p.id}/scene`)).value;
  const job: any = {
    id: crypto.randomUUID(),
    projectId: p.id,
    baseRevisionId: null,
    type: "discuss",
    status: "running",
    stage: "正在讨论创作想法",
    error: null,
    resultRevisionId: null,
    message: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let started = false;
  const messages: any[] = [
    {
      id: crypto.randomUUID(),
      projectId: p.id,
      role: "user",
      text: "这是待回复的问题",
      createdAt: job.createdAt,
      status: "completed",
    },
    {
      id: crypto.randomUUID(),
      projectId: p.id,
      role: "assistant",
      text: "",
      createdAt: job.createdAt,
      status: "pending",
    },
  ];
  await page.route(`**/api/projects/${p.id}/discuss`, (r) => {
    started = true;
    return r.fulfill({ status: 202, json: job });
  });
  await page.route(`**/api/projects/${p.id}/scene`, (r) =>
    r.fulfill({
      json: {
        ...original,
        messages: started ? messages : [],
        activeJob: started && job.status === "running" ? job : null,
      },
    }),
  );
  await page.route(`**/api/jobs/${job.id}/events`, (r) =>
    r.fulfill({ status: 503, json: { error: "模拟事件连接中断" } }),
  );
  await page.route(`**/api/jobs/${job.id}`, (r) => r.fulfill({ json: job }));
  await page.route(`**/api/jobs/${job.id}/cancel`, (r) => {
    job.status = "cancelled";
    job.error = "任务已取消";
    job.stage = "已取消";
    messages[1].status = "cancelled";
    messages[1].text = "任务已取消";
    return r.fulfill({ json: job });
  });
  await page
    .getByRole("textbox", { name: "创作想法" })
    .fill("这是待回复的问题");
  await page.getByRole("button", { name: "发送讨论" }).click();
  await expect(page.getByRole("button", { name: "停止任务" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "停止任务" })).toBeVisible();
  await page.getByRole("button", { name: "展开创作对话" }).click();
  await expect(page.locator(".conversation-message.user")).toContainText(
    "这是待回复的问题",
  );
  await page.context().setOffline(true);
  await page.waitForTimeout(200);
  await page.context().setOffline(false);
  await page.getByRole("button", { name: "停止任务" }).click();
  await expect(page.getByRole("button", { name: "发送讨论" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator(".conversation-message.assistant")).toContainText(
    "任务已取消",
  );
  expect(
    (await api(page, `/projects/${p.id}/scene`)).value.project
      .currentRevisionId,
  ).toBeNull();
});

test("上传中切换作品再返回，附件状态继续更新且草稿隔离", async ({ page }) => {
  const p = await create(page, "上传切换测试"),
    other = await create(page, "另一个草稿");
  await openProject(page, p.id);
  await page
    .getByRole("textbox", { name: "创作想法" })
    .fill("只属于第一个作品");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/attachments", async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByLabel("选择参考图片").setInputFiles(image());
  await expect(page.locator(".draft-image.uploading")).toHaveCount(1);
  await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: `预览 ${other.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "打开编辑", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "创作想法" })).toHaveValue("");
  await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: `预览 ${p.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "打开编辑", exact: true }).click();
  release();
  await expect(page.locator(".draft-image.ready")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "创作想法" })).toHaveValue(
    "只属于第一个作品",
  );
});
