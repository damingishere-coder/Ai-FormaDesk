import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot, Job } from "../../src/types";
const evidence = path.resolve("data/acceptance");
test("已保存真实场景的渲染、导出、失效提示与变换控件", async ({ page }) => {
  await page.goto("/");
  if (
    !(await page
      .getByRole("dialog", { name: "作品库", exact: true })
      .isVisible())
  )
    await page.locator(".project-trigger").click();
  await page
    .getByRole("button", { name: /预览 木桌与绿灯 · V1 验收/ })
    .last()
    .click();
  await page.getByRole("button", { name: "打开编辑", exact: true }).click();
  await expect(page.locator(".project-trigger")).toContainText("木桌与绿灯");
  const pid = await page.evaluate(() => localStorage.getItem("forma-project"));
  const { token } = await (await page.request.get("/api/session")).json();
  const headers = { "X-Forma-Session": token };
  const snap = async () =>
    (await (
      await page.request.get(`/api/projects/${pid}/scene`)
    ).json()) as Snapshot;
  async function settle() {
    await expect
      .poll(async () => !!(await snap()).activeJob, { timeout: 240000 })
      .toBe(false);
    await expect(page.locator(".save-indicator")).not.toContainText("处理中");
    expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    return snap();
  }
  let s = await snap();
  const lamp = s.scene.objects.find(
    (o) => o.type === "EMPTY" && /台灯/.test(o.name),
  )!;
  await page.getByRole("button", { name: /^场景 ·/ }).click();
  await page.locator(`[data-object-id="${lamp.id}"]`).click();
  await page.getByRole("button", { name: "关闭场景列表" }).click();
  await page.getByRole("button", { name: "应用并保存" }).click();
  await expect
    .poll(async () => (await snap()).project.currentRevisionId)
    .not.toBe(s.project.currentRevisionId);
  s = await settle();
  await page.getByRole("button", { name: "移动", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: path.join(evidence, "gizmo-1536.png"),
    timeout: 15000,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({
    path: path.join(evidence, "final-properties-1280.png"),
    timeout: 15000,
  });
  await page.getByRole("textbox", { name: "创作想法" }).fill("wer");
  await expect(
    page.getByRole("button", { name: "移动", exact: true }),
  ).toHaveClass(/active/);
  await page.getByRole("textbox", { name: "创作想法" }).fill("");
  await page.getByRole("button", { name: "关闭属性面板" }).click();
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page
    .getByRole("combobox", { name: "观察视角" })
    .selectOption("perspective");
  await page.getByRole("button", { name: "适应画布" }).click();
  await page.screenshot({
    path: path.join(evidence, "final-workbench-1536.png"),
    timeout: 15000,
  });
  const pending = page.waitForResponse(
    (r) => r.url().endsWith("/render") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "渲染出图", exact: true }).click();
  await page
    .getByRole("button", { name: "按当前视角渲染", exact: true })
    .click();
  const j = (await (await pending).json()) as Job;
  await expect
    .poll(
      async () => {
        const job = (await (
          await page.request.get(`/api/jobs/${j.id}`)
        ).json()) as Job;
        if (job.status === "failed") throw new Error(job.error!);
        return job.status;
      },
      { timeout: 240000 },
    )
    .toBe("succeeded");
  s = await settle();
  await expect(
    page.getByAltText("Blender 成品图", { exact: true }),
  ).toBeVisible();
  expect(s.render!.revisionId).toBe(s.project.currentRevisionId);
  await page.screenshot({
    path: path.join(evidence, "final-render-1536.png"),
    timeout: 15000,
  });
  await page.getByRole("button", { name: "关闭成品图" }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  for (const title of ["Blender 源文件", "通用三维模型", "下载原图"]) {
    if (title === "下载原图")
      await page.getByRole("button", { name: "效果图", exact: true }).click();
    const pending = page.waitForEvent("download");
    await page.getByRole("link").filter({ hasText: title }).click();
    const download = await pending;
    await download.saveAs(path.join(evidence, download.suggestedFilename()));
    expect(await download.failure()).toBe(null);
  }
  await page.getByRole("button", { name: "关闭导出" }).click();
  fs.writeFileSync(
    path.join(evidence, "final-scene.json"),
    JSON.stringify(s, null, 2),
  );
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await page.getByRole("button", { name: /^场景 ·/ }).click();
  await page.locator(`[data-object-id="${lamp.id}"]`).click();
  await page.getByRole("button", { name: "关闭场景列表" }).click();
  await page.getByRole("button", { name: "应用并保存" }).click();
  await expect
    .poll(async () => (await snap()).project.currentRevisionId)
    .not.toBe(s.project.currentRevisionId);
  const changed = await settle();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "查看成品图", exact: true }).click();
  await expect(page.locator(".render-caption")).toContainText("需要重新渲染");
  const r = await page.request.post(`/api/projects/${pid}/restore`, {
    headers,
    data: {
      baseRevisionId: changed.project.currentRevisionId,
      revisionId: s.project.currentRevisionId,
      action: "restore",
    },
  });
  expect(r.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.getByRole("button", { name: "查看成品图", exact: true }).click();
  expect((await snap()).project.currentRevisionId).toBe(s.render!.revisionId);
  fs.writeFileSync(
    path.join(evidence, "render-browser-result.json"),
    JSON.stringify(
      {
        passed: true,
        pid,
        renderJob: j.id,
        revision: s.project.currentRevisionId,
        render: s.render,
      },
      null,
      2,
    ),
  );
  console.log("RENDER_EXPORT_PASSED", pid, s.project.currentRevisionId);
});
