import { test, expect } from "@playwright/test";
import type { Snapshot, VideoRecord } from "../../src/types";

test("录制结果可逐层返回和直达工作台，失败重试保留视频", async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1195, height: 837 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const positions = Buffer.from(
    new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]).buffer,
  );
  const gltf = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, extras: { forma_id: "object" } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [
      {
        byteLength: positions.length,
        uri: `data:application/octet-stream;base64,${positions.toString("base64")}`,
      },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [-1, 0, 0],
        max: [1, 2, 0],
      },
    ],
  };
  const scene: Snapshot["scene"] = {
    units: "meters",
    coordinates: "blender-z-up",
    stats: { objects: 1, vertices: 3, triangles: 1 },
    objects: [
      {
        id: "object",
        name: "测试模型",
        type: "MESH",
        parentId: null,
        visible: true,
        material: null,
        light: null,
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [1, 1, 1],
        },
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    ],
  };
  const snapshot: Snapshot = {
    project: {
      id: "export-test",
      name: "统一导出测试",
      currentRevisionId: "revision",
      redo: [],
      threadId: null,
      createdAt: new Date().toISOString(),
    },
    revision: {
      id: "revision",
      projectId: "export-test",
      parentId: null,
      source: "generate",
      label: "测试",
      createdAt: new Date().toISOString(),
      scene,
      artifacts: {
        blend: "model-blend",
        glb: "model-glb",
        script: "",
        manifest: "",
        log: "",
      },
    },
    scene,
    previewUrl: "/api/artifacts/preview",
    render: null,
    activeJob: null,
    messages: [],
    proposals: [],
    videos: [],
  };
  const renders: any[] = [];
  let video: VideoRecord;
  let videoBytes: Buffer | null = null;
  let uploadCount = 0, createCount = 0, failNextUpload = false;
  await page.addInitScript(() =>
    localStorage.setItem("forma-project", "export-test"),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    let json: unknown;
    if (url === "/api/session") json = { token: "test-session" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
    else if (url === "/api/blender/status") json = { sessions: [] };
    else if (url.endsWith("/opened")) json = snapshot.project;
    else if (url === "/api/projects") json = [snapshot.project];
    else if (url.endsWith("/scene")) json = snapshot;
    else if (url === "/api/artifacts/preview") json = gltf;
    else if (url.includes("/api/artifacts/model-")) {
      const ext = url.endsWith("blend") ? "blend" : "glb";
      await route.fulfill({
        contentType: "application/octet-stream",
        headers: {
          "Content-Disposition": `attachment; filename="model.${ext}"`,
        },
        body: `test-model-${ext}`,
      });
      return;
    } else if (url.endsWith("/render")) {
      renders.push(route.request().postDataJSON());
      await route.fulfill({
        status: 500,
        json: { error: "测试中的可重试渲染错误" },
      });
      return;
    } else if (url.endsWith("/videos")) {
      createCount++;
      const body = route.request().postDataJSON();
      expect(body.baseRevisionId).toBe("revision");
      expect(body.settings).toMatchObject({ mode: "realtime", fps: 60 });
      expect(body.samples.length).toBeGreaterThan(1);
      expect(
        body.samples.every(
          (s: any) => Math.abs(s.camera.aspect - 2 / 3) < 0.001,
        ),
      ).toBe(true);
      video = {
        id: "video",
        projectId: "export-test",
        revisionId: "revision",
        settings: body.settings,
        duration: body.samples.at(-1).time,
        status: "recorded",
        createdAt: new Date().toISOString(),
      } as VideoRecord;
      json = video;
    } else if (url.endsWith("/upload")) {
      uploadCount++;
      if (failNextUpload) { failNextUpload = false; return route.fulfill({ status: 500, json: { error: "测试上传失败" } }); }
      videoBytes = route.request().postDataBuffer();
      expect(videoBytes!.length).toBeGreaterThan(100);
      video.artifactId = "saved-video";
      snapshot.videos = [video];
      json = video;
    } else if (url.endsWith("/saved-video")) {
      await route.fulfill({ contentType: "video/mp4", body: videoBytes! });
      return;
    } else throw new Error(`Unexpected API request: ${url}`);
    await route.fulfill({ json });
  });
  await page.goto(process.env.VIDEO_NAV_BASE || "/");
  if (process.env.VIDEO_NAV_HOME) await page.getByRole("button", { name: `打开 ${snapshot.project.name}`, exact: true }).click();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("tab", { name: "视频", exact: true }).click();
  await page.getByLabel("视频宽度").fill("320");
  await page.getByLabel("视频高度").fill("480");
  const result = page.getByRole("dialog", { name: "录制结果", exact: true });
  async function recordShort() {
    await page.getByRole("button", { name: "进入录制模式", exact: true }).click();
    await page.getByRole("button", { name: "开始录制", exact: true }).click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "停止录制", exact: true }).click();
    await expect(result).toBeVisible();
    await expect(result.locator("video")).toBeVisible();
  }
  // The ready layer has an explicit back action and creates no empty recording.
  await page.getByRole("button", { name: "进入录制模式", exact: true }).click();
  await page.getByRole("button", { name: "返回导出设置", exact: true }).click();
  expect(createCount).toBe(0);
  await recordShort();
  await expect(page.getByRole("region", { name: "视频录制" })).toHaveCount(0);
  await result.screenshot({ path: testInfo.outputPath("video-navigation-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(result.getByRole("button", { name: "返回导出设置", exact: true })).toBeInViewport();
  await expect(result.getByRole("button", { name: "返回作品工作台", exact: true })).toBeInViewport();
  expect(await result.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("video-navigation-mobile.png") });
  await page.setViewportSize({ width: 1195, height: 837 });
  await result.getByRole("button", { name: "播放镜头路线", exact: true }).click();
  await page.getByRole("button", { name: "返回录制结果", exact: true }).click();
  await expect(result).toBeVisible();
  // Failure must keep the blob and its download link; retry must reuse the record.
  const blobUrl = await result.locator("video").getAttribute("src");
  failNextUpload = true;
  await result.getByRole("button", { name: "返回导出设置", exact: true }).click();
  await expect(result.getByRole("alert")).toContainText("测试上传失败");
  await expect(result.locator("video")).toHaveAttribute("src", blobUrl!);
  await expect(result.getByRole("link", { name: "下载视频", exact: true })).toBeVisible();
  expect(createCount).toBe(1);
  await result.getByRole("button", { name: "返回导出设置", exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "导出作品" })).toBeVisible();
  await expect(page.getByRole("button", { name: "返回工作台", exact: true })).toBeEnabled();
  await expect(page.getByLabel("视频宽度")).toHaveValue("320");
  expect(createCount).toBe(1);
  expect(uploadCount).toBe(2);
  // Saved results return directly to the editor without uploading twice.
  await recordShort();
  await result.getByRole("button", { name: "保存到作品", exact: true }).click();
  await expect(result.getByRole("button", { name: "已保存到作品", exact: true })).toBeVisible();
  const uploadsBeforeExit = uploadCount;
  await result.getByRole("button", { name: "返回作品工作台", exact: true }).click();
  await expect(result).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "导出作品" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "导出", exact: true })).toBeVisible();
  expect(uploadCount).toBe(uploadsBeforeExit);
  // Escape goes up one layer, preserving a fresh result before returning.
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await page.getByRole("tab", { name: "视频", exact: true }).click();
  await recordShort();
  await page.keyboard.press("Escape");
  await expect(result).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "导出作品" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "导出作品" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
