import { test, expect } from "@playwright/test";

test("细节失败保留基础预览说明，重试刷新失败不产生未处理错误", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const pid = "preview-progress", revisionId = "saved-model";
  let job: any = { id: "detail-failed", projectId: pid, baseRevisionId: revisionId, type: "preview", status: "failed", stage: "模型已保存，预览细节未完成", stageIndex: 3, title: "摩托", error: "模拟超时", resultRevisionId: revisionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  const project = { id: pid, name: "预览恢复测试", currentRevisionId: revisionId, threadId: null, createdAt: new Date().toISOString(), redo: [] };
  let retry = false;
  await page.addInitScript(id => localStorage.setItem("forma-project", id), pid);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()).pathname;
    let json: any = {};
    if (url === "/api/session") json = { token: "test-session" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
    else if (url === "/api/blender/status") json = { sessions: [] };
    else if (url === "/api/projects") json = [project];
    else if (url.endsWith("/scene")) {
      if (retry) return route.fulfill({ status: 500, json: { error: "测试刷新失败" } });
      json = { project, revision: { id: revisionId, preview: { status: "failed" }, artifacts: {} }, scene: { objects: [], stats: { objects: 0, vertices: 0, triangles: 0 }, units: "meters", coordinates: "blender-z-up" }, previewUrl: null, activeJob: null, jobs: [job], messages: [], proposals: [], render: null };
    } else if (url.endsWith("/retry")) {
      expect(url).toBe("/api/jobs/detail-failed/retry");
      retry = true;
      job = { ...job, id: "detail-retry", status: "running", stage: "生成预览细节", error: null };
      return route.fulfill({ status: 202, json: job });
    } else if (url.endsWith("/events")) return route.abort();
    else if (url === "/api/jobs/detail-retry") json = job;
    await route.fulfill({ json });
  });
  await page.goto("/");
  const flow = page.getByLabel("建模流程");
  await expect(flow).toBeVisible();
  await expect(flow).toContainText("模型和基础预览已保留");
  await expect(flow).not.toContainText("正在重新连接");
  await expect(page.getByText("已保存 · 基础预览", { exact: true })).toBeVisible();
  await flow.getByRole("button", { name: "继续生成预览细节" }).click();
  await expect(page.getByRole("alert")).toContainText("测试刷新失败");
  await expect(flow).toContainText("生成预览细节");
  await expect(page.getByPlaceholder(/说说你的想法/)).toBeEnabled();
  expect(retry).toBe(true);
  expect(errors).toEqual([]);
});

test("提交新任务后，晚到的旧预览事件不能覆盖新任务", async ({ page }) => {
  const pid = "preview-race", rid = "saved";
  const old: any = { id: "old-preview", projectId: pid, baseRevisionId: rid, type: "preview", status: "running", stage: "生成预览细节", stageIndex: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [] };
  const next = { ...old, id: "new-discussion", type: "discuss", stage: "正在讨论创作想法" };
  let current = old;
  const project = { id: pid, name: "预览竞态测试", currentRevisionId: rid, threadId: null, createdAt: new Date().toISOString(), redo: [] };
  await page.addInitScript(id => {
    localStorage.setItem("forma-project", id);
    (window as any).testStreams = [];
    (window as any).EventSource = class {
      onmessage: any; onerror: any;
      constructor(public url: string) { (window as any).testStreams.push(this); }
      close() {}
    };
  }, pid);
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()).pathname;
    let json: any = {};
    if (url === "/api/session") json = { token: "test" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
    else if (url === "/api/blender/status") json = { sessions: [] };
    else if (url === "/api/projects") json = [project];
    else if (url.endsWith("/scene")) json = { project, revision: { id: rid, preview: { status: "processing" }, artifacts: {} }, scene: { objects: [], stats: { objects: 0, vertices: 0, triangles: 0 }, units: "meters", coordinates: "blender-z-up" }, previewUrl: null, activeJob: current, jobs: [old, ...(current === next ? [next] : [])], messages: [], proposals: [], render: null };
    else if (url.endsWith("/discuss")) { current = next; json = next; }
    else if (url.includes("/api/jobs/")) json = current;
    await route.fulfill({ json });
  });
  await page.goto("/");
  await expect(page.getByLabel("建模流程")).toBeVisible();
  await page.getByPlaceholder(/说说你的想法/).fill("先讨论车轮，不执行修改");
  await page.getByPlaceholder(/说说你的想法/).press("Enter");
  await expect.poll(() => current.id).toBe(next.id);
  await page.waitForFunction(() => (window as any).testStreams.some((s: any) => s.url.includes("new-discussion")));
  await page.evaluate(value => {
    const stream = (window as any).testStreams.find((s: any) => s.url.includes("old-preview"));
    stream.onmessage?.({ data: JSON.stringify({ ...value, status: "failed", error: "旧任务错误不应显示" }) });
  }, old);
  await expect(page.getByPlaceholder(/说说你的想法/)).toBeDisabled();
  await expect(page.getByText("旧任务错误不应显示")).toHaveCount(0);
  await expect(page.locator(".composer-footer")).toContainText("正在讨论创作想法");
});
