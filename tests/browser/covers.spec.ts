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
  test(`首页仅用缓存封面，预览后显式保存${failFirst ? "及失败重试" : ""}`, async ({
    page,
  }) => {
    const scene = {
      objects: [],
      stats: { objects: 1, vertices: 36, triangles: 12 },
      units: "meters",
      coordinates: "blender-z-up",
    };
    let cover = false,
      failed = false,
      modelReads = 0;
    const png = await sharp({
      create: { width: 640, height: 400, channels: 3, background: "#639f89" },
    })
      .png()
      .toBuffer();
    const p = {
      id: "one",
      coverRefreshSupported: true,
      name: "红色方块",
      currentRevisionId: "rev-1",
      threadId: null,
      createdAt: "2026-09-08",
      redo: [],
    };
    await page.route("**/api/**", async (route) => {
      const u = new URL(route.request().url()).pathname;
      if (u === "/api/session")
        return route.fulfill({ json: { token: "test" } });
      if (u === "/api/health")
        return route.fulfill({ json: { codex: true, blender: true } });
      if (u === "/api/projects")
        return route.fulfill({
          json: [{ ...p, coverUrl: cover ? "/api/artifacts/cover" : null }],
        });
      if (u === "/api/projects/one/scene")
        return route.fulfill({
          json: {
            project: p,
            revision: { id: "rev-1" },
            scene,
            previewUrl: "/api/artifacts/model",
            messages: [],
            jobs: [],
            proposals: [],
            activeJob: null,
          },
        });
      if (u === "/api/artifacts/model") {
        modelReads++;
        return route.fulfill({ json: model() });
      }
      if (u === "/api/artifacts/cover")
        return route.fulfill({ contentType: "image/png", body: png });
      if (u === "/api/projects/one/cover") {
        if (failFirst && !failed) {
          failed = true;
          return route.fulfill({
            status: 500,
            json: { error: "模拟封面保存失败" },
          });
        }
        cover = true;
        return route.fulfill({ json: { coverUrl: "/api/artifacts/cover" } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto("/");
    await expect(page.locator(".home-project")).toHaveCount(1);
    expect(modelReads).toBe(0);
    await page
      .getByRole("button", { name: "预览 红色方块", exact: true })
      .click();
    const save = page.getByRole("button", {
      name: "保存预览封面",
      exact: true,
    });
    await expect(save).toBeEnabled();
    await save.click();
    if (failFirst) {
      await expect(
        page.getByRole("dialog", { name: "作品预览" }).getByRole("alert"),
      ).toContainText("模拟封面保存失败");
      await save.click();
    }
    await expect(
      page.getByRole("dialog", { name: "作品预览" }).getByRole("status"),
    ).toContainText("作品封面已保存");
    await page.getByRole("button", { name: "关闭作品详情" }).click();
    await expect(page.locator(".home-cover img")).toHaveCount(1);
    const count = modelReads;
    await page.reload();
    await expect(page.locator(".home-cover img")).toHaveCount(1);
    expect(modelReads).toBe(count);
  });

test("刷新封面串行重新取景，小模型与大模型占比一致，重复刷新替换旧图", async ({
  page,
}) => {
  const projects = [0.01, 10].map((scale, i) => ({
    id: `scaled-${i}`,
    coverRefreshSupported: true,
    name: i ? "大模型" : "小模型",
    scale,
    currentRevisionId: `revision-${i}`,
    createdAt: "2026-09-10",
    redo: [],
    coverUrl: `/api/artifacts/old-${i}`,
  }));
  const active = new Set<string>();
  let peak = 0,
    saves = 0;
  const captures: Buffer[] = [];
  const images = new Map<string, Buffer>();
  const old = await sharp({
    create: { width: 640, height: 400, channels: 3, background: "#eeeeee" },
  })
    .png()
    .toBuffer();
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url()).pathname;
    if (u === "/api/session") return route.fulfill({ json: { token: "test" } });
    if (u === "/api/projects") return route.fulfill({ json: projects });
    if (u.startsWith("/api/artifacts/old-"))
      return route.fulfill({ body: old, contentType: "image/png" });
    if (images.has(u))
      return route.fulfill({ body: images.get(u)!, contentType: "image/png" });
    const p = projects.find((p) => u.includes(p.id));
    if (p && u.endsWith("/scene")) {
      active.add(p.id);
      peak = Math.max(peak, active.size);
      return route.fulfill({
        json: {
          project: p,
          revision: { id: p.currentRevisionId },
          scene: {
            objects: [],
            stats: { objects: 1, vertices: 36, triangles: 12 },
          },
          previewUrl: `/api/artifacts/${p.id}`,
          messages: [],
          jobs: [],
          proposals: [],
          activeJob: null,
        },
      });
    }
    if (p && u === `/api/artifacts/${p.id}`) {
      const gltf = model();
      Object.assign(gltf.nodes[0], {
        name: "主体",
        scale: [p.scale, p.scale, p.scale],
      });
      return route.fulfill({ json: gltf });
    }
    if (p && u.endsWith("/cover")) {
      const body = route.request().postDataJSON();
      expect(body.replace).toBe(true);
      const image = Buffer.from(body.image.split(",")[1], "base64");
      captures.push(image);
      saves++;
      active.delete(p.id);
      p.coverUrl = `/api/artifacts/new-${saves}`;
      images.set(p.coverUrl, image);
      return route.fulfill({ json: { coverUrl: p.coverUrl } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await expect(page.locator(".home-project")).toHaveCount(2);
  await page.getByRole("button", { name: "刷新封面", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("2 个成功");
  expect(saves).toBe(2);
  expect(peak).toBe(1);
  const widths: number[] = [];
  for (const image of captures) {
    const { data, info } = await sharp(image)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let min = info.width,
      max = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const at = (y * info.width + x) * 3;
        if (data[at] > data[at + 1] * 1.5 && data[at] > data[at + 2] * 1.5) {
          min = Math.min(min, x);
          max = Math.max(max, x);
        }
      }
    const fraction = (max - min + 1) / info.width;
    expect(fraction).toBeGreaterThan(0.3);
    expect(fraction).toBeLessThan(0.85);
    widths.push(fraction);
  }
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(0.03);
  const first = projects[0].coverUrl;
  await page
    .getByRole("button", { name: "刷新封面 小模型", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("1 个成功");
  expect(saves).toBe(3);
  expect(projects[0].coverUrl).not.toBe(first);
  await expect(page.locator(".home-cover img").first()).toHaveAttribute(
    "src",
    projects[0].coverUrl,
  );
});
