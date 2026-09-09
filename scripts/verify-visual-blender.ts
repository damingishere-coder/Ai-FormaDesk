import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { objectColorMaps, objectMaterials } from "./preview-proof-utils";
import { executeScene, validateScene } from "../server/jobs";
import { runBlender } from "../server/sandbox";
import { ROOT } from "../server/config";
const root = path.resolve("data/visual-blender-proof");
fs.mkdirSync(root, { recursive: true });
const signal = new AbortController().signal;
const shape = path.join(root, "shape");
fs.mkdirSync(shape, { recursive: true });
fs.writeFileSync(
  path.join(shape, "generated.py"),
  `import bpy
bpy.ops.mesh.primitive_cube_add(size=1,location=(-.8,0,.5));bpy.context.object.name='木盒'
bpy.ops.mesh.primitive_cylinder_add(vertices=32,radius=.35,depth=1,location=(.8,0,.5));bpy.context.object.name='图案容器'
bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,radius=.25,location=(0,0,1.5));bpy.context.object.name='金属球'
`,
);
const scene = await executeScene(shape, "execute", signal, console.log);
const targets = scene.objects.filter((o) => o.type === "MESH").map((o) => o.id);
async function trusted(dir: string, mode: string, config: object) {
  fs.writeFileSync(path.join(dir, "visual.json"), JSON.stringify(config));
  const r = await runBlender(
    dir,
    ["--python", path.join(ROOT, "blender/visual.py"), "--", mode, dir],
    signal,
    600000,
    true,
  );
  fs.writeFileSync(path.join(dir, mode + ".log"), r.stdout + "\n" + r.stderr);
  assert.equal(r.code, 0, (r.stdout + r.stderr).slice(-3500));
}
await trusted(shape, "render", { targets, shape: true });
const appearance = path.join(root, "appearance");
fs.mkdirSync(appearance, { recursive: true });
fs.copyFileSync(
  path.join(shape, "scene.blend"),
  path.join(appearance, "scene.blend"),
);
const views = JSON.parse(
  fs.readFileSync(path.join(shape, "views.json"), "utf8"),
);
for (const name of ["front", "right", "top"]) {
  await sharp(
    Buffer.from(
      '<svg width="512" height="512"><rect width="512" height="512" fill="#efd6a5"/><path d="M0 128H512M0 256H512M0 384H512" stroke="#c32738" stroke-width="30"/></svg>',
    ),
  )
    .png()
    .toFile(path.join(appearance, `texture-${name}.png`));
  views[name].image = `texture-${name}.png`;
}
await trusted(appearance, "surface", {
  targets,
  views,
  surface: {
    objects: scene.objects
      .filter((o) => o.type === "MESH")
      .map((o) => ({
        id: o.id,
        kind:
          o.name === "木盒"
            ? "wood"
            : o.name === "图案容器"
              ? "image"
              : "solid",
        color:
          o.name === "木盒"
            ? "#a56b35"
            : o.name === "金属球"
              ? "#bfc6d0"
              : "#efd6a5",
        roughness: 0.45,
        metalness: o.name === "金属球" ? 1 : 0,
        description: "测试",
      })),
  },
});
const renderedScene = await validateScene(appearance, signal);
assert.equal(
  renderedScene.objects.filter((o) => o.light?.type === "AREA").length,
  3,
);
const glb = fs.readFileSync(path.join(appearance, "scene.glb"));
const doc = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
assert.ok(doc.images?.length >= 4, "GLB 必须包含烘焙贴图");
assert.ok(
  doc.materials.some((m: any) => m.pbrMetallicRoughness?.baseColorTexture),
  "GLB 必须包含颜色贴图",
);
assert.ok(
  doc.materials.some((m: any) => m.normalTexture),
  "GLB 必须包含法线贴图",
);
let redPixels = 0;
const colorSources = new Set(
  doc.materials
    .filter((m: any) => m.pbrMetallicRoughness?.baseColorTexture)
    .map(
      (m: any) =>
        doc.textures[m.pbrMetallicRoughness.baseColorTexture.index].source,
    ),
);
for (const source of colorSources) {
  const image = doc.images[source as number];
  const view = doc.bufferViews[image.bufferView];
  const start = 28 + glb.readUInt32LE(12) + (view.byteOffset || 0);
  const decoded = await sharp(glb.subarray(start, start + view.byteLength))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < decoded.data.length; i += decoded.info.channels)
    if (
      decoded.data[i] > 100 &&
      decoded.data[i + 1] < 100 &&
      decoded.data[i + 2] < 120 &&
      decoded.data[i] > decoded.data[i + 1] * 3
    )
      redPixels++;
}
assert.ok(
  redPixels > 1000,
  "实际烘焙颜色贴图必须保留红色条纹，不只是存在图片文件",
);
await trusted(appearance, "render", { targets });
await trusted(appearance, "render", { targets, portable: true });
// Verify real material editing preserves maps after reopening a packed source blend.
const edited = path.join(root, "edited");
fs.mkdirSync(edited, { recursive: true });
fs.copyFileSync(
  path.join(appearance, "scene.blend"),
  path.join(edited, "base.blend"),
);
fs.writeFileSync(
  path.join(edited, "command.json"),
  JSON.stringify({
    operation: "material",
    objectId: targets[1],
    material: { color: "#ffffff", roughness: 0.6, metalness: 0 },
  }),
);
await executeScene(edited, "command", signal, console.log);
const next = fs.readFileSync(path.join(edited, "scene.glb"));
const nextDoc = JSON.parse(
  next.toString("utf8", 20, 20 + next.readUInt32LE(12)),
);
const editedMaps = objectColorMaps(next, targets[1]);
assert.ok(editedMaps.length > 0, "编辑后的目标材质必须引用颜色贴图");
let editedRedPixels = 0;
for (const image of editedMaps) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i] > 100 && data[i + 1] < 100 && data[i + 2] < 120 && data[i] > data[i + 1] * 3) editedRedPixels++;
}
assert.ok(editedRedPixels > 1000, "编辑后必须保留实际红色条纹");
for (const mat of objectMaterials(next, targets[1]).materials)
  assert.ok(Math.abs(mat.pbrMetallicRoughness.roughnessFactor - .6) < 1e-5, "粗糙度编辑必须生效");
const oldWood = objectColorMaps(glb, targets[0]), newWood = objectColorMaps(next, targets[0]);
assert.ok(oldWood.length > 0);
assert.equal(newWood.length, oldWood.length);
for (let i = 0; i < oldWood.length; i++)
  assert.deepEqual(await sharp(oldWood[i]).ensureAlpha().raw().toBuffer(), await sharp(newWood[i]).ensureAlpha().raw().toBuffer(), "未编辑对象的木纹像素必须保持一致");
fs.writeFileSync(
  path.join(root, "result.json"),
  JSON.stringify(
    {
      passed: true,
      images: doc.images.length,
      redPixels,
      lights: renderedScene.objects
        .filter((o) => o.type === "LIGHT")
        .map((o) => o.light),
      editedImages: nextDoc.images.length,
      editedRedPixels,
    },
    null,
    2,
  ),
);
console.log("VISUAL_BLENDER_PASSED", root);
process.exit(0);
