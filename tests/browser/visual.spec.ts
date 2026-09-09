import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import type { Snapshot, Job } from "../../src/types";
test("作品保存三视图入口、放大图片、失败检查记录与重开", async ({
  page,
}, info) => {
  const id = "visual-browser-test",
    now = "2026-09-08T00:00:00Z";
  const job: Job = {
    id: "visual-job",
    projectId: id,
    baseRevisionId: null,
    type: "generate",
    status: "failed",
    stage: "检查三视图一致性",
    error: "右视图比例不一致",
    resultRevisionId: null,
    createdAt: now,
    updatedAt: now,
    message: "",
    visual: {
      runId: "run-1",
      phase: "检查三视图一致性",
      assumptions: ["背面结构由 AI 推测"],
      evidence: ["原图", "正面参考图", "右侧参考图", "顶部参考图"].map(
        (label, i) => ({ artifactId: "view-" + i, label, kind: "image" }),
      ),
      reviews: [
        {
          phase: "三视图",
          round: 0,
          result: {
            acceptable: false,
            shapeIssues: ["右视图比例不一致"],
            textureIssues: [],
            lightingIssues: [],
            repair: "保持共同高度",
          },
        },
      ],
    },
  };
  const snapshot: Snapshot = {
    project: {
      id,
      name: "三视图测试作品",
      currentRevisionId: null,
      threadId: null,
      createdAt: now,
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
    jobs: [job],
    render: null,
    messages: [],
    proposals: [],
  };
  await page.addInitScript(
    (id) => localStorage.setItem("forma-project", id),
    id,
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    if (url.startsWith("/api/artifacts/")) {
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect x="20" y="20" width="88" height="88" fill="#438477"/></svg>',
      });
      return;
    }
    const json =
      url === "/api/session"
        ? { token: "test" }
        : url === "/api/health"
          ? { ok: true, codex: { ok: true } }
          : url === "/api/projects"
            ? [snapshot.project]
            : url.endsWith("/scene")
              ? snapshot
              : job;
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "参考与三视图", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "参考与三视图",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".visual-image-grid img")).toHaveCount(4);
  await dialog.getByRole("button", { name: "右侧参考图" }).click();
  await expect(
    page.getByRole("dialog", { name: "右侧参考图", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭大图" }).click();
  await dialog
    .getByText("AI 检查记录（不代表人工验收）", { exact: true })
    .click();
  await expect(
    dialog.locator("details").getByText("右视图比例不一致", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("references.png") });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "参考与三视图", exact: true }).click();
  await expect(dialog.locator(".visual-image-grid img")).toHaveCount(4);
});

test("真实烘焙 GLB 可以在网页加载面光源和贴图", async ({ page }, info) => {
  const root = path.resolve("data/visual-blender-proof/appearance");
  test.skip(
    !fs.existsSync(path.join(root, "scene.glb")),
    "先运行 verify-visual-blender.ts 生成真实产物",
  );
  const scene = JSON.parse(
    fs.readFileSync(path.join(root, "scene.json"), "utf8"),
  );
  const id = "baked-scene";
  const snapshot: any = {
    project: {
      id,
      name: "真实材质预览",
      currentRevisionId: "revision",
      threadId: null,
      createdAt: "2026-09-08",
      redo: [],
    },
    revision: { id: "revision", scene },
    scene,
    previewUrl: "/api/artifacts/model",
    activeJob: null,
    jobs: [],
    render: null,
    messages: [],
    proposals: [],
  };
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(
    (id) => localStorage.setItem("forma-project", id),
    id,
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    if (url === "/api/artifacts/model") {
      await route.fulfill({
        contentType: "model/gltf-binary",
        body: fs.readFileSync(path.join(root, "scene.glb")),
      });
      return;
    }
    await route.fulfill({
      json:
        url === "/api/session"
          ? { token: "test" }
          : url === "/api/health"
            ? { ok: true, codex: { ok: true } }
            : url === "/api/projects"
              ? [snapshot.project]
              : snapshot,
    });
  });
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByText("预览加载失败", { exact: false })).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("baked-web.png") });
});

test("网页采用保存的 AgX 与曝光，降低曝光确实降低模型亮度", async ({
  page,
}, info) => {
  const file = path.resolve("data/threeview-live/metal/pipeline/pipeline.json");
  test.skip(!fs.existsSync(file), "先生成金属验证样例");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  test.skip(!state.complete, "金属样例尚未通过检查");
  const scene = JSON.parse(
    fs.readFileSync(path.join(state.appearanceDir, "scene.json"), "utf8"),
  );
  const snapshot: any = {
    project: {
      id: "metal-exposure",
      name: "金属曝光验证",
      currentRevisionId: "revision",
      threadId: null,
      createdAt: "2026-09-08",
      redo: [],
    },
    revision: { id: "revision", scene },
    scene,
    previewUrl: "/api/artifacts/metal",
    activeJob: null,
    jobs: [],
    render: null,
    messages: [],
    proposals: [],
  };
  await page.addInitScript(() =>
    localStorage.setItem("forma-project", "metal-exposure"),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    if (url === "/api/artifacts/metal") {
      await route.fulfill({
        contentType: "model/gltf-binary",
        body: fs.readFileSync(path.join(state.appearanceDir, "scene.glb")),
      });
      return;
    }
    await route.fulfill({
      json:
        url === "/api/session"
          ? { token: "test" }
          : url === "/api/health"
            ? { ok: true, codex: { ok: true } }
            : url === "/api/projects"
              ? [snapshot.project]
              : snapshot,
    });
  });
  const sharp = (await import("sharp")).default;
  async function brightness() {
    await page.waitForTimeout(2000);
    const png = await page.locator("canvas").screenshot();
    const meta = await sharp(png).metadata();
    const stats = await sharp(png)
      .extract({
        left: Math.floor(meta.width! / 2) - 50,
        top: Math.floor(meta.height! / 2) - 50,
        width: 100,
        height: 100,
      })
      .stats();
    return stats.channels.slice(0, 3).reduce((sum, c) => sum + c.mean, 0) / 3;
  }
  await page.goto("/");
  const before = await brightness();
  expect(before).toBeLessThan(230);
  expect(before).toBeGreaterThan(50);
  await page.screenshot({ path: info.outputPath("metal-agx.png") });
  snapshot.scene.lighting.exposure -= 1;
  await page.reload();
  const after = await brightness();
  expect(after).toBeLessThan(before - 5);
});
