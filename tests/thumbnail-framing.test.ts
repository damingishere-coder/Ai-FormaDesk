import { expect, it } from "vitest";
import * as THREE from "three";
import { frameThumbnail, subjectBounds } from "../src/thumbnailFraming";

it("不同尺寸模型按卡片比例占据一致空间，横长和竖高主体均不裁切", () => {
  for (const size of [
    [1, 1, 1],
    [10, 1, 1],
    [1, 10, 1],
  ]) {
    for (const aspect of [1.6, 0.8]) {
      const extents: number[] = [];
      for (const scale of [0.001, 0.1, 1, 1000]) {
        const box = new THREE.Box3(
          new THREE.Vector3(),
          new THREE.Vector3(...size).multiplyScalar(scale),
        );
        const camera = new THREE.PerspectiveCamera(42, aspect);
        frameThumbnail(box, camera);
        let extent = 0;
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) {
              const point = new THREE.Vector3(x, y, z).project(camera);
              expect(Math.abs(point.x)).toBeLessThanOrEqual(0.841);
              expect(Math.abs(point.y)).toBeLessThanOrEqual(0.841);
              expect(point.z).toBeGreaterThan(-1);
              expect(point.z).toBeLessThan(1);
              extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
            }
        expect(extent).toBeGreaterThan(0.78);
        extents.push(extent);
      }
      for (const extent of extents) expect(extent).toBeCloseTo(extents[0], 5);
    }
  }
});

it("忽略隐藏父组及背景组，保留主体零件与底座；只有地面时仍能取景", () => {
  const root = new THREE.Group();
  const subject = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1));
  subject.name = "模型底座";
  root.add(subject);
  const ground = new THREE.Group();
  ground.name = "背景地面";
  ground.add(new THREE.Mesh(new THREE.BoxGeometry(100, 0.01, 100)));
  root.add(ground);
  const hidden = new THREE.Group();
  hidden.visible = false;
  hidden.add(new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000)));
  root.add(hidden);
  expect(subjectBounds(root).getSize(new THREE.Vector3()).toArray()).toEqual([
    1, 2, 1,
  ]);
  root.remove(subject);
  expect(subjectBounds(root).getSize(new THREE.Vector3()).x).toBe(100);
  expect(ground.visible).toBe(true);
});
