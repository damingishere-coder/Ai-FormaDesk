import { test, expect } from "@playwright/test";
import * as THREE from "three";
import sharp from "sharp";

// A small self-contained real glTF mesh; only the API is mocked.
function model() {
  const geometry = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  const position = Buffer.from(geometry.attributes.position.array.buffer);
  const normal = Buffer.from(geometry.attributes.normal.array.buffer);
  const bytes = Buffer.concat([position, normal]);
  return {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.8, 0.15, 0.1, 1],
          roughnessFactor: 0.6,
        },
      },
    ],
    buffers: [
      {
        byteLength: bytes.length,
        uri: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: position.length },
      { buffer: 0, byteOffset: position.length, byteLength: normal.length },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 36,
        type: "VEC3",
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5126, count: 36, type: "VEC3" },
    ],
  };
}

for (const failFirst of [false, true])
  test(`封面首次自动补齐、刷新保留、版本变化更新${failFirst ? "及失败重试" : ""}`, async ({
    page,
  }, info) => {
    const scene = {
      objects: [],
      stats: { objects: 1, vertices: 36, triangles: 12 },
      units: "meters",
      coordinates: "blender-z-up",
    };
    const projects = [
      {
        id: "empty",
        name: "空作品",
        currentRevisionId: null,
        threadId: null,
        createdAt: "2026-09-08",
        redo: [],
      },
      {
        id: "one",
        name: "红色方块",
        currentRevisionId: "rev-1",
        threadId: null,
        createdAt: "2026-09-08",
        redo: [],
      },
      {
        id: "two",
        name: "第二件作品",
        currentRevisionId: "rev-2",
        threadId: null,
        createdAt: "2026-09-08",
        redo: [],
      },
    ];
    const covers = new Map<string, Buffer>();
    let uploads = 0,
      failed = false;
    await page.addInitScript(() =>
      localStorage.setItem("forma-project", "empty"),
    );
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url()).pathname;
      if (url === "/api/artifacts/model")
        return route.fulfill({ json: model() });
      if (url.startsWith("/api/artifacts/cover-"))
        return route.fulfill({
          contentType: "image/png",
          body: covers.get(url.split("cover-")[1])!,
        });
      if (url.endsWith("/cover")) {
        uploads++;
        if (failFirst && !failed) {
          failed = true;
          return route.fulfill({
            status: 500,
            json: { error: "测试保存失败" },
          });
        }
        const body = route.request().postDataJSON();
        covers.set(
          body.revisionId,
          Buffer.from(body.image.split(",")[1], "base64"),
        );
        return route.fulfill({
          json: { coverUrl: `/api/artifacts/cover-${body.revisionId}` },
        });
      }
      if (url === "/api/projects")
        return route.fulfill({
          json: projects.map((p) => ({
            ...p,
            coverUrl: covers.has(p.currentRevisionId!)
              ? `/api/artifacts/cover-${p.currentRevisionId}`
              : null,
          })),
        });
      const p =
        projects.find((p) => url.includes(`/projects/${p.id}/`)) || projects[0];
      return route.fulfill({
        json:
          url === "/api/session"
            ? { token: "test" }
            : url === "/api/health"
              ? { ok: true, codex: { ok: true } }
              : {
                  project: p,
                  revision: p.currentRevisionId
                    ? { id: p.currentRevisionId }
                    : null,
                  scene,
                  previewUrl: p.currentRevisionId
                    ? "/api/artifacts/model"
                    : null,
                  activeJob: null,
                  jobs: [],
                  render: null,
                  messages: [],
                  proposals: [],
                },
      });
    });
    await page.goto("/");
    await page.locator(".project-trigger").click();
    await expect(
      page.locator('.project-card img[alt="第二件作品"]'),
    ).toBeVisible();
    if (failFirst) {
      await expect(page.getByText(/部分封面未能保存/)).toBeVisible();
      await page.getByRole("button", { name: "重试封面" }).click();
    }
    await expect(page.locator(".project-card img")).toHaveCount(2);
    expect(covers.size).toBe(2);
    const stats = await sharp(covers.get("rev-1")!).stats();
    expect(stats.channels.some((c) => c.stdev > 15)).toBe(true);
    await page.screenshot({ path: info.outputPath("automatic-covers.png") });
    const previousUploads = uploads;
    await page.reload();
    await page.locator(".project-trigger").click();
    await expect(page.locator(".project-card img")).toHaveCount(2);
    await expect(page.getByText("正在生成作品封面…")).toHaveCount(0);
    expect(uploads).toBe(previousUploads);
    projects[1].currentRevisionId = "rev-3";
    await page.reload();
    await page.locator(".project-trigger").click();
    await expect(
      page.locator('.project-card img[alt="红色方块"]'),
    ).toHaveAttribute("src", "/api/artifacts/cover-rev-3");
    expect(uploads).toBe(previousUploads + 1);
  });
