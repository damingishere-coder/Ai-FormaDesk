import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { objectColorMaps } from "./preview-proof-utils";
import { executeScene, validateScene } from "../server/jobs";
import { runBlender } from "../server/sandbox";
import { ROOT } from "../server/config";
const root = path.resolve("data/visual-preservation-proof"),
  signal = new AbortController().signal;
fs.mkdirSync(root, { recursive: true });
async function trusted(dir: string, mode: string, config: object, ok = true) {
  fs.writeFileSync(path.join(dir, "visual.json"), JSON.stringify(config));
  const r = await runBlender(
    dir,
    ["--python", path.join(ROOT, "blender/visual.py"), "--", mode, dir],
    signal,
    300000,
    true,
  );
  fs.writeFileSync(path.join(dir, mode + ".log"), r.stdout + r.stderr);
  if (ok) assert.equal(r.code, 0, (r.stdout + r.stderr).slice(-2000));
  else assert.notEqual(r.code, 0);
}
const base = path.join(root, "base");
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(
  path.join(base, "generated.py"),
  "import bpy\nbpy.ops.mesh.primitive_cube_add(size=1,location=(3,-2,1));o=bpy.context.object;o.name='已有物体';o.scale=(.4,.5,.6);o.rotation_euler=(.1,.2,.3);m=bpy.data.materials.new('已有材质');m.use_nodes=True;m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.16,.25,.32,1);o.data.materials.append(m);b=o.modifiers.new('已有圆角','BEVEL');b.width=.025;b.segments=2",
);
const before = await executeScene(base, "execute", signal, () => {});
await trusted(base, "snapshot", {});
const next = path.join(root, "next");
fs.mkdirSync(next, { recursive: true });
fs.copyFileSync(path.join(base, "scene.blend"), path.join(next, "base.blend"));
fs.writeFileSync(
  path.join(next, "generated.py"),
  "import bpy\nbpy.ops.mesh.primitive_cube_add(size=1);bpy.context.object.name='新增主体'",
);
const scene = await executeScene(next, "execute", signal, () => {});
fs.copyFileSync(
  path.join(base, "snapshot.json"),
  path.join(next, "snapshot.json"),
);
await trusted(next, "preserve", { allowed: [] });
const target = scene.objects.find((o) => o.name === "新增主体")!.id;
await trusted(next, "surface", {
  targets: [target],
  surface: {
    objects: [
      {
        id: target,
        kind: "wood",
        color: "#a56b35",
        roughness: 0.45,
        metalness: 0,
        description: "木纹",
      },
    ],
  },
  views: {},
});
await validateScene(next, signal);
await trusted(next, "preserve", { allowed: [] });
const edit = path.join(root, "edit");
fs.mkdirSync(edit, { recursive: true });
fs.copyFileSync(path.join(next, "scene.blend"), path.join(edit, "base.blend"));
fs.writeFileSync(
  path.join(edit, "command.json"),
  JSON.stringify({
    operation: "material",
    objectId: target,
    material: { color: "#a56b35", roughness: 0.7, metalness: 0 },
  }),
);
await executeScene(edit, "command", signal, () => {});
fs.copyFileSync(
  path.join(base, "snapshot.json"),
  path.join(edit, "snapshot.json"),
);
await trusted(edit, "preserve", { allowed: [] });
const oldMaps = objectColorMaps(fs.readFileSync(path.join(next, "scene.glb")), target);
const newMaps = objectColorMaps(fs.readFileSync(path.join(edit, "scene.glb")), target);
assert.ok(oldMaps.length > 0, "原木纹必须实际出现在预览材质上");
assert.equal(newMaps.length, oldMaps.length);
for (let i = 0; i < oldMaps.length; i++) {
  assert.deepEqual(await sharp(newMaps[i]).ensureAlpha().raw().toBuffer(), await sharp(oldMaps[i]).ensureAlpha().raw().toBuffer(), "只改粗糙度时木纹颜色像素必须保持一致");
}
const bad = path.join(root, "bad");
fs.mkdirSync(bad, { recursive: true });
fs.copyFileSync(path.join(base, "scene.blend"), path.join(bad, "base.blend"));
fs.writeFileSync(
  path.join(bad, "generated.py"),
  "import bpy\nbpy.data.objects['已有物体'].location.x+=1",
);
await executeScene(bad, "execute", signal, () => {});
fs.copyFileSync(
  path.join(base, "snapshot.json"),
  path.join(bad, "snapshot.json"),
);
await trusted(bad, "preserve", { allowed: [] }, false);
fs.writeFileSync(
  path.join(root, "result.json"),
  JSON.stringify(
    {
      passed: true,
      preservedObject: before.objects[0].id,
      geometryMaterialAndTransformUnchanged: true,
      roughnessOnlyRetainsColorMap: true,
      unauthorizedTransformRejected: true,
    },
    null,
    2,
  ),
);
console.log("PRESERVATION_PASSED", root);
process.exit(0);
