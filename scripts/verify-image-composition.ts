// Isolated, deterministic Blender/Three.js framing check. Never calls the AI.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import * as THREE from "three";

type Point = [number, number];
function clipTriangle(points: Point[], width: number, height: number) {
  // Clip actual projected faces; clamping off-screen corners invents visible edges.
  for (const [axis, edge, direction] of [
    [0, 0, 1],
    [0, width, -1],
    [1, 0, 1],
    [1, height, -1],
  ]) {
    const input = points;
    points = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i],
        b = input[(i + 1) % input.length];
      const insideA = (a[axis] - edge) * direction >= 0;
      const insideB = (b[axis] - edge) * direction >= 0;
      if (insideA) points.push(a);
      if (insideA !== insideB) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        points.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
  }
  return points;
}

process.env.ZAOWU_DATA_DIR = path.resolve("data/image-composition-validation");
const { DATA, ROOT } = await import("../server/config");
const { runBlender } = await import("../server/sandbox");
const { executeScene, artifact } = await import("../server/jobs");
const { put, uid, now, db } = await import("../server/store");
const directory = fs.mkdtempSync(path.join(DATA, "framing-"));
const centers = [
  [-0.9, 0.35, 0],
  [0.65, 0.8, -0.3],
  [0.15, 1.5, 0.4],
];
fs.writeFileSync(
  path.join(directory, "generated.py"),
  `import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for i, (x,y,z) in enumerate(${JSON.stringify(centers)}):
 bpy.ops.mesh.primitive_cube_add(size=.5, location=(x,-z,y))
 obj=bpy.context.object;obj.name='Framing cube '+str(i)
 mat=bpy.data.materials.new(obj.name);mat.use_nodes=True
 mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.15,.55,.25,1)
 obj.data.materials.append(mat)
`,
);
const scene = await executeScene(
  directory,
  "execute",
  new AbortController().signal,
  () => {},
);
const pid = uid(),
  rid = uid();
const files: Record<string, string> = {};
for (const [key, name, mime] of [
  ["blend", "scene.blend", "application/x-blender"],
  ["glb", "scene.glb", "model/gltf-binary"],
  ["manifest", "scene.json", "application/json"],
  ["script", "generated.py", "text/plain"],
]) {
  files[key] = artifact(path.join(directory, name), pid, name, mime);
}
put("project", {
  id: pid,
  name: "图片取景验收 · 固定方块",
  currentRevisionId: rid,
  threadId: null,
  redo: [],
  createdAt: now(),
  updatedAt: now(),
});
put("revision", {
  id: rid,
  projectId: pid,
  parentId: null,
  source: "generate",
  label: "固定方块",
  scene,
  artifacts: files,
  createdAt: now(),
});
fs.writeFileSync(
  path.join(DATA, "fixture.json"),
  JSON.stringify({ pid, rid, directory }),
);
console.log("FIXTURE_READY", pid);
const results = [];
for (const [width, height, closeUp] of [
  [640, 360, false],
  [512, 512, false],
  [360, 640, false],
  [360, 640, true],
] as const) {
  const dir = path.join(
    directory,
    `${width}x${height}${closeUp ? "-edge" : ""}`,
  );
  fs.mkdirSync(dir);
  fs.copyFileSync(
    path.join(directory, "scene.blend"),
    path.join(dir, "base.blend"),
  );
  const camera = {
    position: closeUp ? [1.2, 1.1, 2] : [4, 3, 6],
    target: [0, 0.8, 0],
    up: [0, 1, 0],
    fov: 42,
    aspect: width / height,
  };
  const settings = { width, height, transparent: true };
  fs.writeFileSync(
    path.join(dir, "camera.json"),
    JSON.stringify({ ...camera, settings }),
  );
  const result = await runBlender(dir, [
    "--python",
    path.join(ROOT, "blender/worker.py"),
    "--",
    "render",
    dir,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const png = path.join(dir, "render.png");
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, width);
  assert.equal(info.height, height);
  const actual = [width, height, -1, -1];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) continue;
      actual[0] = Math.min(actual[0], x);
      actual[1] = Math.min(actual[1], y);
      actual[2] = Math.max(actual[2], x);
      actual[3] = Math.max(actual[3], y);
    }
  const threeCamera = new THREE.PerspectiveCamera(
    camera.fov,
    camera.aspect,
    0.01,
    1000,
  );
  threeCamera.position.fromArray(camera.position);
  threeCamera.up.fromArray(camera.up);
  threeCamera.lookAt(new THREE.Vector3().fromArray(camera.target));
  threeCamera.updateMatrixWorld(true);
  const expected = [width, height, -1, -1];
  const geometry = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed();
  const vertices = geometry.getAttribute("position");
  for (const c of centers) {
    for (let i = 0; i < vertices.count; i += 3) {
      const triangle: Point[] = [];
      for (let j = 0; j < 3; j++) {
        const point = new THREE.Vector3()
          .fromBufferAttribute(vertices, i + j)
          .add(new THREE.Vector3(...c))
          .project(threeCamera);
        triangle.push([
          ((point.x + 1) * width) / 2,
          ((1 - point.y) * height) / 2,
        ]);
      }
      for (const [x, y] of clipTriangle(triangle, width, height)) {
        expected[0] = Math.min(expected[0], x);
        expected[1] = Math.min(expected[1], y);
        expected[2] = Math.max(expected[2], x);
        expected[3] = Math.max(expected[3], y);
      }
    }
  }
  geometry.dispose();
  const delta = expected.map((value, i) => Math.abs(value - actual[i]));
  assert.ok(
    delta.every((value) => value <= 2),
    JSON.stringify({ width, height, actual, expected, delta }),
  );
  const artifactId = artifact(
    png,
    pid,
    `framing-${width}x${height}.png`,
    "image/png",
  );
  put("render", {
    id: uid(),
    projectId: pid,
    revisionId: rid,
    artifactId,
    camera,
    settings,
    createdAt: now(),
  });
  results.push({
    width,
    height,
    closeUp,
    actual,
    expected,
    maximumPixelError: Math.max(...delta),
    passed: true,
  });
  console.log("FRAMING_PASSED", results.at(-1));
}
fs.writeFileSync(
  path.join(DATA, "framing-result.json"),
  JSON.stringify(results, null, 2),
);
db.close();
