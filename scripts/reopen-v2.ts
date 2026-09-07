import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { runBlender } from "../server/sandbox";
import { ROOT } from "../server/config";
import { sceneSchema } from "../src/types";
const evidence = path.resolve("data/v2-evidence");
const s = JSON.parse(
  fs.readFileSync(path.join(evidence, "final-scene.json"), "utf8"),
);
const dir = fs.mkdtempSync(path.join(evidence, "reopen-"));
fs.copyFileSync(
  path.join(evidence, "scene.blend"),
  path.join(dir, "scene.blend"),
);
const r = await runBlender(dir, [
  "--python",
  path.join(ROOT, "blender/worker.py"),
  "--",
  "inspect",
  dir,
]);
assert.equal(r.code, 0, r.stderr);
const actual = sceneSchema.parse(
  JSON.parse(fs.readFileSync(path.join(dir, "inspection.json"), "utf8")),
);
assert.deepEqual(JSON.parse(JSON.stringify(actual)), s.scene);
fs.copyFileSync(path.join(evidence, "scene.glb"), path.join(dir, "scene.glb"));
fs.writeFileSync(
  path.join(dir, "verify-glb.py"),
  'import bpy, os, json\nbpy.ops.import_scene.gltf(filepath=os.path.join(os.path.dirname(__file__),"scene.glb"))\nids=[o.get("forma_id") for o in bpy.context.scene.objects if o.get("forma_id")]\nwith open(os.path.join(os.path.dirname(__file__),"glb-ids.json"),"w") as f: json.dump(ids,f)\n',
);
const g = await runBlender(dir, ["--python", path.join(dir, "verify-glb.py")]);
assert.equal(g.code, 0, g.stderr);
const ids = JSON.parse(fs.readFileSync(path.join(dir, "glb-ids.json"), "utf8"));
for (const o of s.scene.objects) assert(ids.includes(o.id));
fs.writeFileSync(
  path.join(evidence, "reopen-result.json"),
  JSON.stringify({
    blend: true,
    glb: true,
    objects: actual.objects.length,
    revision: s.revision.id,
  }),
);
console.log("V2_BLEND_GLB_REOPEN_OK", actual.objects.length);
