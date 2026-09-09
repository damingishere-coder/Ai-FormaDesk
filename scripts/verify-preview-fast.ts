import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runBlender } from "../server/sandbox";
import { ROOT } from "../server/config";
import { optimizePreview } from "../server/preview-optimize";

const input = process.argv[2];
if (!input) throw new Error("用法：tsx scripts/verify-preview-fast.ts <已保存模型.blend>");
const dir = fs.mkdtempSync(path.join(ROOT, "data", "preview-check-"));
fs.copyFileSync(path.resolve(input), path.join(dir, "raw.blend"));
const hash = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const original = hash(path.resolve(input));
const report: Record<string, unknown> = { dir };
async function validate(quality: string, signal?: AbortSignal) {
  const start = Date.now();
  try {
    const result = await runBlender(dir, ["--python", path.join(ROOT, "blender/worker.py"), "--", "validate", dir, quality], signal, 150000, true);
    fs.appendFileSync(path.join(dir, "verification.log"), result.stdout + result.stderr);
    assert.equal(result.code, 0, result.stderr + result.stdout.slice(-2000));
    return (Date.now() - start) / 1000;
  } catch (error) {
    const e = error as Error & { stdout?: string; stderr?: string };
    fs.appendFileSync(path.join(dir, "verification.log"), (e.stdout || "") + (e.stderr || "") + e.message);
    throw error;
  }
}
report.basicSeconds = await validate("basic");
fs.copyFileSync(path.join(dir, "scene.glb"), path.join(dir, "basic.glb"));
assert.ok(Number(report.basicSeconds) < 60);
const controller = new AbortController();
const timer = setInterval(() => {
  const files = fs.readdirSync(path.join(dir, "textures"));
  if (files.filter(f => f.endsWith(".done")).length >= 3) controller.abort();
}, 100);
try { await assert.rejects(validate("detail", controller.signal), /任务已取消/); }
finally { clearInterval(timer); }
assert.ok(fs.existsSync(path.join(dir, "basic.glb")));
report.resumeSeconds = await validate("detail");
const resumed = JSON.parse(fs.readFileSync(path.join(dir, "preview.json"), "utf8"));
assert.ok(resumed.cached >= 3);
assert.equal(resumed.complete, true);
report.resumed = { cached: resumed.cached, baked: resumed.baked };
report.warmSeconds = await validate("detail");
const warm = JSON.parse(fs.readFileSync(path.join(dir, "preview.json"), "utf8"));
assert.equal(warm.baked, 0);
assert.ok(warm.cached >= 3);
report.warm = { cached: warm.cached, baked: warm.baked };
report.compression = await optimizePreview(path.join(dir, "scene.glb"), path.join(dir, "optimized.glb"), new AbortController().signal);
const validator = createRequire(import.meta.url)("gltf-validator");
const validation = await validator.validateBytes(new Uint8Array(fs.readFileSync(path.join(dir, "optimized.glb"))), { maxIssues: 10000, ignoredIssues: ["UNUSED_OBJECT"] });
assert.equal(validation.issues.numErrors, 0);
report.validation = { errors: validation.issues.numErrors, warnings: validation.issues.numWarnings };
assert.equal(hash(path.resolve(input)), original);
assert.equal(hash(path.join(dir, "raw.blend")), original);
const inspect = path.join(dir, "preservation.py");
fs.writeFileSync(inspect, `import bpy,sys,json,hashlib\nsys.path.insert(0,${JSON.stringify(path.join(ROOT, "blender"))})\nfrom appearance import geometry_signature, material_signature\nresult=[]\nfor file in ['raw.blend','scene.blend']:\n bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(dir)}+'/'+file,load_ui=False,use_scripts=False)\n result.append({o.name:{'geometry':geometry_signature(o),'material':material_signature(o),'local':list(o.location)+list(o.rotation_euler)+list(o.scale)} for o in bpy.context.scene.objects})\nassert result[0]==result[1], 'Editable scene changed'\nprint('PRESERVATION_PASSED',len(result[0]))\n`);
const preserved = await runBlender(dir, ["--python", inspect], undefined, 30000, true);
assert.equal(preserved.code, 0, preserved.stdout + preserved.stderr);
report.preservation = preserved.stdout.match(/PRESERVATION_PASSED \d+/)?.[0];
fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
