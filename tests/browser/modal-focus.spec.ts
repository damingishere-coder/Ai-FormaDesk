import { test, expect } from "./fixtures";
import type { Page, Locator } from "@playwright/test";

const image = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#567c61"/></svg>';
async function setup(page: Page) {
  const project = { id: "focus-project", name: "键盘边界作品", threadId: null, currentRevisionId: null, createdAt: "2026-10-12T00:00:00Z", redo: [] };
  const snapshot = { project, revision: null, scene: { objects: [], stats: { objects: 0, vertices: 0, triangles: 0 }, units: "meters", coordinates: "blender-z-up" }, activeJob: null, jobs: [], videos: [], previewUrl: null, render: null, messages: [{ id: "image-message", projectId: project.id, role: "user", text: "参考图", attachmentIds: ["reference"], createdAt: project.createdAt, status: "completed" }], proposals: [] };
  let trash = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith("/reference") || url.pathname === "/api/artifacts/image")
      return route.fulfill({ contentType: "image/svg+xml", body: image });
    let json: unknown;
    if (url.pathname === "/api/session") json = { token: "fixture" };
    else if (url.pathname === "/api/health") json = { ok: true, checking: false, codex: { ok: true }, blender: { ok: true }, sandbox: { ok: true } };
    else if (url.pathname === "/api/blender/status") json = { installed: false, connected: false, state: "closed" };
    else if (url.pathname === "/api/projects") json = (url.searchParams.get("trash") === "1") === trash ? [project] : [];
    else if (url.pathname.endsWith("/scene")) json = snapshot;
    else if (url.pathname.endsWith("/opened")) json = project;
    else if (url.pathname.endsWith("/revisions")) json = [];
    else if (url.pathname.endsWith("/files")) json = [{ id: "image", projectId: project.id, revisionId: null, name: "测试图片.png", kind: "image", format: "PNG", url: "/api/artifacts/image", available: true, size: 100, createdAt: project.createdAt, current: true }];
    else if (url.pathname.endsWith("/trash")) { trash = true; json = { ...project, deletedAt: project.createdAt }; }
    else if (request.method() === "PATCH") { Object.assign(project, request.postDataJSON()); json = project; }
    else throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
    await route.fulfill({ json });
  });
  await page.goto("/");
}
async function traps(page: Page, dialog: Locator) {
  const visibleControls = dialog.locator('button:enabled, a[href], input:enabled, textarea:enabled, select:enabled, video[controls]');
  const count = await visibleControls.count();
  expect(count).toBeGreaterThan(0);
  await visibleControls.last().focus();
  await page.keyboard.press("Tab");
  await expect(visibleControls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(visibleControls.last()).toBeFocused();
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
}

test("App 环境与历史模态进入焦点、Tab 圈、Escape 和按钮关闭返回触发器", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "打开 键盘边界作品", exact: true }).click();
  for (const name of ["环境检查", "版本历史"]) {
    const opener = page.getByRole("button", { name, exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    await expect(dialog.getByRole("button", { name: "关闭窗口" })).toBeFocused();
    await traps(page, dialog);
    expect(await page.locator(".editor-shell").evaluate(element => (element as HTMLElement).inert)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await page.locator(".editor-shell").evaluate(element => (element as HTMLElement).inert)).toBe(false);
    await opener.click();
    await dialog.getByRole("button", { name: "关闭窗口" }).click();
    await expect(opener).toBeFocused();
  }
});

test("作品详情与嵌套媒体只关闭顶层、恢复文件触发器，再回到首页触发器", async ({ page }) => {
  await setup(page);
  const opener = page.getByRole("button", { name: "查看文件 键盘边界作品", exact: true });
  await opener.click();
  const detail = page.getByRole("dialog", { name: "作品文件", exact: true });
  await expect(detail.getByRole("button", { name: "关闭作品详情" })).toBeFocused();
  const view = detail.getByRole("button", { name: "查看", exact: true });
  await expect(view).toBeVisible();
  await traps(page, detail);
  await view.click();
  const media = page.getByRole("dialog", { name: "测试图片.png", exact: true });
  await expect(media.getByRole("button", { name: "关闭媒体预览" })).toBeFocused();
  await traps(page, media);
  expect(await detail.evaluate(element => !!element.closest("[inert]"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(media).toHaveCount(0);
  await expect(detail).toBeVisible();
  await expect(view).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(await page.locator(".home-main").evaluate(element => (element as HTMLElement).inert)).toBe(false);
  // Closing a drawer by entering the workbench must respect React's inert owner.
  const preview = page.getByRole("button", { name: "预览 键盘边界作品", exact: true });
  await preview.click();
  await page.getByRole("dialog", { name: "作品预览", exact: true }).getByRole("button", { name: "进入工作台" }).click();
  await expect(page.locator(".project-home")).toHaveCount(0);
  expect(await page.locator(".editor-shell").evaluate(element => (element as HTMLElement).inert)).toBe(false);
});

test("作品创建、重命名与彻底删除确认具有实际焦点边界和返回", async ({ page }) => {
  await setup(page);
  const create = page.getByRole("button", { name: "新建作品", exact: true }).first();
  await create.click();
  const form = page.getByRole("dialog", { name: "新建作品", exact: true });
  await expect(form.getByRole("textbox", { name: "新作品名称" })).toBeFocused();
  await form.getByRole("textbox").fill("只验证键盘，不创建记录");
  await traps(page, form);
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0); await expect(create).toBeFocused();
  const menu = page.getByRole("button", { name: "管理 键盘边界作品", exact: true });
  await menu.click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "重命名作品", exact: true });
  await expect(rename.getByRole("textbox", { name: "作品新名称" })).toBeFocused();
  await traps(page, rename); await page.keyboard.press("Escape");
  await expect(rename).toHaveCount(0);
  expect(await page.locator(".home-project").evaluate(element => element.contains(document.activeElement))).toBe(true);
  await menu.click();
  await page.getByRole("menuitem", { name: "移入回收站", exact: true }).click();
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  const remove = page.getByRole("button", { name: "彻底删除 键盘边界作品", exact: true });
  await remove.click();
  const confirm = page.getByRole("alertdialog", { name: "确认彻底删除", exact: true });
  await expect(confirm.getByRole("button", { name: "保留作品" })).toBeFocused();
  await traps(page, confirm); await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0); await expect(remove).toBeFocused();
});

test("Composer 参考图大图通过键盘闭环，并返回原图按钮", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "打开 键盘边界作品", exact: true }).click();
  await page.getByRole("button", { name: "展开创作对话", exact: true }).click();
  const imageButton = page.locator(".message-images button").first();
  await imageButton.click();
  const dialog = page.getByRole("dialog", { name: "参考图片大图", exact: true });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("button", { name: "关闭图片" })).toBeFocused();
  await traps(page, dialog);
  expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(imageButton).toBeFocused();
  expect(await page.locator("#root").evaluate(element => (element as HTMLElement).inert)).toBe(false);
});
