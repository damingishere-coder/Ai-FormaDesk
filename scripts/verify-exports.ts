import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DATA, ROOT } from "../server/config";
import { runBlender } from "../server/sandbox";
import { sceneSchema } from "../src/types";
const evidence = path.join(DATA, "acceptance");
const outputs: any[] = [];
for (const name of ["edited-scene.json", "final-scene.json"]) {
  const snap = JSON.parse(fs.readFileSync(path.join(evidence, name), "utf8"));
  const dir = fs.mkdtempSync(
    path.join(evidence, "reopen-" + snap.revision.id + "-"),
  );
  const blend = path.join(DATA, "revisions", snap.revision.id, "scene.blend");
  fs.copyFileSync(blend, path.join(dir, "scene.blend"));
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
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), snap.scene);
  outputs.push({
    file: name,
    revision: snap.revision.id,
    objects: actual.objects.length,
    reopened: true,
  });
}
fs.writeFileSync(
  path.join(evidence, "reopen-result.json"),
  JSON.stringify(outputs, null, 2),
);
console.log("BLEND_REOPEN_VERIFIED", outputs);
