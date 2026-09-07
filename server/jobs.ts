import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA, ROOT, limits } from "./config";
import { runBlender } from "./sandbox";
import { assertExecution, environment } from "./environment";
import { codex } from "./codex";
import {
  db,
  put,
  get,
  list,
  uid,
  now,
  project,
  revision,
  activeJob,
  addMessage,
} from "./store";
import {
  sceneSchema,
  type Job,
  type Revision,
  type SceneCommand,
  type CameraSpec,
  type Project,
} from "../src/types";
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);
const controllers = new Map<string, AbortController>();
let queue = Promise.resolve();
export type Artifact = {
  id: string;
  projectId: string;
  path: string;
  name: string;
  mime: string;
};
export function artifact(
  file: string,
  pid: string,
  name: string,
  mime: string,
) {
  const id = uid();
  put("artifact", { id, projectId: pid, path: file, name, mime });
  return id;
}
export function artifactPath(id: string) {
  const a = get<Artifact>("artifact", id);
  if (!a) throw Object.assign(new Error("文件不存在"), { statusCode: 404 });
  const real = fs.realpathSync(a.path);
  if (
    !real.startsWith(fs.realpathSync(DATA) + path.sep) ||
    !fs.statSync(real).isFile()
  )
    throw new Error("文件不在工作台目录中");
  return real;
}
function update(j: Job, values: Partial<Job>) {
  Object.assign(j, values, { updatedAt: now() });
  if (values.stage)
    j.events = [...(j.events || []), { stage: values.stage, at: now() }];
  put("job", j);
  jobEvents.emit(j.id, j);
}
export function assertBase(pid: string, base: string | null) {
  const p = project(pid);
  if (p.currentRevisionId !== base)
    throw Object.assign(
      new Error("版本已更新，请刷新后重试；本次操作未覆盖当前版本。"),
      { statusCode: 409 },
    );
  if (activeJob(pid))
    throw Object.assign(new Error("当前项目正在保存或执行任务，请等待完成。"), {
      statusCode: 409,
    });
  return p;
}
function checkFiles(dir: string) {
  for (const name of ["scene.blend", "scene.glb", "scene.json"]) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isSymbolicLink() || fs.realpathSync(p) !== p)
      throw new Error("产物不允许使用符号链接");
    const s = fs.statSync(p);
    if (!s.isFile() || s.size < 2 || s.size > 200 * 1024 * 1024)
      throw new Error("产物大小不符合 V1 限制");
  }
  const blend = fs.readFileSync(path.join(dir, "scene.blend"));
  if (!blend.subarray(0, 7).equals(Buffer.from("BLENDER")))
    throw new Error("Blender 场景文件无效");
  const glb = fs.readFileSync(path.join(dir, "scene.glb"));
  if (
    glb.toString("ascii", 0, 4) !== "glTF" ||
    glb.readUInt32LE(4) !== 2 ||
    glb.readUInt32LE(8) !== glb.length
  )
    throw new Error("GLB 预览文件无效");
  const doc = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)));
  const ids = new Set(
    (doc.nodes || []).map((n: any) => n.extras?.forma_id).filter(Boolean),
  );
  const scene = sceneSchema.parse(
    JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8")),
  );
  if (scene.objects.some((o) => !ids.has(o.id)))
    throw new Error("GLB 缺少稳定对象 ID，拒绝保存不一致的预览");
  return scene;
}
export async function executeScene(
  dir: string,
  mode: "execute" | "command",
  signal: AbortSignal,
  onStage: (s: string) => void,
) {
  onStage("执行建模");
  const r = await runBlender(
    dir,
    ["--python", path.join(ROOT, "blender/worker.py"), "--", mode, dir],
    signal,
    limits().modelingMs,
  );
  fs.appendFileSync(
    path.join(dir, "execution.log"),
    r.stdout + "\n" + r.stderr,
  );
  if (r.code !== 0) throw new Error((r.stderr + "\n" + r.stdout).slice(-4500));
  onStage("验证场景与更新预览");
  const v = await runBlender(
    dir,
    ["--python", path.join(ROOT, "blender/worker.py"), "--", "validate", dir],
    signal,
    limits().modelingMs,
  );
  fs.appendFileSync(
    path.join(dir, "execution.log"),
    v.stdout + "\n" + v.stderr,
  );
  if (v.code !== 0) throw new Error((v.stderr + "\n" + v.stdout).slice(-4500));
  return checkFiles(dir);
}
export function enqueue(
  pid: string,
  base: string | null,
  type: string,
  payload: any,
) {
  assertExecution();
  const p = assertBase(pid, base);
  if (type === "generate" && !environment.codex.ok)
    throw Object.assign(
      new Error(environment.codex.error || "Codex 暂不可用，请检查登录和模型"),
      { statusCode: 503 },
    );
  if (
    payload.objectId &&
    base &&
    !revision(base).scene.objects.some((o) => o.id === payload.objectId)
  )
    throw Object.assign(new Error("选中对象不在当前版本中"), {
      statusCode: 400,
    });
  const j: Job = {
    id: uid(),
    projectId: pid,
    baseRevisionId: base,
    type,
    status: "queued",
    stage: "排队等待",
    error: null,
    resultRevisionId: null,
    createdAt: now(),
    updatedAt: now(),
    message: "",
    events: [],
  };
  put("job", j);
  const ctrl = new AbortController();
  controllers.set(j.id, ctrl);
  if (type === "generate") addMessage(pid, "user", payload.prompt);
  // One global Blender/AI pipeline at a time, keeping M2 memory usage bounded.
  queue = queue.then(() => perform(j, p, payload, ctrl)).catch(() => {});
  return j;
}
async function perform(
  j: Job,
  p: Project,
  payload: any,
  ctrl: AbortController,
) {
  const signal = ctrl.signal;
  let dir = "";
  try {
    if (signal.aborted) throw new Error("任务已取消");
    update(j, {
      status: "running",
      stage:
        j.type === "generate"
          ? "生成脚本"
          : j.type === "render"
            ? "准备渲染"
            : "保存修改",
    });
    const root = path.join(DATA, "jobs", j.id);
    fs.mkdirSync(root, { recursive: true });
    dir = path.join(root, "attempt-0");
    fs.mkdirSync(dir);
    if (j.baseRevisionId)
      fs.copyFileSync(
        artifactPath(revision(j.baseRevisionId).artifacts.blend),
        path.join(dir, "base.blend"),
      );
    if (j.type === "render") {
      fs.writeFileSync(
        path.join(dir, "camera.json"),
        JSON.stringify(payload.camera),
      );
      update(j, { stage: "Blender 正在渲染" });
      const r = await runBlender(
        dir,
        ["--python", path.join(ROOT, "blender/worker.py"), "--", "render", dir],
        signal,
        limits().renderingMs,
      );
      fs.writeFileSync(
        path.join(dir, "execution.log"),
        r.stdout + "\n" + r.stderr,
      );
      if (r.code !== 0)
        throw new Error((r.stderr + "\n" + r.stdout).slice(-4000));
      const png = path.join(dir, "render.png");
      if (
        fs.lstatSync(png).isSymbolicLink() ||
        !fs
          .readFileSync(png)
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error("渲染没有生成有效 PNG");
      if (signal.aborted) throw new Error("任务已取消");
      const id = artifact(
        png,
        p.id,
        "Ai-FormaDesk-" + j.baseRevisionId + ".png",
        "image/png",
      );
      put("render", {
        id: uid(),
        projectId: p.id,
        revisionId: j.baseRevisionId!,
        artifactId: id,
        camera: payload.camera,
        createdAt: now(),
      } as any);
      update(j, {
        status: "succeeded",
        stage: "渲染完成",
        renderArtifactId: id,
        message: "1280 × 720 · EEVEE 渲染已保存",
      });
      return;
    }
    let scene;
    let script = "";
    let summary = "";
    if (j.type === "generate") {
      let context = `用户指令：${payload.prompt}\n当前版本：${j.baseRevisionId || "空白场景"}\n选中对象 ID：${payload.objectId || "无"}\n最新场景：${JSON.stringify(j.baseRevisionId ? revision(j.baseRevisionId).scene : { objects: [] })}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (signal.aborted) throw new Error("任务已取消");
        update(j, { stage: attempt ? `修复脚本（${attempt}/2）` : "生成脚本" });
        const result = await codex.generate(
          p.id,
          project(p.id).threadId,
          context,
          signal,
          (id) => {
            const current = project(p.id);
            put("project", { ...current, threadId: id });
          },
          () => {},
        );
        script = result.python;
        summary = result.summary;
        if (attempt) {
          dir = path.join(root, `attempt-${attempt}`);
          fs.mkdirSync(dir);
          if (j.baseRevisionId)
            fs.copyFileSync(
              artifactPath(revision(j.baseRevisionId).artifacts.blend),
              path.join(dir, "base.blend"),
            );
        }
        fs.writeFileSync(path.join(dir, "generated.py"), script);
        try {
          scene = await executeScene(dir, "execute", signal, (stage) =>
            update(j, { stage }),
          );
          break;
        } catch (e) {
          if (signal.aborted || attempt === 2) throw e;
          context += `\n本次脚本在 Blender 4.5 执行失败；原版本未改变。请修复脚本。错误：${(e as Error).message}`;
        }
      }
    } else {
      script = fs.readFileSync(path.join(ROOT, "blender/worker.py"), "utf8");
      fs.writeFileSync(path.join(dir, "generated.py"), script);
      fs.writeFileSync(path.join(dir, "command.json"), JSON.stringify(payload));
      scene = await executeScene(dir, "command", signal, (stage) =>
        update(j, { stage }),
      );
      summary = (
        {
          transform: "已保存对象变换",
          material: "已保存材质",
          light: "已保存灯光",
          duplicate: "已复制对象",
          delete: "已删除对象",
          visibility: "已保存可见性",
          rename: "已重命名对象",
        } as any
      )[payload.operation];
    }
    if (!scene) throw new Error("没有有效场景");
    if (signal.aborted) throw new Error("任务已取消");
    if (project(p.id).currentRevisionId !== j.baseRevisionId)
      throw new Error("版本已变化，任务结果未覆盖当前项目");
    // Host copies verified output out of the writable job sandbox into immutable revision storage.
    const rid = uid();
    const out = path.join(DATA, "revisions", rid);
    fs.mkdirSync(out, { recursive: true });
    const artifacts: any = {};
    const files = [
      ["blend", "scene.blend", "application/x-blender"],
      ["glb", "scene.glb", "model/gltf-binary"],
      ["manifest", "scene.json", "application/json"],
      ["script", "generated.py", "text/x-python"],
      ["log", "execution.log", "text/plain"],
    ];
    db.transaction(() => {
      for (const [key, name, mime] of files) {
        const f = path.join(out, name);
        fs.copyFileSync(path.join(dir, name), f);
        fs.chmodSync(f, 0o400);
        artifacts[key] = artifact(f, p.id, `Ai-FormaDesk-${rid}-${name}`, mime);
      }
      const r: Revision = {
        id: rid,
        projectId: p.id,
        parentId: j.baseRevisionId,
        source: j.type,
        label: j.type === "generate" ? payload.prompt : summary,
        createdAt: now(),
        scene: scene!,
        artifacts,
      };
      put("revision", r);
      put("project", { ...project(p.id), currentRevisionId: rid, redo: [] });
      update(j, {
        status: "succeeded",
        stage: "完成",
        resultRevisionId: rid,
        message: summary,
      });
      if (j.type === "generate") addMessage(p.id, "assistant", summary);
    })();
  } catch (e) {
    update(j, {
      status: signal.aborted ? "cancelled" : "failed",
      stage: signal.aborted ? "已取消" : "失败",
      error: (e as Error).message || "执行失败",
    });
    if (j.type === "generate") addMessage(p.id, "error", j.error!);
  } finally {
    controllers.delete(j.id);
  }
}
export function cancel(id: string) {
  const j = get<Job>("job", id);
  if (!j) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
  if (["queued", "running"].includes(j.status)) {
    controllers.get(id)?.abort();
    if (j.status === "queued")
      update(j, { status: "cancelled", stage: "已取消", error: "任务已取消" });
  }
  return j;
}
export function cancelAll() {
  for (const c of controllers.values()) c.abort();
}
export function restore(
  pid: string,
  base: string | null,
  target: string | null,
  action: "undo" | "redo" | "restore",
) {
  const p = assertBase(pid, base);
  let next = target;
  let redo = [...p.redo];
  if (action === "undo") {
    if (!base) throw new Error("没有可撤销版本");
    next = revision(base).parentId;
    redo.push(base);
  } else if (action === "redo") {
    next = redo.pop() || null;
    if (!next) throw new Error("没有可重做版本");
  } else redo = [];
  if (next && revision(next).projectId !== pid)
    throw Object.assign(new Error("不能恢复其他项目的版本"), {
      statusCode: 400,
    });
  put("project", { ...p, currentRevisionId: next, redo });
  return project(pid);
}
