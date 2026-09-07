import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DATA, ROOT } from "../server/config";
import { runBlender } from "../server/sandbox";
import { executeScene } from "../server/jobs";
import { checkEnvironment } from "../server/environment";
import { codex } from "../server/codex";
const results: { name: string; passed: boolean; detail?: unknown }[] = [];
async function test(name: string, fn: () => Promise<unknown>) {
  try {
    const detail = await fn();
    results.push({ name, passed: true, detail });
    console.log("PASS", name, detail || "");
  } catch (e) {
    results.push({ name, passed: false, detail: (e as Error).message });
    console.error("FAIL", name, (e as Error).message);
  }
}
const dir = path.join(DATA, "integration", Date.now().toString());
fs.mkdirSync(dir, { recursive: true });
await test("真实环境与沙箱", async () => {
  const env = await checkEnvironment();
  assert.equal(env.blender.ok, true);
  assert.equal(env.sandbox.ok, true);
  return env.sandbox;
});
const fixture = `import bpy\nfrom mathutils import Matrix\nm=bpy.data.materials.new('shared');m.use_nodes=True\nbpy.ops.object.empty_add();root=bpy.context.object;root.name='组';root.location=(.3,.5,.2)\nfor x in [-1,1]:\n bpy.ops.mesh.primitive_cube_add(size=.4,location=(x,0,.3));o=bpy.context.object;o.name='同名';o.parent=root;o.data.materials.append(m)\n`;
let scene: any;
await test("真实 Blender 建模、GLB 和层级", async () => {
  fs.writeFileSync(path.join(dir, "generated.py"), fixture);
  scene = await executeScene(
    dir,
    "execute",
    new AbortController().signal,
    () => {},
  );
  assert.equal(scene.objects.length, 3);
  assert.equal(new Set(scene.objects.map((o: any) => o.id)).size, 3);
  assert.equal(scene.objects.filter((o: any) => o.parentId).length, 2);
  return scene.stats;
});
await test("手动写回与共享材质隔离", async () => {
  const next = path.join(dir, "edit");
  fs.mkdirSync(next);
  fs.copyFileSync(path.join(dir, "scene.blend"), path.join(next, "base.blend"));
  const mesh = scene.objects.find((o: any) => o.type === "MESH");
  fs.writeFileSync(
    path.join(next, "command.json"),
    JSON.stringify({
      objectId: mesh.id,
      operation: "material",
      material: { color: "#fa5030", roughness: 0.25, metalness: 0.4 },
    }),
  );
  const edited = await executeScene(
    next,
    "command",
    new AbortController().signal,
    () => {},
  );
  assert.equal(
    edited.objects.find((o) => o.id === mesh.id)?.material?.color,
    "#fa5030",
  );
  assert.notEqual(
    edited.objects.find((o) => o.type === "MESH" && o.id !== mesh.id)?.material
      ?.color,
    "#fa5030",
  );
  const r = await runBlender(next, [
    "--python",
    path.join(ROOT, "blender/worker.py"),
    "--",
    "inspect",
    next,
  ]);
  assert.equal(r.code, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(next, "inspection.json"), "utf8")),
    edited,
  );
});
await test("错误脚本真实失败，已有场景不受影响", async () => {
  const before = fs.readFileSync(path.join(dir, "scene.blend"));
  const bad = path.join(dir, "bad");
  fs.mkdirSync(bad);
  fs.writeFileSync(
    path.join(bad, "generated.py"),
    "raise RuntimeError('FORMA_EXPECTED_ERROR')",
  );
  await assert.rejects(
    () => executeScene(bad, "execute", new AbortController().signal, () => {}),
    /FORMA_EXPECTED_ERROR/,
  );
  assert.deepEqual(fs.readFileSync(path.join(dir, "scene.blend")), before);
});
await test("长任务取消终止真实 Blender 进程", async () => {
  const d = path.join(dir, "cancel");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "generated.py"), "import time\ntime.sleep(60)");
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 2500);
  await assert.rejects(
    () => executeScene(d, "execute", ctrl.signal, () => {}),
    /取消/,
  );
  assert.equal(fs.existsSync(path.join(d, "scene.blend")), false);
});
await test("全局 Blender 队列包括环境检查与任务", async () => {
  const jobs = [0, 1].map((i) => {
    const d = path.join(dir, "queue-" + i);
    fs.mkdirSync(d);
    return d;
  });
  const outputs = await Promise.all(
    jobs.map((d) =>
      runBlender(
        d,
        [
          "--python-expr",
          "import time,json; a=time.time(); time.sleep(1); print('QUEUE_TIMES',json.dumps([a,time.time()]))",
        ],
        undefined,
        20000,
      ),
    ),
  );
  const times = outputs.map((r) => {
    assert.equal(r.code, 0);
    return JSON.parse(r.stdout.match(/QUEUE_TIMES (\[[^\n]+\])/)![1]);
  });
  assert.ok(times[1][0] >= times[0][1]);
  return times;
});
fs.writeFileSync(
  path.join(dir, "results.json"),
  JSON.stringify(results, null, 2),
);
console.log("RESULTS", path.join(dir, "results.json"));
codex.close();
if (results.some((r) => !r.passed)) process.exitCode = 1;
