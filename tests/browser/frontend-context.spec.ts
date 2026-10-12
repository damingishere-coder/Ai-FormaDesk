import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import type { Job, Snapshot } from "../../src/types";

const day = "2026-10-12T00:00:00Z";
function makeJob(pid: string, id: string, type = "discuss", status: Job["status"] = "running"): Job {
  return { id, projectId: pid, baseRevisionId: `revision-${pid}`, type, status, stage: `${pid} 的当前任务`, createdAt: day, updatedAt: day, error: null, resultRevisionId: null, message: "" };
}
function makeSnapshot(id: string): Snapshot {
  const scene: Snapshot["scene"] = {
    units: "meters", coordinates: "blender-z-up", stats: { objects: 1, vertices: 0, triangles: 0 },
    objects: [{ id: `part-${id}`, name: "测试部件", type: "EMPTY", parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], visible: true, material: null, light: null }],
  };
  return {
    project: { id, name: `作品 ${id}`, threadId: null, currentRevisionId: `revision-${id}`, createdAt: day, redo: [] },
    revision: { id: `revision-${id}`, projectId: id, parentId: null, source: "command", label: "初始版本", createdAt: day, scene, artifacts: { blend: "", glb: "", script: "", manifest: "", log: "" } },
    scene, previewUrl: null, activeJob: null, jobs: [], videos: [], render: null, messages: [], proposals: [],
  };
}
async function setup(page: Page) {
  const snapshots = { a: makeSnapshot("a"), b: makeSnapshot("b") };
  const handlers: Record<string, (route: Route) => Promise<void>> = {};
  const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("forma-project", "a");
    (window as any).mockStreams = [];
    (window as any).EventSource = class {
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { (window as any).mockStreams.push(this); }
      close() {}
    };
  });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()).pathname;
    if (request.method() !== "GET") writes.push(url);
    if (handlers[url]) return handlers[url](route);
    let json: unknown;
    if (url === "/api/session") json = { token: "fixture" };
    else if (url === "/api/health") json = { ok: true, checking: false, codex: { ok: true }, blender: { ok: true }, sandbox: { ok: true } };
    else if (url === "/api/blender/status") json = { installed: true, connected: true, state: "connected", projectId: "a", baseRevisionId: "revision-a" };
    else if (url === "/api/projects") json = Object.values(snapshots).map(value => value.project);
    else {
      const project = url.match(/^\/api\/projects\/([ab])\/(scene|opened|revisions)$/);
      if (project) {
        const snapshot = snapshots[project[1] as "a" | "b"];
        json = project[2] === "scene" ? snapshot : project[2] === "revisions" ? [snapshot.revision] : snapshot.project;
      } else if (url.startsWith("/api/jobs/")) {
        json = Object.values(snapshots).flatMap(value => value.jobs || []).find(value => value.id === url.split("/").at(-1));
        if (!json) throw new Error(`Unexpected job read: ${url}`);
      } else throw new Error(`Unexpected API request: ${request.method()} ${url}`);
    }
    await route.fulfill({ json });
  });
  return { snapshots, handlers, writes, errors };
}
async function open(page: Page, name = "a") {
  await expect(page.locator(".workbench")).toBeVisible();
  if (!await page.locator(".project-home").count())
    await page.locator(".project-trigger").click();
  await page.getByRole("button", { name: `打开 作品 ${name}`, exact: true }).click();
  await expect(page.locator(".project-trigger")).toContainText(`作品 ${name}`);
  await expect(page.getByPlaceholder(/说说你的想法/)).toBeVisible();
}

for (const entry of ["sync", "edit", "video", "retry"] as const) {
  for (const reply of ["success", "failure"] as const) {
    test(`${entry} 的迟到 ${reply} 响应不覆盖新作品任务或释放新提交锁`, async ({ page }) => {
      const fixture = await setup(page);
      if (entry === "retry") fixture.snapshots.a.jobs = [{ ...makeJob("a", "failed-a", "generate", "failed"), request: { prompt: "测试", attachmentIds: [], objectId: null }, error: "可重试的旧任务" }];
      if (entry === "video") fixture.snapshots.a.videos = [{ id: "video-a", projectId: "a", revisionId: "revision-a", settings: { width: 1280, height: 720, fps: 30, mode: "blender" }, createdAt: day, duration: 1, status: "recorded", trajectory: { baseRevisionId: "revision-a", settings: { width: 1280, height: 720, fps: 30, mode: "blender" }, samples: [] } }];
      let releaseA: (() => Promise<void>) | undefined, releaseB: (() => Promise<void>) | undefined;
      const endpoint = entry === "retry" ? "/api/jobs/failed-a/retry" : entry === "video" ? "/api/projects/a/videos/video-a/render" : `/api/projects/a/blender/${entry}`;
      fixture.handlers[endpoint] = route => new Promise<void>(resolve => {
        releaseA = async () => {
          const job = makeJob("a", "accepted-a", entry === "retry" ? "generate" : entry === "video" ? "video" : `blender-${entry}`);
          if (reply === "success") { fixture.snapshots.a.activeJob = job; fixture.snapshots.a.jobs!.push(job); }
          await route.fulfill({ status: reply === "success" ? 202 : 400, json: reply === "success" ? job : { error: "旧作品错误不应显示" } });
          resolve();
        };
      });
      fixture.handlers["/api/projects/b/discuss"] = route => new Promise<void>(resolve => {
        releaseB = async () => {
          const job = makeJob("b", "accepted-b");
          fixture.snapshots.b.activeJob = job; fixture.snapshots.b.jobs!.push(job);
          await route.fulfill({ status: 202, json: job }); resolve();
        };
      });
      await page.goto("/");
      await open(page);
      if (entry === "sync" || entry === "edit") {
        if (entry === "edit") {
          await page.getByRole("button", { name: "场景 · 1", exact: true }).click();
          await page.locator('[data-object-id="part-a"]').click();
        }
        await page.getByRole("button", { name: "Blender 联动", exact: true }).click();
        if (entry === "edit") {
          await page.getByRole("textbox", { name: "Blender 局部调整" }).fill("调整测试部件");
          await page.getByRole("button", { name: "执行调整并同步" }).click();
        } else await page.getByRole("button", { name: "同步回工作台" }).click();
      } else if (entry === "video") {
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await page.getByRole("tab", { name: "视频", exact: true }).click();
        await page.getByRole("button", { name: "继续生成视频" }).click();
        await page.getByRole("button", { name: "返回工作台", exact: true }).click();
      } else await page.getByRole("button", { name: "重试建模", exact: true }).click();
      await expect.poll(() => !!releaseA).toBe(true);
      await open(page, "b");
      const input = page.getByPlaceholder(/说说你的想法/);
      await expect(input).toBeEnabled();
      await input.fill("作品 b 的新请求"); await input.press("Enter");
      await expect.poll(() => !!releaseB).toBe(true);
      await expect(input).toBeDisabled();
      await releaseA!();
      await expect(input).toBeDisabled();
      await expect(page.locator(".project-trigger")).toContainText("作品 b");
      await expect(page.getByText("旧作品错误不应显示", { exact: true })).toHaveCount(0);
      await releaseB!();
      await expect(page.locator(".composer-footer")).toContainText("b 的当前任务");
      expect(fixture.writes.filter(value => value === endpoint)).toHaveLength(1);
      expect(fixture.errors).toEqual([]);
    });
  }
}

test("任务已接受但响应断开时读取快照恢复，不重发模型请求", async ({ page }) => {
  const fixture = await setup(page);
  fixture.handlers["/api/projects/a/discuss"] = async route => {
    const job = makeJob("a", "accepted-on-server");
    fixture.snapshots.a.activeJob = job; fixture.snapshots.a.jobs!.push(job);
    await route.abort("failed");
  };
  await page.goto("/"); await open(page);
  const input = page.getByPlaceholder(/说说你的想法/);
  await input.fill("这段内容只提交一次"); await input.press("Enter");
  await expect(page.getByRole("status")).toContainText("后台已接受任务");
  await expect(input).toHaveValue("");
  await expect(page.locator(".composer-footer")).toContainText("a 的当前任务");
  expect(fixture.writes.filter(value => value.endsWith("/discuss"))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test("已接受且完成的写请求保留首次核对快照，二次刷新断线不保留重发草稿", async ({ page }) => {
  const fixture = await setup(page);
  let accepted = false, recoveryReads = 0;
  fixture.handlers["/api/projects/a/discuss"] = async route => {
    const job = makeJob("a", "completed-on-server", "discuss", "succeeded");
    fixture.snapshots.a.jobs!.push(job);
    fixture.snapshots.a.messages.push({ id: "completed-reply", projectId: "a", role: "assistant", text: "后台已完成且只调用一次的回复", jobId: job.id, status: "completed", createdAt: day });
    accepted = true;
    await route.abort("failed");
  };
  fixture.handlers["/api/projects/a/scene"] = async route => {
    if (accepted && ++recoveryReads > 1) return route.abort("failed");
    await route.fulfill({ json: fixture.snapshots.a });
  };
  await page.goto("/"); await open(page);
  const input = page.getByPlaceholder(/说说你的想法/);
  await input.fill("已经被接受，不能作为未提交草稿再发送"); await input.press("Enter");
  await expect(page.getByRole("status")).toContainText("后台已接受任务");
  await expect(page.getByText("后台已完成且只调用一次的回复", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(recoveryReads).toBe(2);
  expect(fixture.writes.filter(value => value.endsWith("/discuss"))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test("二次刷新断线时仍拒绝错误作品的首次核对快照", async ({ page }) => {
  const fixture = await setup(page);
  let sent = false, recoveryReads = 0;
  const foreign = makeJob("b", "foreign-completed", "discuss", "succeeded");
  fixture.snapshots.b.jobs!.push(foreign);
  fixture.snapshots.b.messages.push({ id: "foreign-reply", projectId: "b", role: "assistant", text: "其他作品的回复不能进入当前界面", jobId: foreign.id, status: "completed", createdAt: day });
  fixture.handlers["/api/projects/a/discuss"] = async route => { sent = true; await route.abort("failed"); };
  fixture.handlers["/api/projects/a/scene"] = async route => {
    if (!sent) return route.fulfill({ json: fixture.snapshots.a });
    if (++recoveryReads === 1) return route.fulfill({ json: fixture.snapshots.b });
    await route.abort("failed");
  };
  await page.goto("/"); await open(page);
  const input = page.getByPlaceholder(/说说你的想法/);
  await input.fill("错误归属时必须保留"); await input.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("错误归属时必须保留");
  await expect(input).toBeEnabled();
  await expect(page.getByText("其他作品的回复不能进入当前界面", { exact: true })).toHaveCount(0);
  await expect(page.locator(".project-trigger")).toContainText("作品 a");
  expect(recoveryReads).toBe(2);
  expect(fixture.writes.filter(value => value.endsWith("/discuss"))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test("错误归属的成功响应不接收为当前任务，也不丢弃当前草稿", async ({ page }) => {
  const fixture = await setup(page);
  fixture.handlers["/api/projects/a/discuss"] = route => route.fulfill({ status: 202, json: makeJob("b", "wrong-owner") });
  await page.goto("/"); await open(page);
  const input = page.getByPlaceholder(/说说你的想法/);
  await input.fill("必须保留的草稿"); await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("任务归属无法确认");
  await expect(input).toHaveValue("必须保留的草稿");
  await expect(input).toBeEnabled();
  expect(fixture.writes.filter(value => value.endsWith("/discuss"))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test("旧视频取消的迟到错误不污染同一作品的新视频任务", async ({ page }) => {
  const fixture = await setup(page);
  const old = makeJob("a", "old-video", "video");
  fixture.snapshots.a.activeJob = old; fixture.snapshots.a.jobs = [old];
  fixture.snapshots.a.videos = [{ id: "video-a", projectId: "a", revisionId: "revision-a", settings: { width: 1280, height: 720, fps: 30, mode: "blender" }, createdAt: day, duration: 1, status: "recorded", trajectory: { baseRevisionId: "revision-a", settings: { width: 1280, height: 720, fps: 30, mode: "blender" }, samples: [] } }];
  let release: (() => Promise<void>) | undefined;
  fixture.handlers["/api/jobs/old-video/cancel"] = route => new Promise<void>(resolve => {
    release = async () => { await route.fulfill({ status: 400, json: { error: "旧视频取消失败" } }); resolve(); };
  });
  fixture.handlers["/api/projects/a/videos/video-a/render"] = async route => {
    const next = makeJob("a", "new-video", "video");
    fixture.snapshots.a.activeJob = next; fixture.snapshots.a.jobs!.push(next);
    await route.fulfill({ status: 202, json: next });
  };
  await page.goto("/"); await open(page);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("tab", { name: "视频", exact: true }).click();
  await page.getByRole("button", { name: "停止渲染", exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  old.status = "succeeded"; fixture.snapshots.a.activeJob = null;
  await page.evaluate(value => (window as any).mockStreams.find((stream: any) => stream.url.includes("old-video")).onmessage({ data: JSON.stringify(value) }), old);
  await page.getByRole("button", { name: "继续生成视频", exact: true }).click();
  await expect(page.locator(".previous-render").first()).toContainText("a 的当前任务");
  await release!();
  await expect(page.getByText("旧视频取消失败", { exact: true })).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});

test("切作品后的明确拒绝仍保留原作品讨论草稿，不把失败当接受", async ({ page }) => {
  const fixture = await setup(page);
  let release: (() => Promise<void>) | undefined;
  fixture.handlers["/api/projects/a/discuss"] = route => new Promise<void>(resolve => {
    release = async () => { await route.fulfill({ status: 400, json: { error: "原作品明确拒绝" } }); resolve(); };
  });
  await page.goto("/"); await open(page);
  await page.getByPlaceholder(/说说你的想法/).fill("回到作品 a 之后需要保留");
  await page.getByPlaceholder(/说说你的想法/).press("Enter");
  await expect.poll(() => !!release).toBe(true);
  await open(page, "b"); await release!();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByPlaceholder(/说说你的想法/)).toHaveValue("");
  await open(page, "a");
  await expect(page.getByPlaceholder(/说说你的想法/)).toHaveValue("回到作品 a 之后需要保留");
  expect(fixture.writes.filter(value => value.endsWith("/discuss"))).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
});

test("健康轮询和重新检查失败可重试并标记旧结果，无未处理错误", async ({ page }) => {
  await page.clock.install();
  const fixture = await setup(page);
  let reads = 0;
  fixture.handlers["/api/health"] = async route => {
    reads++;
    await route.fulfill(reads === 1 ? { json: { ok: true, checking: true, codex: { ok: true } } } : { status: 500, json: { error: "健康读取断线" } });
  };
  fixture.handlers["/api/health/recheck"] = route => route.fulfill({ status: 500, json: { error: "环境检查失败" } });
  await page.goto("/"); await open(page);
  await page.clock.fastForward(2000);
  await page.getByRole("button", { name: "环境检查", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "环境检查", exact: true });
  await expect(panel.getByRole("alert")).toContainText("上次检查结果已过期");
  await expect(panel.getByRole("button", { name: "重新检查" })).toBeEnabled();
  await panel.getByRole("button", { name: "重新检查" }).click();
  await expect(panel.getByRole("alert")).toContainText("环境检查失败");
  await expect(panel.getByRole("button", { name: "重新检查" })).toBeEnabled();
  expect(fixture.errors).toEqual([]);
});

test("Blender 状态失败撤下连接徽标、禁止用旧状态同步并允许刷新", async ({ page }) => {
  await page.clock.install();
  const fixture = await setup(page);
  let offline = false;
  fixture.handlers["/api/blender/status"] = route => route.fulfill(offline ? { status: 500, json: { error: "连接查询失败" } } : { json: { installed: true, connected: true, state: "connected", projectId: "a", baseRevisionId: "revision-a" } });
  await page.goto("/"); await open(page);
  await page.getByRole("button", { name: "Blender 联动", exact: true }).click();
  await expect(page.locator(".blender-dot")).toBeVisible();
  offline = true;
  await page.clock.fastForward(5100);
  await expect(page.getByRole("alert")).toContainText("连接状态已过期");
  await expect(page.locator(".blender-dot")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "同步回工作台" })).toBeDisabled();
  offline = false;
  await page.getByRole("button", { name: "刷新连接状态" }).click();
  await expect(page.locator(".blender-dot")).toBeVisible();
  await expect(page.getByRole("button", { name: "同步回工作台" })).toBeEnabled();
  expect(fixture.errors).toEqual([]);
});

test("任务流坏 JSON 与旧项目轮询错误不形成未处理异常", async ({ page }) => {
  const fixture = await setup(page);
  const job = makeJob("a", "current-a");
  fixture.snapshots.a.activeJob = job; fixture.snapshots.a.jobs = [job];
  fixture.handlers["/api/jobs/current-a"] = route => route.fulfill({ status: 500, json: { error: "当前任务读取失败" } });
  await page.goto("/"); await open(page);
  await page.waitForFunction(() => (window as any).mockStreams.some((stream: any) => stream.url.includes("current-a")));
  await page.evaluate(() => (window as any).mockStreams.find((stream: any) => stream.url.includes("current-a")).onmessage({ data: "not-json" }));
  await expect(page.getByRole("alert")).toContainText("任务状态无法确认");
  await open(page, "b");
  await page.evaluate(() => (window as any).mockStreams.find((stream: any) => stream.url.includes("current-a")).onerror());
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.errors).toEqual([]);
});
