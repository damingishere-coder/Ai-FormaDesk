import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DATA } from "../server/config";
import { environment } from "../server/environment";
import { codex } from "../server/codex";
import { enqueue, restore, artifactPath } from "../server/jobs";
import { db, put, uid, get, project, revision } from "../server/store";
import { blenderBridge } from "../server/blender-mcp";
import { sessionGuard } from "../server/blender-mcp-code";
import type { Job, Project } from "../src/types";
if (!DATA.includes("mcp-proof"))
  throw new Error("必须使用独立 ZAOWU_DATA_DIR=.../mcp-proof");
const report: any = { startedAt: new Date().toISOString(), steps: [] };
async function done(job: Job) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const j = get<Job>("job", job.id)!;
    if (["failed", "cancelled"].includes(j.status)) throw new Error(j.error!);
    if (j.status === "succeeded") return j;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("验收任务超时");
}
const original = codex.generate;
try {
  environment.blender = { ok: true };
  environment.sandbox = { ok: true };
  environment.codex = { ok: true };
  const p = put<Project>("project", {
    id: uid(),
    name: "Blender MCP 联动验收",
    currentRevisionId: null,
    threadId: null,
    createdAt: new Date().toISOString(),
    redo: [],
  });
  codex.generate = async () => ({
    python: `import bpy\nmat=forma.material('珊瑚红',(0.6,0.12,0.07,1))\nbpy.ops.mesh.primitive_cube_add(size=1,location=(0,0,.5))\nhead=forma.finish(bpy.context.object,mat,bevel=.04);head.name='头部'\nbpy.ops.mesh.primitive_cube_add(size=.4,location=(1.4,0,.2))\nbpy.context.object.name='保持不变的部件'\n`,
    summary: "验收场景",
  });
  const generated = await done(
    enqueue(p.id, null, "generate", {
      prompt: "验收用确定性建模脚本",
      attachmentIds: [],
    }),
  );
  codex.generate = original;
  const first = revision(generated.resultRevisionId!);
  const head = first.scene.objects.find((o) => o.name === "头部")!;
  const other = first.scene.objects.find((o) => o.name === "保持不变的部件")!;
  report.projectId = p.id;
  report.baseRevisionId = first.id;
  report.steps.push({
    step: "CLI create",
    jobId: generated.id,
    objects: first.scene.objects.length,
  });
  console.log("CLI_CREATE_OK", p.id);
  await blenderBridge.open(p.id, first.id, artifactPath(first.artifacts.blend));
  const inspected = await blenderBridge.inspect(p.id);
  assert(inspected.some((o: any) => o.id === head.id));
  report.steps.push({
    step: "MCP open/inspect",
    status: blenderBridge.status(),
  });
  console.log("MCP_CONNECTED");
  const command = {
    baseRevisionId: first.id,
    objectId: head.id,
    operation: "transform",
    transform: {
      ...head.transform,
      scale: head.transform.scale.map((v) => v * 1.1),
    },
    executor: "mcp",
  };
  const changed = await done(enqueue(p.id, first.id, "command", command));
  const second = revision(changed.resultRevisionId!);
  second.scene.objects
    .find((o) => o.id === head.id)!
    .transform.scale.forEach((v) => assert(Math.abs(v - 1.1) < 1e-5));
  assert.deepEqual(
    second.scene.objects.find((o) => o.id === other.id),
    other,
  );
  report.steps.push({
    step: "MCP modify + sync",
    revisionId: second.id,
    otherPreserved: true,
  });
  console.log("MCP_MODIFY_SYNC_OK");
  const material = await done(
    enqueue(p.id, second.id, "command", {
      executor: "mcp",
      baseRevisionId: second.id,
      objectId: head.id,
      operation: "material",
      material: { color: "#3366cc", roughness: 0.65, metalness: 0.1 },
    }),
  );
  const third = revision(material.resultRevisionId!);
  assert.equal(
    third.scene.objects
      .find((o) => o.id === head.id)!
      .material!.color.toLowerCase(),
    "#3366cc",
  );
  report.steps.push({ step: "MCP material", revisionId: third.id });
  console.log("MCP_MATERIAL_OK");
  const bridge = blenderBridge as any;
  const viewportColor = await bridge.execute(bridge.session, sessionGuard(bridge.session.id) + `\nobj=next(o for o in bpy.context.scene.objects if o.get('forma_id')==${JSON.stringify(head.id)})\nprint('FORMA_RESULT:'+json.dumps(list(obj.active_material.diffuse_color)))`);
  const linear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
  [0x33, 0x66, 0xcc].forEach((v, i) => assert(Math.abs(viewportColor[i] - linear(v / 255)) < 1e-5));
  report.steps.push({step:"Blender solid viewport color matches material",passed:true});
  const screenshot = await blenderBridge.screenshot(p.id);
  fs.writeFileSync(path.join(DATA, "blender-screenshot.png"), screenshot.bytes);
  restore(p.id, third.id, null, "undo");
  assert.equal(project(p.id).currentRevisionId, second.id);
  assert.throws(() => blenderBridge.assertReady(p.id, second.id), /版本不同/);
  restore(p.id, second.id, null, "redo");
  assert.equal(project(p.id).currentRevisionId, third.id);
  report.steps.push({ step: "undo/redo and conflict", passed: true });
  await blenderBridge.close();
  await blenderBridge.reconnect(p.id);
  const sync = await done(enqueue(p.id, third.id, "blender-sync", {}));
  assert(sync.resultRevisionId);
  report.finalRevisionId = sync.resultRevisionId;
  report.steps.push({ step: "reconnect + manual sync", passed: true });
  report.ok = true;
  console.log("MCP_ACCEPTANCE_PASSED");
} catch (e) {
  report.ok = false;
  report.error = (e as Error).stack;
  console.error(report.error);
  process.exitCode = 1;
} finally {
  codex.generate = original;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(DATA, "acceptance.json"),
    JSON.stringify(report, null, 2),
  );
  await blenderBridge.close();
  db.close();
}
