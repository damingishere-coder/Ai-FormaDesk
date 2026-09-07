import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA, ROOT, limits } from "./config";
import { runBlender } from "./sandbox";
import { assertExecution, environment } from "./environment";
import { codex } from "./codex";
import { attachmentPath, validateAttachments } from "./attachments";
import { prepareImage, preparedImage, runImageProbe } from "./image3d";
import { correctionMask } from "./image-correction";
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
  invalidateProposals,
} from "./store";
import {
  sceneSchema,
  type Job,
  type Revision,
  type Project,
  type Proposal,
  type Message,
} from "../src/types";
export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(100);
const controllers = new Map<string, AbortController>();
const queuedPayloads = new Map<string, any>();
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
  if (values.stage && values.stage !== j.stage) {
    j.events = [...(j.events || []), { stage: values.stage, at: now() }];
    j.stageTiming = undefined;
  }
  Object.assign(j, values, { updatedAt: now() });
  put("job", j);
  jobEvents.emit(j.id, j);
}
function imageStageTiming(report: any): Job["stageTiming"] {
  const stage = report.stages?.at(-1);
  if (
    report.status === "queued" ||
    report.shapeReviewPending !== undefined ||
    !Number.isFinite(stage?.startedAt)
  )
    return undefined;
  return {
    startedAt: stage.startedAt,
    seconds: stage.status === "running" ? undefined : stage.seconds,
  };
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
  mode: "execute" | "command" | "image3d" | "surface-refine",
  signal: AbortSignal,
  onStage: (s: string) => void,
  budget?: { remainingMs: number },
) {
  if (budget && budget.remainingMs <= 0)
    throw new Error("已达到图生建模处理预算");
  onStage("执行建模");
  const r = await runBlender(
    dir,
    ["--python", path.join(ROOT, "blender/worker.py"), "--", mode, dir],
    signal,
    Math.min(limits().modelingMs, budget?.remainingMs ?? Infinity),
  );
  if (budget) budget.remainingMs -= r.executionMs;
  fs.appendFileSync(
    path.join(dir, "execution.log"),
    r.stdout + "\n" + r.stderr,
  );
  if (r.code !== 0) throw new Error((r.stderr + "\n" + r.stdout).slice(-4500));
  onStage("验证场景与更新预览");
  if (budget && budget.remainingMs <= 0)
    throw new Error("已达到图生建模处理预算");
  const v = await runBlender(
    dir,
    ["--python", path.join(ROOT, "blender/worker.py"), "--", "validate", dir],
    signal,
    Math.min(limits().modelingMs, budget?.remainingMs ?? Infinity),
  );
  if (budget) budget.remainingMs -= v.executionMs;
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
  if (!["discuss", "prepare-image", "accept-image3d"].includes(type))
    assertExecution();
  const p = assertBase(pid, base);
  if (
    ["generate", "discuss", "image3d", "surface-refine"].includes(type) &&
    !environment.codex.ok
  )
    throw Object.assign(
      new Error(environment.codex.error || "Codex 暂不可用，请检查登录和模型"),
      { statusCode: 503 },
    );
  if (type === "prepare-image")
    validateAttachments(pid, [payload.attachmentId]);
  if (type === "image3d") {
    const input = preparedImage(pid, payload.preparedImageId);
    if (input.status !== "ready") throw new Error("请先选择并确认主体蒙版");
    validateAttachments(pid, [
      ...new Set<string>([
        input.attachmentId,
        ...(payload.attachmentIds || []),
      ]),
    ]);
    if (
      !environment.image3d?.shape?.installationReady ||
      !environment.image3d?.texture?.installationReady
    )
      throw new Error("形体或纹理引擎尚未安装，请查看环境检查");
  }
  if (type === "accept-image3d") {
    const candidate = get<Job>("job", payload.candidateJobId);
    if (
      !candidate ||
      candidate.projectId !== pid ||
      candidate.baseRevisionId !== base ||
      (!candidate.candidateManifest && !candidate.candidateCanAdopt) ||
      candidate.status !== "partial" ||
      candidate.resultRevisionId
    )
      throw new Error("候选不存在、已采用或与当前版本不一致");
  }
  if (type === "surface-refine") {
    if (!base || !payload.objectId) throw new Error("请选择已保存版本中的对象");
    if (!environment.image3d?.texture?.installationReady)
      throw new Error("本地纹理引擎尚未安装");
    const refs = payload.attachmentIds?.length
      ? payload.attachmentIds
      : [revision(base).image3d?.primaryAttachmentId];
    if (!refs.every((id: unknown) => typeof id === "string"))
      throw new Error("请提供用于精修的参考照片");
    validateAttachments(pid, refs);
    payload.attachmentIds = refs;
  }
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
  queuedPayloads.set(j.id, payload);
  if (type === "generate")
    addMessage(
      pid,
      "user",
      payload.proposalId ? "执行方案：" + payload.prompt : payload.prompt,
      { jobId: j.id },
    );
  if (type === "image3d") {
    const input = preparedImage(pid, payload.preparedImageId);
    const images = validateAttachments(pid, [
      ...new Set<string>([
        input.attachmentId,
        ...(payload.attachmentIds || []),
      ]),
    ]);
    for (const image of images) put("attachment", { ...image, used: true });
    addMessage(pid, "user", payload.prompt, {
      jobId: j.id,
      attachmentIds: images.map((image) => image.id),
    });
  }
  if (type === "discuss") {
    invalidateProposals(pid);
    const images = validateAttachments(pid, payload.attachmentIds || []);
    for (const a of images) put("attachment", { ...a, used: true });
    addMessage(pid, "user", payload.prompt, {
      attachmentIds: images.map((a) => a.id),
      jobId: j.id,
    });
    payload.replyId = addMessage(pid, "assistant", "", {
      status: "pending",
      jobId: j.id,
    }).id;
  }
  put("project", { ...project(pid), updatedAt: now() });
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
  if (signal.aborted) {
    controllers.delete(j.id);
    queuedPayloads.delete(j.id);
    return;
  }
  let dir = "";
  try {
    if (signal.aborted) throw new Error("任务已取消");
    update(j, {
      status: "running",
      startedAt: now(),
      stage:
        j.type === "generate"
          ? "生成脚本"
          : j.type === "render"
            ? "准备渲染"
            : "保存修改",
    });
    if (j.type === "discuss") {
      update(j, { stage: "正在讨论创作想法" });
      const history = list<Message>("message", p.id)
        .filter((m) => m.status === "completed")
        .slice(-24);
      const imageIds: string[] = payload.attachmentIds.length
        ? payload.attachmentIds
        : [...history].reverse().find((m) => m.attachmentIds?.length)
            ?.attachmentIds || [];
      const images = validateAttachments(p.id, imageIds);
      const context = `当前用户消息：${payload.prompt || "（仅发送了图片，请先询问用途）"}\n当前版本：${j.baseRevisionId || "空白"}\n选中对象：${payload.objectId || "无"}\n场景：${JSON.stringify(j.baseRevisionId ? revision(j.baseRevisionId).scene : { objects: [] })}\n近期对话：${JSON.stringify(history.map((m) => ({ role: m.role, text: m.text, attachmentIds: m.attachmentIds })))}\n本轮可见图片：${JSON.stringify(images.map((a, i) => ({ number: i + 1, id: a.id, name: a.name })))}。方案只能引用本轮可见图片。`;
      const result = await codex.discuss(
        p.id,
        project(p.id).discussionThreadId || null,
        context,
        signal,
        (id) => put("project", { ...project(p.id), discussionThreadId: id }),
        () => {},
        images.map((a) => attachmentPath(p.id, a.id)),
      );
      if (signal.aborted) throw new Error("任务已取消");
      let proposalId: string | undefined;
      if (result.proposal) {
        const chosen = result.proposal.attachmentIds;
        if (chosen.some((id) => !imageIds.includes(id)))
          throw new Error("方案引用了本轮不可见的图片，请重新整理方案");
        if (
          result.proposal.route === "image3d" &&
          (!result.proposal.primaryAttachmentId ||
            !chosen.includes(result.proposal.primaryAttachmentId))
        )
          throw new Error("图生方案必须从引用图片中指定一张主图");
        proposalId = uid();
        put<Proposal>("proposal", {
          id: proposalId,
          projectId: p.id,
          baseRevisionId: j.baseRevisionId,
          objectId: payload.objectId || null,
          title: result.proposal.title,
          description: result.proposal.description,
          attachmentIds: chosen,
          route: result.proposal.route,
          primaryAttachmentId: result.proposal.primaryAttachmentId,
          status: "ready",
          createdAt: now(),
        });
      }
      put("message", {
        ...get<Message>("message", payload.replyId)!,
        text: result.reply,
        status: "completed",
        proposalId,
      });
      update(j, {
        status: "succeeded",
        stage: "讨论完成",
        message: "回复已保存",
      });
      return;
    }
    const root = path.join(DATA, "jobs", j.id);
    fs.mkdirSync(root, { recursive: true });
    dir = path.join(root, "attempt-0");
    fs.mkdirSync(dir);
    if (j.type === "prepare-image") {
      update(j, { stage: "分离照片主体" });
      const prepared = await prepareImage(
        p.id,
        payload.attachmentId,
        path.join(dir, "foreground-job"),
        signal,
        (report) =>
          update(j, {
            stage:
              report.status === "queued" ? "等待本机计算资源" : "分离照片主体",
          }),
      );
      if (signal.aborted) throw new Error("任务已取消");
      update(j, {
        status: "succeeded",
        stage: "图片准备完成",
        preparedImageId: prepared.id,
        message:
          prepared.status === "ready"
            ? "已分离主体，可检查或修补蒙版"
            : "请选择并修补主体蒙版",
      });
      return;
    }
    if (j.baseRevisionId)
      fs.copyFileSync(
        artifactPath(revision(j.baseRevisionId).artifacts.blend),
        path.join(dir, "base.blend"),
      );
    if (j.type === "render") {
      fs.writeFileSync(
        path.join(dir, "camera.json"),
        JSON.stringify({ ...payload.camera, settings: payload.settings }),
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
        settings: payload.settings,
        createdAt: now(),
      } as any);
      update(j, {
        status: "succeeded",
        stage: "渲染完成",
        renderArtifactId: id,
        message: `${payload.settings.width} × ${payload.settings.height} · EEVEE 渲染已保存`,
      });
      return;
    }
    let scene;
    let outputDirectory: string | undefined;
    let script = "";
    let summary = "";
    let imageProvenance: Record<string, unknown> | undefined;
    if (j.type === "accept-image3d") {
      const candidate = get<any>("image3d-candidate", payload.candidateJobId);
      const original = get<Job>("job", payload.candidateJobId);
      if (
        !candidate ||
        candidate.projectId !== p.id ||
        !original ||
        original.baseRevisionId !== j.baseRevisionId
      )
        throw new Error("候选与当前作品不一致");
      const source = path.join(DATA, "jobs", original.id, "attempt-0");
      if (candidate.directory !== source) throw new Error("候选目录无效");
      if (candidate.kind === "shape") {
        if (!/^geometry-[01]\.blend$/.test(candidate.geometryFile))
          throw new Error("形体候选文件无效");
        const geometry = path.join(source, "inference", candidate.geometryFile);
        if (fs.realpathSync(geometry) !== geometry)
          throw new Error("形体候选不允许符号链接");
        fs.copyFileSync(geometry, path.join(dir, "subject.blend"));
        fs.writeFileSync(
          path.join(dir, "command.json"),
          JSON.stringify({
            objectId: candidate.objectId,
            name: "待精修的形体候选",
          }),
        );
        fs.writeFileSync(
          path.join(dir, "generated.py"),
          fs.readFileSync(path.join(ROOT, "blender/worker.py")),
        );
        scene = await executeScene(dir, "image3d", signal, (stage) =>
          update(j, { stage }),
        );
      } else {
        const selected =
          candidate.selectedDirectory === "correction-version"
            ? path.join(source, "correction-version")
            : source;
        scene = checkFiles(selected);
        for (const name of [
          "scene.blend",
          "scene.glb",
          "scene.json",
          "generated.py",
          "execution.log",
        ])
          fs.copyFileSync(path.join(selected, name), path.join(dir, name));
      }
      imageProvenance = {
        ...candidate.provenance,
        adoptedCandidate: original.id,
        incompleteStepsAccepted: true,
        visualAcceptance: "pending",
      };
      summary =
        candidate.kind === "shape"
          ? "已保存可编辑的形体候选；上色未完成，原有质检问题仍保留在版本记录中。"
          : "已保存为可编辑的实验性版本；尚未完成的检查仍保留在版本记录中。";
    } else if (j.type === "surface-refine") {
      const probeDir = path.join(dir, "inference");
      fs.mkdirSync(probeDir, { recursive: true });
      const budget = { remainingMs: 1800_000 };
      fs.copyFileSync(
        path.join(dir, "base.blend"),
        path.join(probeDir, "base.blend"),
      );
      fs.writeFileSync(
        path.join(probeDir, "request.json"),
        JSON.stringify({ objectId: payload.objectId, camera: payload.camera }),
      );
      fs.writeFileSync(
        path.join(probeDir, "selection.png"),
        Buffer.from(payload.mask.split(",")[1], "base64"),
      );
      fs.copyFileSync(
        attachmentPath(p.id, payload.attachmentIds[0]),
        path.join(probeDir, "reference.png"),
      );
      update(j, { stage: "理解局部表面修改要求" });
      const start = performance.now();
      const analysis = await codex.analyzeImage(
        p.id,
        `在保留主体结构的前提下修改选区表面。用户修改要求：${payload.prompt}。texturePrompt 必须体现修改后需要的外观。`,
        signal,
        payload.attachmentIds.map((id: string) => attachmentPath(p.id, id)),
      );
      budget.remainingMs -= performance.now() - start;
      if (budget.remainingMs <= 0) throw new Error("已达到 30 分钟处理预算");
      const report = await runImageProbe(
        probeDir,
        [
          "--prompt",
          analysis.texturePrompt,
          "--budget",
          String(Math.floor(budget.remainingMs / 1000)),
        ],
        signal,
        (value) => {
          const phase = value.stages?.at(-1)?.stage;
          update(j, {
            stageTiming: imageStageTiming(value),
            stage:
              value.status === "queued"
                ? "等待本机计算资源"
                : (
                    {
                      "prepare-refine": "检查选区与原有纹理",
                      workflow: "准备局部精修",
                      texture: "生成选区表面",
                      "project-refine": "检查遮挡与保存选区纹理",
                    } as Record<string, string>
                  )[phase] || "校验纹理引擎",
          });
        },
        "refine",
      );
      budget.remainingMs -= report.executionSeconds * 1000;
      fs.copyFileSync(
        path.join(probeDir, "refined.blend"),
        path.join(dir, "subject.blend"),
      );
      fs.writeFileSync(
        path.join(dir, "generated.py"),
        "# Trusted local surface refinement; geometry and IDs preserved.\n",
      );
      scene = await executeScene(
        dir,
        "surface-refine",
        signal,
        (stage) => update(j, { stage }),
        budget,
      );
      const before = revision(j.baseRevisionId!).scene;
      if (
        scene.stats.triangles !== before.stats.triangles ||
        scene.objects.length !== before.objects.length ||
        scene.objects.some((o) => {
          const previous = before.objects.find((v) => v.id === o.id);
          return (
            !previous ||
            JSON.stringify(previous.transform) !==
              JSON.stringify(o.transform) ||
            previous.parentId !== o.parentId
          );
        })
      )
        throw new Error("精修改变了网格数量、对象 ID 或变换，已保留原版本");
      imageProvenance = {
        ...revision(j.baseRevisionId!).image3d,
        lastSurfaceRefinement: { analysis, report, objectId: payload.objectId },
        visualAcceptance: "pending",
      };
      summary =
        "已完成选区表面精修；未选贴图像素、透明度和网格保持不变。可在版本记录中撤销。";
    } else if (j.type === "image3d") {
      const input = preparedImage(p.id, payload.preparedImageId);
      const auxiliaryIds: string[] = (payload.attachmentIds || []).filter(
        (id: string) => id !== input.attachmentId,
      );
      const probeDir = path.join(dir, "inference");
      const budget = { remainingMs: 1800_000 };
      update(j, { stage: "分析主体比例、结构与颜色" });
      const analysisStart = performance.now();
      const analysis = await codex.analyzeImage(
        p.id,
        `${payload.prompt}。前两张为主图及分离主体，其余为同一主体辅助照片；辅助图用于核对结构、补充颜色花纹描述，形体和相机仍以主图为准。不要将不同照片当作原生多视图重建输入。`,
        AbortSignal.any([signal, AbortSignal.timeout(1800_000)]),
        [
          attachmentPath(p.id, input.attachmentId),
          attachmentPath(p.id, input.imageId),
          ...auxiliaryIds.map((id) => attachmentPath(p.id, id)),
        ],
      );
      budget.remainingMs -= performance.now() - analysisStart;
      fs.writeFileSync(
        path.join(dir, "image-analysis.json"),
        JSON.stringify(analysis),
      );
      if (budget.remainingMs <= 0) throw new Error("已达到 30 分钟处理预算");
      update(j, { stage: "校验本地权重" });
      let publishedShape = "";
      const report = await runImageProbe(
        probeDir,
        [
          "--image",
          attachmentPath(p.id, input.imageId),
          "--quality-handshake",
          "--budget",
          String(Math.floor(budget.remainingMs / 1000)),
          "--prompt",
          analysis.texturePrompt,
        ],
        signal,
        (report) => {
          const phase: string = report.stages?.at(-1)?.stage || "";
          const view = Number(phase.split("-").at(-1));
          const viewName = ["", "左侧", "右侧", "背面"][view] || "";
          const stage =
            report.status === "queued"
              ? "等待本机计算资源"
              : phase.startsWith("texture-")
                ? `生成${viewName}纹理`
                : phase.startsWith("view-")
                  ? `检查${viewName}已有纹理`
                  : phase.startsWith("project-")
                    ? `融合${viewName}纹理`
                    : (
                        {
                          shape: "生成形体",
                          "shape-retry": "纠正形体（1/1）",
                          prepare: "检查形体与准备预览",
                          "prepare-retry": "检查纠正后的形体",
                          "photo-projection": "匹配照片视角与保留原图",
                          bake: "烘焙纹理与多角度检查",
                        } as Record<string, string>
                      )[phase] || "准备纹理工作流";
          const values: Partial<Job> = {
            stage,
            stageTiming: imageStageTiming(report),
          };
          if (phase.startsWith("fit-review-"))
            values.stage = "匹配原照相机与生成形体对照图";
          const file = report.shapePreviewFile || "shape-preview.glb";
          if (
            report.shapePreview &&
            file !== publishedShape &&
            /^shape-(preview|candidate-[01])\.glb$/.test(file)
          ) {
            publishedShape = file;
            values.candidateArtifactId = artifact(
              path.join(probeDir, file),
              p.id,
              "形体候选.glb",
              "model/gltf-binary",
            );
          }
          if (report.shapeReviewPending !== undefined)
            values.stage = "对照原照检查形体";
          update(j, values);
        },
        true,
        async (attempt, remaining) => {
          const quality = await codex.reviewImage(
            p.id,
            `这是形体阶段，仅检查轮廓、比例、部件数量、明显粘连；灰色模型尚未上色，textureIssues 必须为空。用户要求：${payload.prompt}。形体候选 ${attempt + 1}。`,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(Math.max(1, Math.floor(remaining * 1000))),
            ]),
            [
              attachmentPath(p.id, input.attachmentId),
              ...["front", "left", "right", "back"].map((side) =>
                path.join(probeDir, `shape-${attempt}-${side}.png`),
              ),
            ],
          );
          return {
            action: quality.acceptable
              ? "continue"
              : attempt === 0
                ? "regenerate"
                : "stop",
            quality,
            attempt,
            seed: 42 + attempt,
          };
        },
      );
      budget.remainingMs -=
        (report.executionSeconds ??
          report.stages.reduce(
            (n: number, s: any) => n + (s.seconds || 0),
            0,
          )) * 1000;
      if (report.projectedViews !== 4)
        throw new Error("多视角步骤未全部完成，原版本保留");
      fs.copyFileSync(
        path.join(probeDir, "textured.blend"),
        path.join(dir, "subject.blend"),
      );
      fs.writeFileSync(
        path.join(dir, "command.json"),
        JSON.stringify({
          objectId: payload.objectId,
          name: analysis.summary.slice(0, 60),
        }),
      );
      script = fs.readFileSync(path.join(ROOT, "blender/worker.py"), "utf8");
      fs.writeFileSync(path.join(dir, "generated.py"), script);
      scene = await executeScene(
        dir,
        "image3d",
        signal,
        (stage) => update(j, { stage }),
        budget,
      );
      imageProvenance = {
        route: "image3d",
        preparedImageId: input.id,
        primaryAttachmentId: input.attachmentId,
        auxiliaryAttachmentIds: auxiliaryIds,
        scaleEstimated: true,
        longestSideMeters: 1,
        textureViews: 4,
        visualAcceptance: "pending",
        analysis,
        report,
      };
      update(j, {
        stage: "对照照片检查形体与纹理",
        candidateArtifactId: artifact(
          path.join(dir, "scene.glb"),
          p.id,
          "已上色候选.glb",
          "model/gltf-binary",
        ),
        candidateManifest: scene,
      });
      const candidate = {
        id: j.id,
        projectId: p.id,
        baseRevisionId: j.baseRevisionId,
        directory: dir,
        provenance: imageProvenance,
        createdAt: now(),
      };
      put("image3d-candidate", candidate);
      if (budget.remainingMs <= 0)
        throw new Error("已达到 30 分钟处理预算，已保留上色候选");
      const deadline = AbortSignal.timeout(
        Math.max(1, Math.floor(budget.remainingMs)),
      );
      const reviewStart = performance.now();
      let quality = await codex.reviewImage(
        p.id,
        `用户需求：${payload.prompt}\n主体分析：${analysis.summary}\n相机估计：${JSON.stringify(report.cameraFit)}`,
        AbortSignal.any([signal, deadline]),
        [
          attachmentPath(p.id, input.attachmentId),
          ...[0, 1, 2, 3].map((i) =>
            path.join(probeDir, `textured-view-${i}.png`),
          ),
        ],
      );
      budget.remainingMs -= performance.now() - reviewStart;
      imageProvenance.quality = quality;
      put("image3d-candidate", { ...candidate, provenance: imageProvenance });
      if (
        !quality.acceptable &&
        quality.textureIssues.length &&
        !quality.shapeIssues.length &&
        quality.textureCorrection &&
        budget.remainingMs > 1000
      ) {
        const correction = quality.textureCorrection;
        const correctionDir = path.join(dir, "texture-correction");
        const attempt: Record<string, unknown> = {
          round: 1,
          correction,
          accepted: false,
          beforeQuality: quality,
        };
        imageProvenance.textureCorrection = attempt;
        try {
          const mask = await correctionMask(correction);
          fs.mkdirSync(correctionDir, { recursive: true });
          fs.copyFileSync(
            path.join(probeDir, "textured.blend"),
            path.join(correctionDir, "base.blend"),
          );
          fs.copyFileSync(
            attachmentPath(p.id, input.imageId),
            path.join(correctionDir, "reference.png"),
          );
          fs.writeFileSync(path.join(correctionDir, "selection.png"), mask);
          fs.writeFileSync(
            path.join(correctionDir, "request.json"),
            JSON.stringify({ storedCameraIndex: correction.view }),
          );
          const corrected = await runImageProbe(
            correctionDir,
            [
              "--prompt",
              correction.prompt,
              "--budget",
              String(Math.floor(budget.remainingMs / 1000)),
            ],
            signal,
            (value) =>
              update(j, {
                stageTiming: imageStageTiming(value),
                stage:
                  value.status === "queued"
                    ? "等待本机计算资源"
                    : "局部纹理纠错（1/1）",
              }),
            "refine",
          );
          budget.remainingMs -= corrected.executionSeconds * 1000;
          attempt.report = corrected;
          if (budget.remainingMs <= 0)
            throw new Error("纠错达到处理预算，保留原上色候选");
          update(j, { stage: "比较纠错前后的关键特征" });
          const comparisonStart = performance.now();
          const after = await codex.reviewImage(
            p.id,
            `用户需求：${payload.prompt}。这是唯一一轮局部纹理纠错。第一张为原照，接下来四张为修正后的正/左/右/背面，最后四张为修正前对应视图。只在关键特征没有退化且整体可接受时放行，不再提出下一轮纠错。`,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(Math.max(1, Math.floor(budget.remainingMs))),
            ]),
            [
              attachmentPath(p.id, input.attachmentId),
              ...[0, 1, 2, 3].map((i) =>
                path.join(correctionDir, `textured-view-${i}.png`),
              ),
              ...[0, 1, 2, 3].map((i) =>
                path.join(probeDir, `textured-view-${i}.png`),
              ),
            ],
          );
          budget.remainingMs -= performance.now() - comparisonStart;
          attempt.afterQuality = after;
          if (after.acceptable && !after.regressed && budget.remainingMs > 0) {
            const correctedVersion = path.join(dir, "correction-version");
            fs.mkdirSync(correctedVersion, { recursive: true });
            for (const name of ["base.blend", "command.json", "generated.py"])
              if (fs.existsSync(path.join(dir, name)))
                fs.copyFileSync(
                  path.join(dir, name),
                  path.join(correctedVersion, name),
                );
            fs.copyFileSync(
              path.join(correctionDir, "refined.blend"),
              path.join(correctedVersion, "subject.blend"),
            );
            const nextScene = await executeScene(
              correctedVersion,
              "image3d",
              signal,
              (stage) => update(j, { stage }),
              budget,
            );
            scene = nextScene;
            outputDirectory = correctedVersion;
            quality = after;
            attempt.accepted = true;
            imageProvenance.quality = after;
            Object.assign(candidate, {
              selectedDirectory: "correction-version",
            });
            update(j, {
              candidateManifest: scene,
              candidateArtifactId: artifact(
                path.join(correctedVersion, "scene.glb"),
                p.id,
                "局部纠错候选.glb",
                "model/gltf-binary",
              ),
            });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          attempt.error = (error as Error).message;
        }
        put("image3d-candidate", { ...candidate, provenance: imageProvenance });
      }
      if (!quality.acceptable || report.cameraFit?.silhouetteIoU < 0.5) {
        update(j, {
          status: "partial",
          stage: "保留候选 · 需要精修",
          message: quality.summary,
        });
        if (payload.proposalId)
          put("proposal", {
            ...get<Proposal>("proposal", payload.proposalId)!,
            status: "failed",
          });
        addMessage(p.id, "assistant", quality.summary, { jobId: j.id });
        return;
      }
      summary =
        "已生成四视角纹理模型并完成照片对照检查；各类别仍为实验性，尺寸和不可见部分为估计。";
    } else if (j.type === "generate") {
      let context = `用户指令：${payload.prompt}\n当前版本：${j.baseRevisionId || "空白场景"}\n选中对象 ID：${payload.objectId || "无"}\n参考图片（按顺序）：${JSON.stringify(payload.attachmentIds || [])}\n最新场景：${JSON.stringify(j.baseRevisionId ? revision(j.baseRevisionId).scene : { objects: [] })}`;
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
          (payload.attachmentIds || []).map((id: string) =>
            attachmentPath(p.id, id),
          ),
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
          if (payload.shapeRefinement) {
            update(j, { stage: "检查形体修改后的纹理拉伸" });
            const audit = await runBlender(
              dir,
              [
                "--python",
                path.join(ROOT, "blender/texture_audit.py"),
                "--",
                dir,
                payload.objectId,
              ],
              signal,
            );
            fs.appendFileSync(
              path.join(dir, "execution.log"),
              audit.stdout + "\n" + audit.stderr,
            );
            if (audit.code)
              throw new Error(
                (audit.stderr + "\n" + audit.stdout).slice(-3000),
              );
            imageProvenance = {
              ...revision(j.baseRevisionId!).image3d,
              lastShapeRefinementAudit: JSON.parse(
                fs.readFileSync(path.join(dir, "texture-audit.json"), "utf8"),
              ),
              visualAcceptance: "pending",
            };
          }
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
        fs.copyFileSync(path.join(outputDirectory || dir, name), f);
        fs.chmodSync(f, 0o400);
        artifacts[key] = artifact(f, p.id, `Ai-FormaDesk-${rid}-${name}`, mime);
      }
      const r: Revision = {
        id: rid,
        projectId: p.id,
        parentId: j.baseRevisionId,
        source: j.type,
        label: ["generate", "image3d"].includes(j.type)
          ? payload.prompt
          : summary,
        createdAt: now(),
        scene: scene!,
        image3d:
          imageProvenance ||
          (j.baseRevisionId ? revision(j.baseRevisionId).image3d : undefined),
        artifacts,
      };
      put("revision", r);
      if (j.type === "accept-image3d") {
        const original = get<Job>("job", payload.candidateJobId)!;
        put("job", { ...original, resultRevisionId: rid, updatedAt: now() });
      }
      invalidateProposals(p.id);
      put("project", {
        ...project(p.id),
        currentRevisionId: rid,
        redo: [],
        updatedAt: now(),
      });
      if (payload.proposalId)
        put("proposal", {
          ...get<Proposal>("proposal", payload.proposalId)!,
          status: "succeeded",
        });
      update(j, {
        status: "succeeded",
        stage: "完成",
        resultRevisionId: rid,
        message: summary,
      });
      if (["generate", "image3d"].includes(j.type))
        addMessage(p.id, "assistant", summary);
    })();
  } catch (e) {
    // A failed quality gate must not strand a validated gray mesh in a read-only
    // preview. Adoption is a separate explicit job, with fresh scene validation.
    if (
      !signal.aborted &&
      j.type === "image3d" &&
      j.candidateArtifactId &&
      !j.candidateManifest
    ) {
      try {
        const report = JSON.parse(
          fs.readFileSync(path.join(dir, "inference/run.json"), "utf8"),
        );
        const match = /^shape-candidate-([01])\.glb$/.exec(
          report.shapePreviewFile || "",
        );
        if (match) {
          const geometryFile = `geometry-${match[1]}.blend`;
          if (fs.statSync(path.join(dir, "inference", geometryFile)).isFile()) {
            const input = preparedImage(p.id, payload.preparedImageId);
            put("image3d-candidate", {
              id: j.id,
              projectId: p.id,
              baseRevisionId: j.baseRevisionId,
              directory: dir,
              kind: "shape",
              geometryFile,
              objectId: payload.objectId,
              createdAt: now(),
              provenance: {
                route: "image3d",
                preparedImageId: input.id,
                primaryAttachmentId: input.attachmentId,
                auxiliaryAttachmentIds: (payload.attachmentIds || []).filter(
                  (id: string) => id !== input.attachmentId,
                ),
                analysis: fs.existsSync(path.join(dir, "image-analysis.json"))
                  ? JSON.parse(
                      fs.readFileSync(
                        path.join(dir, "image-analysis.json"),
                        "utf8",
                      ),
                    )
                  : undefined,
                scaleEstimated: true,
                longestSideMeters: 1,
                report,
                missingSteps: ["texture", "visual-quality"],
              },
            });
            j.candidateCanAdopt = true;
          }
        }
      } catch {
        /* Keep the original error and read-only preview when preparation is incomplete. */
      }
    }
    update(j, {
      status: signal.aborted
        ? "cancelled"
        : j.candidateArtifactId
          ? "partial"
          : "failed",
      stage: signal.aborted
        ? "已取消"
        : j.candidateArtifactId
          ? "部分完成"
          : "失败",
      error: (e as Error).message || "执行失败",
    });
    if (j.type === "generate")
      addMessage(p.id, "error", j.error!, { jobId: j.id });
    if (payload.proposalId)
      put("proposal", {
        ...get<Proposal>("proposal", payload.proposalId)!,
        status: "failed",
      });
    if (j.type === "discuss")
      put("message", {
        ...get<Message>("message", payload.replyId)!,
        text: j.error!,
        status: signal.aborted ? "cancelled" : "failed",
      });
  } finally {
    controllers.delete(j.id);
    queuedPayloads.delete(j.id);
  }
}
export function cancel(id: string) {
  const j = get<Job>("job", id);
  if (!j) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
  if (["queued", "running"].includes(j.status)) {
    controllers.get(id)?.abort();
    if (j.status === "queued") {
      const payload = queuedPayloads.get(j.id);
      update(j, { status: "cancelled", stage: "已取消", error: "任务已取消" });
      if (payload?.proposalId) {
        const proposal = get<Proposal>("proposal", payload.proposalId);
        if (proposal) put("proposal", { ...proposal, status: "failed" });
      }
      if (payload?.replyId) {
        const message = get<Message>("message", payload.replyId);
        if (message)
          put("message", {
            ...message,
            status: "cancelled",
            text: "任务已取消",
          });
      } else if (j.type === "generate")
        addMessage(j.projectId, "error", "任务已取消", { jobId: j.id });
    }
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
  invalidateProposals(pid);
  put("project", { ...p, currentRevisionId: next, redo, updatedAt: now() });
  return project(pid);
}
