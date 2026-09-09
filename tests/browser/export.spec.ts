import { test, expect } from "@playwright/test";
import type { Snapshot, VideoRecord } from "../../src/types";

test("统一导出保留各类型设置，模型下载与真实视频录制均在同页完成", async ({
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
  await page.addInitScript(() =>
    localStorage.setItem("forma-project", "export-test"),
  );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    let json: unknown;
    if (url === "/api/session") json = { token: "test-session" };
    else if (url === "/api/blender/status") json = { installed: false, connected: false, state: "closed" };
    else if (url === "/api/health") json = { ok: true, codex: { ok: true } };
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
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "渲染出图", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByRole("heading", { name: "导出作品" })).toBeVisible();
  await expect(page.locator(".export-backdrop")).toHaveCount(0);
  const tab = (name: string) => page.getByRole("tab", { name, exact: true });
  await expect(tab("图片")).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("画面比例", { exact: true }).selectOption("portrait");
  await page.getByRole("checkbox", { name: "透明背景" }).check();
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeEnabled();
  expect(renders[0].settings).toMatchObject({
    width: 720,
    height: 1280,
    transparent: true,
  });
  await tab("模型").click();
  for (const [label, ext] of [
    ["通用三维模型", "glb"],
    ["Blender 源文件", "blend"],
  ]) {
    await page.getByRole("radio", { name: new RegExp(label) }).check();
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: `下载模型 · .${ext}` }).click();
    expect((await download).suggestedFilename()).toBe(`model.${ext}`);
  }
  await page.screenshot({ path: testInfo.outputPath("export-model.png") });
  await tab("视频").click();
  await expect(page.getByLabel("视频宽度")).toHaveValue("1280");
  await expect(page.locator(".viewport-surface")).not.toHaveClass(
    /transparent/,
  );
  await page.getByLabel("视频宽度").fill("320");
  await page.getByLabel("视频高度").fill("480");
  await expect(page.getByLabel("视频比例")).toHaveValue("");
  await expect
    .poll(async () => {
      const b = (await page.locator(".viewport-surface").boundingBox())!;
      return Math.abs(b.width / b.height - 2 / 3);
    })
    .toBeLessThan(0.002);
  await page.screenshot({ path: testInfo.outputPath("export-video.png") });
  await page.getByRole("button", { name: "进入录制模式" }).click();
  await expect(page.getByRole("region", { name: "视频录制" })).toContainText("60 fps");
  await expect(tab("图片")).toBeDisabled();
  await expect(page.getByRole("button", { name: "返回工作台" })).toBeDisabled();
  await page.getByRole("button", { name: "开始录制", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "停止录制", exact: true }).click();
  const result = page.getByRole("dialog", { name: "录制结果" });
  await expect(result).toBeVisible();
  await expect
    .poll(() =>
      result
        .locator("video")
        .evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight]),
    )
    .toEqual([320, 480]);
  await result.screenshot({ path: testInfo.outputPath("video-result.png") });
  await result.getByRole("button", { name: "保存到作品", exact: true }).click();
  await expect(
    result.getByRole("button", { name: "已保存到作品" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "退出录制模式" }).click();
  await expect(tab("视频")).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("link", { name: "下载视频", exact: true }),
  ).toBeVisible();
  await tab("图片").click();
  await expect(page.getByLabel("图片宽度")).toHaveValue("720");
  await expect(page.getByRole("checkbox", { name: "透明背景" })).toBeChecked();
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect.poll(() => renders.length).toBe(2);
  for (const key of ["position", "target", "up"])
    renders[0].camera[key].forEach((v: number, i: number) =>
      expect(renders[1].camera[key][i]).toBeCloseTo(v, 3),
    );
  expect(renders[1].camera.aspect).toBeCloseTo(720 / 1280, 3);
  await tab("模型").click();
  await expect(
    page.getByRole("radio", { name: /Blender 源文件/ }),
  ).toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("link", { name: "下载模型 · .blend" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("export-mobile.png") });
  await page.getByRole("button", { name: "返回工作台" }).click();
  await expect(page.locator(".workbench")).not.toHaveClass(/is-image-export/);
  expect(errors).toEqual([]);
});
