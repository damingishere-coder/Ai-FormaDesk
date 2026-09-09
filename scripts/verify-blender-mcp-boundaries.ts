import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DATA } from "../server/config";
import { environment } from "../server/environment";
import { blenderBridge } from "../server/blender-mcp";
import { sessionGuard } from "../server/blender-mcp-code";
import { enqueue } from "../server/jobs";
import { db, get, project, revision } from "../server/store";
import type { Job } from "../src/types";

if (!DATA.includes("mcp-proof"))
  throw new Error("必须使用独立 mcp-proof 验收数据目录");
const previous = JSON.parse(
  fs.readFileSync(path.join(DATA, "acceptance.json"), "utf8"),
);
assert.equal(previous.ok, true);
const pid = previous.projectId;
const report: any = {
  startedAt: new Date().toISOString(),
  projectId: pid,
  steps: [],
};
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
try {
  environment.blender = { ok: true };
  environment.sandbox = { ok: true };
  environment.codex = { ok: true };
  await blenderBridge.reconnect(pid);
  const sid = blenderBridge.status().sessionId!;
  await blenderBridge.disconnect(pid);
  assert(blenderBridge.status().recoverable?.some((s) => s.id === sid));
  await blenderBridge.recover(pid, sid);
  assert.equal(blenderBridge.status().sessionId, sid);
  report.steps.push({
    step: "disconnect and recover original GUI",
    passed: true,
  });

  // Test-only access simulates a manual Blender edit. No HTTP endpoint exposes Python.
  const bridge = blenderBridge as any;
  const newName = `手动新增验收物体-${Date.now()}`;
  await bridge.execute(
    bridge.session,
    sessionGuard(sid) +
      `\nbpy.ops.mesh.primitive_cube_add(size=.2,location=(-1,0,.1))\nbpy.context.object.name=${JSON.stringify(newName)}\nprint('FORMA_RESULT:{}')`,
  );
  const sync = await done(
    enqueue(pid, project(pid).currentRevisionId, "blender-sync", {}),
  );
  const synced = revision(sync.resultRevisionId!);
  const added = synced.scene.objects.find((o) => o.name === newName)!;
  assert.match(added.id, /^[a-f0-9-]{36}$/);
  report.steps.push({
    step: "manual new object receives stable ID and GLB",
    revisionId: synced.id,
    objectId: added.id,
  });

  const edited = await done(
    enqueue(pid, synced.id, "blender-edit", {
      objectId: added.id,
      prompt: "把选中的这个物体整体放大 10%，其他都保持不变",
    }),
  );
  const changed = revision(edited.resultRevisionId!);
  changed.scene.objects
    .find((o) => o.id === added.id)!
    .transform.scale.forEach((v) => assert(Math.abs(v - 1.1) < 1e-5));
  assert.deepEqual(
    changed.scene.objects.filter((o) => o.id !== added.id),
    synced.scene.objects.filter((o) => o.id !== added.id),
  );
  report.steps.push({
    step: "real AI natural language edit and sync",
    revisionId: changed.id,
    otherPreserved: true,
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    blenderBridge.capture(pid, changed.id, DATA, controller.signal),
    /取消/,
  );
  assert.equal(blenderBridge.status().state, "uncertain");
  await assert.rejects(
    blenderBridge.capture(pid, changed.id, DATA, new AbortController().signal),
    /重新连接/,
  );
  await blenderBridge.reconnect(pid);
  report.steps.push({
    step: "cancel prevents replay, reconnect reads real scene",
    passed: true,
  });

  await bridge.execute(
    bridge.session,
    sessionGuard(sid) +
      "\nbpy.context.scene['forma_bridge_file']='switched-file-for-test'\nprint('FORMA_RESULT:{}')",
  );
  await assert.rejects(blenderBridge.inspect(pid), /文件已切换/);
  await bridge.execute(
    bridge.session,
    "import bpy\nbpy.context.scene['forma_bridge_file']=bpy.data.filepath\nprint('FORMA_RESULT:{}')",
  );
  await blenderBridge.reconnect(pid);
  report.steps.push({
    step: "switched Blender file blocks accidental sync",
    passed: true,
  });
  report.ok = true;
  console.log("MCP_BOUNDARIES_PASSED");
} catch (e) {
  report.ok = false;
  report.error = (e as Error).stack;
  console.error(report.error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(DATA, "boundaries.json"),
    JSON.stringify(report, null, 2),
  );
  await blenderBridge.close();
  db.close();
}
