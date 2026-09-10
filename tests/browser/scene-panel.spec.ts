import { test, expect } from "@playwright/test";
import type { Snapshot } from "../../src/types";

test("场景列表展开后避开工具栏，长列表滚动且工具仍可操作", async ({
  page,
}, testInfo) => {
  const snapshot: Snapshot = {
    project: {
      id: "scene-panel-test",
      name: "场景列表测试",
      currentRevisionId: null,
      threadId: null,
      createdAt: "2026-09-07T09:00:00Z",
      redo: [],
    },
    revision: null,
    previewUrl: null,
    activeJob: null,
    render: null,
    proposals: [],
    messages: [],
    scene: {
      units: "meters",
      coordinates: "blender-z-up",
      stats: { objects: 94, vertices: 0, triangles: 0 },
      objects: Array.from({ length: 94 }, (_, index) => ({
        id: `part-${index}`,
        name: `模型部件 ${index + 1}`,
        type: "EMPTY",
        parentId: null,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        visible: true,
        material: null,
        light: null,
      })),
    },
  };
  await page.addInitScript(() => {
    localStorage.setItem("forma-project", "scene-panel-test");
    localStorage.setItem(
      "forma-chat-layout-v4",
      JSON.stringify({ x: 800, y: 76, width: 360, height: 300, moved: true }),
    );
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    let json: unknown;
    if (url === "/api/session") json = { token: "test-session" };
    else if (url === "/api/blender/status") json = { installed: false, connected: false, state: "closed" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
    else if (url === "/api/projects") json = [snapshot.project];
    else if (url.endsWith("/opened")) json = snapshot.project;
    else if (url.endsWith("/scene")) json = snapshot;
    else throw new Error(`Unexpected API request: ${url}`);
    await route.fulfill({ json });
  });
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: `打开 ${snapshot.project.name}`, exact: true }).click();
  const trigger = page.getByRole("button", { name: "场景 · 94", exact: true });
  const panel = page.getByRole("complementary", {
    name: "场景对象",
    exact: true,
  });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  for (const [width, height] of [
    [1536, 900],
    [1195, 837],
    [1024, 700],
    [768, 760],
    [375, 1000],
  ]) {
    await page.setViewportSize({ width, height });
    await expect(panel).toBeVisible();
    const bounds = await page.locator(".workbench").evaluate((root) => {
      const scene = root
        .querySelector(".scene-popover")!
        .getBoundingClientRect();
      const rail = root.querySelector(".tool-rail")!.getBoundingClientRect();
      const list = root.querySelector(".object-list")!;
      return {
        gap: scene.left - rail.right,
        right: scene.right,
        top: scene.top,
        bottom: scene.bottom,
        scrolls: list.scrollHeight > list.clientHeight,
      };
    });
    expect(bounds.gap).toBeGreaterThanOrEqual(12);
    expect(bounds.right).toBeLessThanOrEqual(width - 12);
    expect(bounds.top).toBeGreaterThanOrEqual(76);
    expect(bounds.bottom).toBeLessThanOrEqual(height - 64);
    expect(bounds.scrolls).toBe(true);
    // Real pointer clicks catch overlap from another panel, not just rectangle errors.
    for (const name of ["选择", "移动", "旋转", "缩放"]) {
      const tool = page.getByRole("button", { name, exact: true });
      await tool.click();
      await expect(tool).toHaveClass(/active/);
      await expect(panel).toBeVisible();
    }
    await page.getByRole("button", { name: "适应模型", exact: true }).click();
    await panel.locator('[data-object-id="part-93"]').scrollIntoViewIfNeeded();
    await expect(panel.locator('[data-object-id="part-93"]')).toBeVisible();
    if (width === 1195 || width === 375)
      await page.screenshot({
        path: testInfo.outputPath(`scene-panel-${width}.png`),
      });
  }
  await page.setViewportSize({ width: 1195, height: 837 });
  await panel.locator('[data-object-id="part-93"]').click();
  await expect(panel).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "对象属性" }),
  ).toContainText("模型部件 94");
  await expect(panel.locator('[data-object-id="part-93"]')).toHaveClass(/active/);
  await panel.locator('[data-object-id="part-92"]').click();
  await expect(page.getByRole("complementary", { name: "对象属性" })).toContainText("模型部件 93");
  await expect(panel).toBeVisible();
  await page.getByRole("button", { name: "关闭属性面板", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByRole("complementary", { name: "对象属性" })).toHaveCount(0);
  await panel.locator('[data-object-id="part-93"]').click();
  await page.screenshot({ path: testInfo.outputPath("scene-and-properties.png") });
  await page.getByRole("button", { name: "展开创作对话", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "对象属性" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "对象属性", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "对象属性" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "展开创作对话", exact: true }),
  ).toBeVisible();
  await trigger.click();
  await expect(
    page.getByRole("complementary", { name: "对象属性" }),
  ).toBeVisible();
  await expect(panel.locator('[data-object-id="part-93"]')).toHaveClass(
    /active/,
  );
  await page.getByRole("button", { name: "关闭场景列表" }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "对象属性" })).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
});
