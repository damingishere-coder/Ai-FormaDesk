/** Real Vision + Blender integration; invoke with an isolated ZAOWU_DATA_DIR. */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import { DATA } from "../../server/config";
import { executeScene } from "../../server/jobs";
import { prepareImage, savePreparedMask } from "../../server/image3d";
import { attachmentPath, uploadImage } from "../../server/attachments";
import { db, put, uid, now } from "../../server/store";
import type { Scene } from "../../src/types";

if (!process.env.ZAOWU_DATA_DIR || !process.argv[2] || !process.argv[3])
  throw new Error("需要隔离数据目录、参考 PNG 和已验证 textured.blend");
const signal = new AbortController().signal;
const evidence: Record<string, unknown> = {};
const pid = uid();
put("project", { id: pid, name: "图生建模集成检查", currentRevisionId: null, threadId: null, redo: [], createdAt: now() });
try {
  const photo = await uploadImage(pid, fs.readFileSync(process.argv[2]), "参考.png");
  const prepared = await prepareImage(pid, photo.id, path.join(DATA, "vision"), signal, () => {});
  assert.equal(prepared.status, "ready");
  const alpha = await sharp(attachmentPath(pid, prepared.maskId)).removeAlpha().greyscale().raw().toBuffer();
  alpha.fill(0, 0, prepared.width * Math.floor(prepared.height / 2));
  const edited = await savePreparedMask(pid, prepared.id, await sharp(alpha,
    { raw: { width: prepared.width, height: prepared.height, channels: 1 } }).png().toBuffer());
  const output = await sharp(attachmentPath(pid, edited.imageId)).ensureAlpha().raw().toBuffer();
  for (let i = 3; i < prepared.width * Math.floor(prepared.height / 2) * 4; i += 4) assert.equal(output[i], 0);
  assert.notEqual(edited.id, prepared.id);
  await assert.rejects(savePreparedMask(pid, prepared.id, await sharp({ create: {
    width: prepared.width, height: prepared.height, channels: 3, background: "#000" } }).png().toBuffer()), /至少选择/);
  evidence.foregroundAndMask = { passed: true, instances: prepared.variants.length, immutablePreparation: true };

  const fixture = path.join(DATA, "fixture"); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, "generated.py"), "bpy.ops.mesh.primitive_cube_add(size=.2, location=(2,0,0))\nbpy.context.object.name='保留物体'\n");
  const original = await executeScene(fixture, "execute", signal, () => {});
  const keep = original.objects[0];
  async function sceneAt(name: string, base: string, mode: "command" | "image3d", command: unknown): Promise<Scene> {
    const dir = path.join(DATA, name); fs.mkdirSync(dir);
    fs.copyFileSync(path.join(DATA, base, "scene.blend"), path.join(dir, "base.blend"));
    fs.writeFileSync(path.join(dir, "command.json"), JSON.stringify(command));
    if (mode === "image3d") fs.copyFileSync(process.argv[3], path.join(dir, "subject.blend"));
    return executeScene(dir, mode, signal, () => {});
  }
  const imported = await sceneAt("import", "fixture", "image3d", { name: "照片主体" });
  assert.deepEqual(imported.objects.find(o => o.id === keep.id)?.transform, keep.transform);
  const root = imported.objects.find(o => o.subjectId === o.id)!;
  const mesh = imported.objects.find(o => o.type === "MESH" && o.subjectId)!;
  assert.ok(root && mesh); assert.equal(mesh.parentId, root.id);
  const moved = await sceneAt("move", "import", "command", { objectId: root.id, operation: "transform",
    transform: { position: [.7, .2, .3], rotation: [.1, .2, .3], scale: [1.2, .8, 1.5] } });
  const regenerated = await sceneAt("replace", "move", "image3d", { objectId: mesh.id, name: "重新生成" });
  const before = moved.objects.find(o => o.id === root.id)!.transform;
  const after = regenerated.objects.find(o => o.id === root.id)!.transform;
  for (const key of ["position", "rotation", "scale"] as const)
    before[key].forEach((value, i) => assert.ok(Math.abs(value - after[key][i]) < 1e-6));
  assert.ok(!regenerated.objects.some(o => o.id === mesh.id));
  assert.ok(regenerated.objects.some(o => o.id === keep.id));
  const duplicate = await sceneAt("duplicate", "replace", "command", { objectId: root.id, operation: "duplicate" });
  assert.equal(new Set(duplicate.objects.filter(o => o.subjectId).map(o => o.subjectId)).size, 2);
  const glb = fs.readFileSync(path.join(DATA, "import/scene.glb"));
  const doc = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
  const subjectNode = doc.nodes.find((n: any) => n.mesh !== undefined && n.extras?.forma_subject_id);
  const primitive = doc.meshes[subjectNode.mesh].primitives[0];
  const positions = doc.accessors[primitive.attributes.POSITION];
  const span = Math.max(...positions.max.map((v: number, i: number) =>
    (v - positions.min[i]) * (subjectNode.scale?.[i] ?? 1)));
  assert.ok(Math.abs(span - 1) < 1e-4, `Imported normalized subject changed scale: ${span}`);
  assert.ok(doc.images?.length && doc.materials.some((m: any) => m.pbrMetallicRoughness?.baseColorTexture));
  const tris = doc.meshes.flatMap((m: any) => m.primitives).reduce((n: number, p: any) =>
    n + doc.accessors[p.indices ?? p.attributes.POSITION].count / 3, 0);
  assert.ok(tris <= 150012); // One bounded subject plus the original cube.
  assert.ok(imported.stats.triangles > tris);
  evidence.importAndRegeneration = { passed: true, masterTriangles: imported.stats.triangles,
    previewTriangles: tris, preservedOriginal: true, stableSubject: true, newReplacementMeshIds: true, embeddedTexture: true };
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  fs.writeFileSync(path.join(DATA, "workbench-probe.json"), JSON.stringify(evidence, null, 2));
  db.close();
}
