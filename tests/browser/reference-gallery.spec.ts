import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

test.setTimeout(45000);
async function setup(page: Page) {
  const id = "reference-gallery-project";
  const project = { id, name: "三视图测试作品", threadId: null, currentRevisionId: null, createdAt: "2026-09-10T00:00:00Z", redo: [], coverRefreshSupported: true };
  const visual = {
    runId: "recent", phase: "烘焙贴图与验证导出", assumptions: ["背面与被遮挡的结构根据原图推测，实际尺寸以原始资料为准。"], reviews: [],
    evidence: ["原图 1", "正面参考图 · 单轮", "右侧参考图 · 单轮", "顶部参考图 · 单轮", "车架表面纹理"].map((label, i) => ({ label, artifactId: "image-" + i, kind: "image" })).concat([{ label: "模型源文件", artifactId: "model-file", kind: "model" }]),
  };
  const recent = { id: "recent", projectId: id, type: "generate", status: "succeeded", createdAt: project.createdAt, visual };
  const old = { ...recent, id: "older", status: "failed", error: "这次建模已中断，已生成的参考图仍然保留。", visual: { ...visual, runId: "older", evidence: [] } };
  const snapshot = { project, revision: null, previewUrl: null, scene: { objects: [], stats: { objects: 0, vertices: 0, triangles: 0 }, units: "meters", coordinates: "blender-z-up" }, activeJob: null, jobs: [old, recent], render: null, messages: [], proposals: [] };
  await page.addInitScript(id => localStorage.setItem("forma-project", id), id);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()).pathname;
    if (url.startsWith("/api/artifacts/")) {
      const index = Number(url.split("image-").at(-1));
      const names = ["original-1.png", "references-single/front.png", "references-single/right.png", "references-single/top.png"];
      const file = process.env.REFERENCE_QA_IMAGES && names[index] ? path.join(process.env.REFERENCE_QA_IMAGES, names[index]) : "";
      if (file && fs.existsSync(file)) return route.fulfill({ contentType: "image/png", body: fs.readFileSync(file) });
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/><path d="M65 220L150 70l85 150z" fill="#577c63"/></svg>' });
    }
    return route.fulfill({ json: url === "/api/session" ? { token: "fixture" } : url === "/api/health" ? { ok: true, codex: { ok: true } } : url === "/api/projects" ? [project] : url.endsWith("/scene") ? snapshot : recent });
  });
  await page.goto(process.env.REFERENCE_UI_BASE || "/");
  await page.getByRole("button", { name: "打开 三视图测试作品", exact: true }).click();
  await page.getByRole("button", { name: "参考与三视图", exact: true }).click();
  return page.getByRole("dialog", { name: "参考与三视图", exact: true });
}
for (const width of [1440, 900, 390]) test(`参考图库分组与布局 ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 });
  const panel = await setup(page);
  await expect(panel.getByRole("heading", { name: "原始参考" })).toBeVisible();
  await expect(panel.getByRole("heading", { name: "三视图", exact: true })).toBeVisible();
  await expect(panel.locator(".visual-image-grid img")).toHaveCount(4);
  await expect(panel.getByText("正视图", { exact: true })).toBeVisible();
  await expect(panel.locator(".visual-image-grid img").first()).toBeVisible();
  await panel.locator(".visual-reference-body").evaluate(el => el.scrollTop = 0);
  expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await panel.locator(".visual-reference-body").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath(`gallery-${width}.png`) });
});

test("分类、历史、下载与大图键盘操作保留焦点", async ({ page }) => {
  const panel = await setup(page);
  await panel.getByRole("button", { name: "右侧参考图 · 单轮", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "右侧参考图 · 单轮", exact: true })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  const lightbox = page.getByRole("dialog", { name: "顶部参考图 · 单轮", exact: true });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole("link", { name: "下载图片" })).toHaveAttribute("href", "/api/artifacts/image-3");
  await page.keyboard.press("Escape");
  await expect(page.locator(".visual-lightbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "右侧参考图 · 单轮", exact: true })).toBeFocused();
  await panel.getByRole("button", { name: /材质贴图/ }).click();
  await expect(panel.locator(".visual-image-grid img")).toHaveCount(1);
  await panel.getByRole("button", { name: /模型检查图/ }).click();
  await expect(panel.getByText("暂无模型检查图")).toBeVisible();
  await panel.getByText("模型与过程文件", { exact: true }).click();
  await expect(panel.getByRole("link", { name: "模型源文件" })).toHaveAttribute("download", "");
  await panel.getByRole("combobox", { name: "建模记录" }).selectOption("older");
  await expect(panel.getByRole("alert")).toContainText("已中断");
  await panel.getByRole("combobox", { name: "建模记录" }).selectOption("recent");
  await panel.getByRole("button", { name: /原图与三视图/ }).click();
  await expect(panel.locator(".visual-image-grid img")).toHaveCount(4);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("button", { name: "参考与三视图", exact: true })).toBeFocused();
});
