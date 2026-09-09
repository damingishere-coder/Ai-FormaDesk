import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../../src/types";

async function checkComposerGeometry(page: Page) {
  const values = await page.locator(".composer").evaluate((root) => {
    const compact = root.parentElement!.classList.contains("compact");
    const rect = (selector: string) =>
      root.querySelector(selector)!.getBoundingClientRect();
    const header = rect(".chat-titlebar"),
      footer = rect(".composer-footer");
    const title = rect(".chat-handle"),
      context = rect(".context-line");
    const form = rect("form"),
      input = rect("textarea");
    const upload = rect(".composer-bottom > .icon"),
      send = rect(".send");
    return {
      titleInset: title.left - (compact ? form.left : context.left),
      formInset: compact ? 0 : form.left - context.left,
      fieldInset: compact
        ? (input.top + input.bottom - upload.top - upload.bottom) / 2
        : input.left - upload.left,
      buttonCenter: (upload.top + upload.bottom - send.top - send.bottom) / 2,
      buttonSize: upload.height - send.height,
      overlap: header.bottom - footer.top,
      sendOverflow: send.bottom - root.getBoundingClientRect().bottom,
      horizontalOverflow: root.scrollWidth - root.clientWidth,
      fieldOverflow: input.right - form.right,
    };
  });
  for (const key of [
    "titleInset",
    "formInset",
    "fieldInset",
    "buttonCenter",
    "buttonSize",
  ] as const)
    expect(Math.abs(values[key]), key).toBeLessThanOrEqual(1);
  for (const key of [
    "overlap",
    "sendOverflow",
    "horizontalOverflow",
    "fieldOverflow",
  ] as const)
    expect(values[key], key).toBeLessThanOrEqual(1);
}

test("创作浮窗在收起、图文记录、缩窄和手机宽度下保持对齐", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1195, height: 837 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const snapshot: Snapshot = {
    project: {
      id: "chat-layout-test",
      name: "对话布局测试",
      currentRevisionId: null,
      threadId: null,
      createdAt: "2026-09-07T09:00:00Z",
      redo: [],
    },
    revision: null,
    scene: {
      objects: [],
      stats: { objects: 0, vertices: 0, triangles: 0 },
      units: "meters",
      coordinates: "blender-z-up",
    },
    previewUrl: null,
    activeJob: null,
    render: null,
    proposals: [],
    messages: [
      {
        id: "user",
        projectId: "chat-layout-test",
        role: "user",
        createdAt: "2026-09-07T09:00:00Z",
        text: "请结合这四张参考图，保留猫咪的五官、毛色和圆润的体态。",
        attachmentIds: ["1", "2", "3", "4"],
      },
      {
        id: "assistant",
        projectId: "chat-layout-test",
        role: "assistant",
        createdAt: "2026-09-07T09:00:00Z",
        text: "我会先对照各个角度，整理猫咪的脸型、眼睛比例和花纹位置。\n确认外观细节后，再开始建模。",
      },
    ],
  };
  await page.addInitScript(() => {
    localStorage.setItem("forma-project", "chat-layout-test");
    localStorage.setItem(
      "forma-chat-layout-v4",
      JSON.stringify({ x: 24, y: 160, width: 574, height: 560, moved: true }),
    );
  });
  let uploaded = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    let json: unknown;
    if (url === "/api/session") json = { token: "test-session" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
    else if (url === "/api/blender/status") json = { sessions: [] };
    else if (url === "/api/projects") json = [snapshot.project];
    else if (url.endsWith("/scene")) json = snapshot;
    else if (url === "/api/jobs/hidden-job/events") {
      await route.fulfill({
        contentType: "text/event-stream",
        body: `data: ${JSON.stringify(snapshot.activeJob)}\n\n`,
      });
      return;
    } else if (url === "/api/jobs/hidden-job") json = snapshot.activeJob;
    else if (
      url.endsWith("/attachments") &&
      route.request().method() === "POST"
    )
      json = { id: `draft-${++uploaded}` };
    else if (url.includes("/attachments/")) {
      if (route.request().method() === "DELETE") json = { ok: true };
      else {
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#dbe5da"/><circle cx="50" cy="50" r="28" fill="#a5bba1"/></svg>',
        });
        return;
      }
    } else throw new Error(`Unexpected API request: ${url}`);
    await route.fulfill({ json });
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "创作想法", exact: true });
  await expect(input).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".composer-footer")
        .evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBe(0);
  await checkComposerGeometry(page);
  expect(
    (await page.locator(".composer-wrap").boundingBox())!.height,
  ).toBeLessThanOrEqual(110);
  expect(
    (await page.locator(".composer-wrap").boundingBox())!.width,
  ).toBeLessThanOrEqual(520);
  await page.screenshot({
    path: testInfo.outputPath("composer-collapsed.png"),
  });
  await page.getByRole("button", { name: "展开创作对话", exact: true }).click();
  await expect(page.locator(".conversation-reveal")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await expect(page.getByAltText("图 4", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".composer-wrap")
        .evaluate((el) => Math.round(el.getBoundingClientRect().height)),
    )
    .toBe(560);
  await checkComposerGeometry(page);
  await page.screenshot({ path: testInfo.outputPath("composer-expanded.png") });
  await input.fill("保留草稿\n补充眼睛的形状和耳朵的比例。");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await page.getByLabel("选择参考图片").setInputFiles(
    Array.from({ length: 6 }, (_, i) => ({
      name: `reference-${i}.png`,
      mimeType: "image/png",
      buffer: png,
    })),
  );
  await expect(page.locator(".draft-image.ready")).toHaveCount(6);
  const corner = (await page
    .getByLabel("调整聊天窗口 se", { exact: true })
    .boundingBox())!;
  await page.mouse.move(corner.x + 6, corner.y + 6);
  await page.mouse.down();
  await page.mouse.move(corner.x - 208, corner.y + 6, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page
        .locator(".composer-wrap")
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    )
    .toBe(360);
  await expect(page.locator(".input-hint")).toBeHidden();
  await checkComposerGeometry(page);
  await page.screenshot({ path: testInfo.outputPath("composer-narrow.png") });
  await page.getByRole("button", { name: "收起创作对话", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".composer-footer")
        .evaluate((el) => el.scrollHeight - el.clientHeight),
    )
    .toBe(0);
  await checkComposerGeometry(page);
  await expect(input).toHaveValue("保留草稿\n补充眼睛的形状和耳朵的比例。");
  await expect
    .poll(() =>
      page.locator(".composer-wrap").evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return Math.round(
          Math.abs(rect.top - parseFloat((el as HTMLElement).style.top)),
        );
      }),
    )
    .toBe(0);
  const beforeMove = (await page.locator(".composer-wrap").boundingBox())!;
  const handle = (await page
    .getByRole("button", { name: "移动创作对话", exact: true })
    .boundingBox())!;
  await page.mouse.move(handle.x + 80, handle.y + 16);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y - 24, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() =>
      page
        .locator(".composer-wrap")
        .evaluate((el) => Math.round(el.getBoundingClientRect().x)),
    )
    .toBe(Math.round(beforeMove.x + 40));
  await expect(
    page.getByRole("button", { name: "展开创作对话", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() =>
      page
        .locator(".composer-wrap")
        .evaluate((el) => Math.round(el.getBoundingClientRect().width)),
    )
    .toBe(351);
  await checkComposerGeometry(page);
  await page.getByRole("button", { name: "展开创作对话", exact: true }).click();
  await page.getByRole("button", { name: "移除图 6", exact: true }).click();
  await expect(page.locator(".draft-image.ready")).toHaveCount(5);
  await page.screenshot({ path: testInfo.outputPath("composer-mobile.png") });
  await page.getByRole("button", { name: "隐藏创作对话", exact: true }).click();
  await expect(page.locator(".composer-wrap")).toBeHidden();
  const launcher = page.getByRole("button", {
    name: "打开创作对话",
    exact: true,
  });
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(input).toHaveValue("保留草稿\n补充眼睛的形状和耳朵的比例。");
  await expect(page.locator(".draft-image.ready")).toHaveCount(5);
  await page.getByRole("button", { name: "隐藏创作对话", exact: true }).click();
  snapshot.activeJob = {
    id: "hidden-job",
    projectId: snapshot.project.id,
    type: "generate",
    status: "running",
    baseRevisionId: null,
    stage: "生成脚本",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
    resultRevisionId: null,
    message: "正在建模",
  };
  await page.reload();
  await expect(launcher).toBeVisible();
  await expect(launcher).toHaveText("任务进行中");
  await expect(page.locator(".composer-wrap")).toBeHidden();
  await launcher.click();
  await expect(
    page.locator(".composer-bottom").getByRole("button", { name: "停止任务", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
