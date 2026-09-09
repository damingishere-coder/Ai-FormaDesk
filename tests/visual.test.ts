import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import * as THREE from "three";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "forma-visual-test-"));
process.env.ZAOWU_DATA_DIR = root;
const { persistImage } = await import("../server/visual-ai");
const { assertReview, targetIds } = await import("../server/visual-pipeline");
const { applySceneLight } = await import("../src/sceneLighting");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
describe("原生图片与视觉验收边界", () => {
  it("只接受真实图片工具产物，拒绝文字冒充、损坏图片与任务外路径", async () => {
    const bytes = await sharp({
      create: { width: 128, height: 128, channels: 3, background: "#ffffff" },
    })
      .png()
      .toBuffer();
    const output = path.join(root, "output.png");
    const r = await persistImage(
      {
        type: "imageGeneration",
        id: "proof",
        status: "completed",
        result: bytes.toString("base64"),
      },
      output,
    );
    expect(r.width).toBe(128);
    expect(fs.existsSync(output)).toBe(true);
    await expect(
      persistImage(
        {
          type: "agentMessage",
          status: "completed",
          result: "已保存 output.png",
        },
        output,
      ),
    ).rejects.toThrow();
    await expect(
      persistImage(
        {
          type: "imageGeneration",
          status: "completed",
          result: Buffer.from("fake PNG").toString("base64"),
        },
        output,
      ),
    ).rejects.toThrow();
    await expect(
      persistImage(
        {
          type: "imageGeneration",
          status: "completed",
          savedPath: path.resolve("package.json"),
        },
        output,
      ),
    ).rejects.toThrow("允许的输出目录");
  });
  it("形状检查不能夹带纹理问题，矛盾的通过标记不能放行", () => {
    const clean = {
      acceptable: true,
      shapeIssues: [],
      textureIssues: [],
      lightingIssues: [],
      repair: "",
    };
    expect(assertReview(clean, true)).toBe(true);
    expect(assertReview({ ...clean, shapeIssues: ["少了一条腿"] }, true)).toBe(
      false,
    );
    expect(() =>
      assertReview({ ...clean, textureIssues: ["颜色不对"] }, true),
    ).toThrow();
  });
  it("材质范围限定为新增网格与选中部件树", () => {
    const parent = randomUUID(),
      child = randomUUID(),
      other = randomUUID(),
      added = randomUUID();
    const base: any = {
      objects: [
        { id: parent, type: "EMPTY", parentId: null },
        { id: child, type: "MESH", parentId: parent },
        { id: other, type: "MESH", parentId: null },
      ],
    };
    const scene: any = {
      objects: [...base.objects, { id: added, type: "MESH", parentId: null }],
    };
    expect(targetIds(scene, base, parent).targets).toEqual([child, added]);
    expect(targetIds(scene, base).targets).toEqual([added]);
  });
  it("面光源使用明确尺寸与功率，点光源不被任意截断", () => {
    const group = new THREE.Group();
    applySceneLight(group, {
      type: "AREA",
      color: "#fff",
      energy: 100,
      size: 2,
      sizeY: 3,
    });
    const area = group.children[0] as THREE.RectAreaLight;
    expect(area.isRectAreaLight).toBe(true);
    expect(area.width).toBe(2);
    expect(area.height).toBe(3);
    expect(area.intensity).toBeCloseTo(100 / (Math.PI * 6));
    const point = new THREE.PointLight();
    group.add(point);
    applySceneLight(group, { type: "POINT", color: "#fff", energy: 5000 });
    expect(point.intensity).toBeCloseTo(5000 / (4 * Math.PI));
  });
});
