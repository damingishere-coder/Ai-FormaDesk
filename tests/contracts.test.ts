import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { commandSchema, cameraSchema, sceneSchema } from "../src/types";
import { blenderTransform } from "../src/Viewport";
const id = "123e4567-e89b-42d3-a456-426614174000";
describe("坐标与输入边界", () => {
  it("网页局部矩阵往返 Blender Z-up 保留位置旋转缩放", () => {
    const original = new THREE.Matrix4().compose(
      new THREE.Vector3(1.2, -0.4, 2.6),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.7, 0.4)),
      new THREE.Vector3(1.5, 0.8, 2),
    );
    const C = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const t = blenderTransform(
      C.clone().multiply(original).multiply(C.clone().invert()),
    );
    expect(t.position[0]).toBeCloseTo(1.2);
    expect(t.position[1]).toBeCloseTo(-0.4);
    expect(t.position[2]).toBeCloseTo(2.6);
    expect(t.rotation[1]).toBeCloseTo(-0.7);
    expect(t.scale[2]).toBeCloseTo(2);
  });
  it("拒绝缺失操作参数和奇异缩放", () => {
    expect(
      commandSchema.safeParse({
        baseRevisionId: id,
        objectId: id,
        operation: "material",
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        baseRevisionId: id,
        objectId: id,
        operation: "transform",
        transform: {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          scale: [0, 1, 1],
        },
      }).success,
    ).toBe(false);
  });
  it("拒绝无效相机", () => {
    expect(
      cameraSchema.safeParse({
        position: [0, 0, 0],
        target: [0, 0, 0],
        up: [0, 1, 0],
        fov: 42,
        aspect: 1.7,
      }).success,
    ).toBe(false);
  });
  it("重复对象 ID 不得进入成功场景", () => {
    const o = {
      id,
      name: "同名",
      type: "EMPTY",
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      matrix: new THREE.Matrix4().toArray(),
      visible: true,
      material: null,
      light: null,
    };
    expect(
      sceneSchema.safeParse({
        objects: [o, o],
        stats: { objects: 2, vertices: 0, triangles: 0 },
        units: "meters",
        coordinates: "blender-z-up",
      }).success,
    ).toBe(false);
  });
});
