import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { ROOT, limits } from "./config";
import { runBlender } from "./sandbox";
import { createVisualScope, type ImageReceipt } from "./visual-ai";
import {
  subjectSchema,
  surfaceSchema,
  viewNames,
  referenceViews,
  viewLabels,
  type VisualJobState,
  type VisualReview,
} from "../src/visualTypes";
import type { Scene } from "../src/types";

type PipelineOptions = {
  runId: string;
  root: string;
  prompt: string;
  images: string[];
  baseFile?: string;
  baseScene: Scene;
  objectId?: string | null;
  signal: AbortSignal;
  restartFailedPhase?: boolean;
  onState: (state: VisualJobState) => void;
  onStage: (stage: string) => void;
  register: (file: string, label: string, mime: string) => string;
  generate: (
    prompt: string,
    images: string[],
  ) => Promise<{ python: string; summary: string }>;
  execute: (dir: string) => Promise<Scene>;
  validate: (dir: string) => Promise<Scene>;
};
type DiskState = {
  version?: 2;
  referenceViewNames?: string[];
  fingerprint: string;
  visible: VisualJobState;
  subject?: z.infer<typeof subjectSchema>;
  views?: string[];
  viewsApproved?: boolean;
  shapeDir?: string;
  shapeApproved?: boolean;
  targets?: string[];
  appearanceDir?: string;
  complete?: boolean;
  rounds?: Record<string, number>;
  repairs?: Record<string, string>;
  shapeDraft?: {
    dir: string;
    round: number;
    executed?: boolean;
    rendered?: boolean;
  };
  referenceDraft?: { dir: string; round: number };
  surfaceDraft?: {
    dir: string;
    round: number;
    plan?: z.infer<typeof surfaceSchema>;
    applied?: boolean;
    validated?: boolean;
    rendered?: boolean;
    portable?: boolean;
  };
  artifactFiles?: string[];
  lastSurface?: z.infer<typeof surfaceSchema>;
};
export function assertReview(review: VisualReview, shapeOnly: boolean) {
  if (
    shapeOnly &&
    (review.textureIssues.length || review.lightingIssues.length)
  )
    throw new Error("形状检查混入了材质或灯光问题，拒绝该检查结果");
  return (
    review.acceptable &&
    !review.shapeIssues.length &&
    !review.textureIssues.length &&
    !review.lightingIssues.length
  );
}
export function targetIds(scene: Scene, base: Scene, selected?: string | null) {
  const old = new Set(base.objects.map((o) => o.id));
  const allowed = new Set(selected ? [selected] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of base.objects)
      if (o.parentId && allowed.has(o.parentId) && !allowed.has(o.id)) {
        allowed.add(o.id);
        changed = true;
      }
  }
  return {
    allowed: [...allowed],
    targets: scene.objects
      .filter((o) => o.type === "MESH" && (!old.has(o.id) || allowed.has(o.id)))
      .map((o) => o.id),
  };
}

export async function runVisualPipeline(o: PipelineOptions) {
  const scope = createVisualScope();
  try { return await runSinglePass(o, scope.request); }
  finally { await scope.close(); }
}
async function runSinglePass(o: PipelineOptions, visualRequest: ReturnType<typeof createVisualScope>["request"]): Promise<{
  dir: string;
  scene: Scene;
  summary: string;
  state: VisualJobState;
}> {
  fs.mkdirSync(o.root, { recursive: true });
  const stateFile = path.join(o.root, "pipeline.json");
  const hash = createHash("sha256")
    .update(o.prompt)
    .update(JSON.stringify(o.baseScene))
    .update(o.objectId || "");
  for (const image of o.images) hash.update(fs.readFileSync(image));
  const fingerprint = hash.digest("hex");
  let state: DiskState = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
    : {
        fingerprint,
        visible: {
          runId: o.runId,
          phase: "开始",
          assumptions: [],
          evidence: [],
          reviews: [],
        },
      };
  if (state.fingerprint !== fingerprint)
    throw new Error("参考或场景已变化，不能复用旧候选任务");
  // Old reports remain historical evidence; they never gate a resumed job.
  const names = state.referenceViewNames || (state.views?.length === 3 ? [...viewNames] : referenceViews(o.prompt));
  state.version = 2;
  state.referenceViewNames = names;
  state.visible.pipelineVersion = 2;
  state.visible.referenceViews = names;
  state.visible.steps ||= [];
  const save = () => {
    fs.writeFileSync(stateFile + ".tmp", JSON.stringify(state, null, 2));
    fs.renameSync(stateFile + ".tmp", stateFile);
    o.onState(structuredClone(state.visible));
  };
  const stage = (label: string) => {
    if (o.signal.aborted) throw new Error("任务已取消");
    state.visible.phase = label;
    save();
    o.onStage(label);
  };
  const evidence = (
    file: string,
    label: string,
    kind: "image" | "report" | "model" = "image",
  ) => {
    if (state.artifactFiles?.includes(file)) return;
    const artifactId = o.register(
      file,
      label,
      kind === "image"
        ? "image/png"
        : kind === "model"
          ? "model/gltf-binary"
          : "application/json",
    );
    state.visible.evidence.push({ artifactId, label, kind });
    save();
    state.artifactFiles = [...(state.artifactFiles || []), file];
    save();
  };
  const json = async <T>(
    schema: z.ZodType<T>,
    prompt: string,
    images: string[],
  ): Promise<T> =>
    schema.parse(
      await visualRequest({
        cwd: o.root,
        prompt,
        images,
        signal: o.signal,
        schema: z.toJSONSchema(schema),
        onActivity: message => { state.visible.lastActivityAt = new Date().toISOString(); state.visible.activity = message; save(); },
      }),
    );
  const image = async (file: string, prompt: string, inputs: string[]) => {
    // Cached files have a receipt only after native image output was fully decoded.
    const receiptFile = file + ".receipt.json";
    if (fs.existsSync(file) && fs.existsSync(receiptFile)) {
      await sharp(file, { failOn: "warning" }).raw().toBuffer();
      return;
    }
    const receipt = await visualRequest<ImageReceipt>({
      cwd: o.root,
      prompt:
        "必须调用原生图像生成工具输出真实图片，不能用代码、SVG或文字代替。\n" +
        prompt,
      images: inputs,
      signal: o.signal,
      imageOutput: file,
      onActivity: message => { state.visible.lastActivityAt = new Date().toISOString(); state.visible.activity = message; save(); },
    });
    fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2));
  };
  const trusted = async (
    dir: string,
    mode: string,
    config: object,
    rendering = false,
  ) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "visual.json"), JSON.stringify(config));
    const result = await runBlender(
      dir,
      ["--python", path.join(ROOT, "blender/visual.py"), "--", mode, dir],
      o.signal,
      rendering ? Math.max(limits().renderingMs, 300000) : limits().modelingMs,
      rendering,
    );
    fs.appendFileSync(
      path.join(dir, "execution.log"),
      result.stdout + "\n" + result.stderr,
    );
    if (result.code !== 0)
      throw new Error(
        `Blender ${mode} 失败：${(result.stderr + result.stdout).slice(-3500)}`,
      );
  };
  const timed = async <T>(id: string, label: string, fn: () => Promise<T>): Promise<T> => {
    if (o.signal.aborted) throw new Error("任务已取消");
    const step = { id, label, startedAt: new Date().toISOString(), status: "running" as "running" | "succeeded" | "failed", endedAt: undefined as string | undefined };
    state.visible.steps!.push(step);
    stage(label);
    try { const value = await fn(); step.status = "succeeded"; return value; }
    catch (error) { step.status = "failed"; throw error; }
    finally { step.endedAt = new Date().toISOString(); save(); }
  };
  for (const [i, source] of o.images.entries()) {
    const original = path.join(o.root, `original-${i + 1}.png`);
    if (!fs.existsSync(original)) fs.copyFileSync(source, original);
    evidence(original, `原图 ${i + 1}`);
  }
  if (!state.subject) {
    stage("识别建模主体");
    state.subject = await timed("subject", "识别建模主体", () => json(
      subjectSchema,
      `用户要求：${o.prompt}\n识别需要建模的主体。多个候选物体且指令没指定时 clear=false，question 提出一个简短问题；单主体则自动确认。列出部件、比例、材质、不可见结构的假设。只记录原图支持的事实。`,
      o.images,
    ));
    save();
  }
  if (!state.subject.clear)
    throw new Error(state.subject.question || "请指定图片中需要建模的物体");
  state.visible.assumptions = state.subject.assumptions;
  save();
  const subject = JSON.stringify(state.subject);
  if (!state.views || !state.views.every(file => fs.existsSync(file))) {
    const dir = state.referenceDraft?.dir || path.join(o.root, "references-single");
    fs.mkdirSync(dir, { recursive: true });
    state.referenceDraft = { dir, round: 0 };
    save();
    const views = names.map(name => path.join(dir, name + ".png"));
    const make = async (index: number) => {
      const name = names[index];
      await timed(`reference-${name}`, `生成三视图 · ${viewLabels[name] || name}`, () => image(
        views[index],
        `生成该主体的${viewLabels[name] || name}正交参考图，单张仅含一个视角。原图是事实；最后附带的正面参考只辅助保持同一造型。主体约束：${subject}。正面看向 +Y，右侧看向 -X，背面看向 -Y，顶部看向 -Z。保持部件数量、轮廓比例和姿态，完整居中、白背景、无文字、无透视。隐藏结构保守补全。`,
        index ? [...o.images, views[0]] : o.images,
      ));
      evidence(views[index], `${viewLabels[name] || name}参考图 · 单轮`);
    };
    await make(0);
    // Await both workers even on failure, so no late writes escape this job.
    const results = await Promise.allSettled([make(1), make(2)]);
    const failure = results.find(r => r.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    state.views = views;
    delete state.referenceDraft;
    save();
  }
  const refs = [...o.images, ...state.views!];
  const baselineDir = path.join(o.root, "baseline");
  if (o.baseFile && !fs.existsSync(path.join(baselineDir, "snapshot.json"))) {
    fs.mkdirSync(baselineDir, { recursive: true });
    fs.copyFileSync(o.baseFile, path.join(baselineDir, "scene.blend"));
    await trusted(baselineDir, "snapshot", {});
  }
  if (!state.shapeDir) {
    const repair = "";
    const round = 0;
    {
      stage("生成形状脚本");
      const dir =
        state.shapeDraft?.dir || path.join(o.root, `shape-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      state.shapeDraft = { ...state.shapeDraft, dir, round };
      save();
      if (o.baseFile) fs.copyFileSync(o.baseFile, path.join(dir, "base.blend"));
      const prompt = `根据原图和三视图建模。前 ${o.images.length} 张为原图，后三张依次为 ${names.map(n => viewLabels[n] || n).join("、")}参考。原图可见事实优先于生成图。\n用户要求：${o.prompt}\n主体：${subject}\n当前场景：${JSON.stringify(o.baseScene)}\n选中对象：${o.objectId || "无；仅允许新增，不修改已有对象"}。仅建立主体几何，禁止创建地板、背景、灯光、相机。部件独立命名，几何中心在原点附近，正面朝 -Y。纯色基础材质即可，外观由后续独立处理。不要将印花、色带或图案做成独立几何，它们属于材质阶段；只建立有真实体积的部件。保留所有无关已有对象。\n${repair}`;
      if (!fs.existsSync(path.join(dir, "generated.py"))) {
        const generated = await timed("script", "生成形状脚本", () => o.generate(prompt, refs));
        fs.writeFileSync(path.join(dir, "generated.py"), generated.python);
      }
      const scene: Scene = state.shapeDraft.executed
        ? JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"))
        : await timed("model", "Blender 执行建模", () => o.execute(dir));
      state.shapeDraft.executed = true;
      save();
      const ids = targetIds(scene, o.baseScene, o.objectId);
      const originalIds = new Set(o.baseScene.objects.map((obj) => obj.id));
      if (
        scene.objects.some(
          (obj) =>
            !originalIds.has(obj.id) && ["LIGHT", "CAMERA"].includes(obj.type),
        )
      )
        throw new Error("形状脚本创建了额外灯光或相机，拒绝该候选");
      if (!ids.targets.length) throw new Error("没有找到新增或选中的网格主体");
      if (o.baseFile) {
        fs.copyFileSync(
          path.join(baselineDir, "snapshot.json"),
          path.join(dir, "snapshot.json"),
        );
        await trusted(dir, "preserve", { allowed: ids.allowed });
      }
      state.shapeDir = dir;
      state.targets = ids.targets;
      save();
      evidence(
        path.join(dir, "scene.glb"),
        `形状候选 · 第 ${round + 1} 轮`,
        "model",
      );
      delete state.shapeDraft;
      save();
    }
  }
  if (!state.complete) {
    const shapeDir = state.shapeDir!;
    const shapeScene: Scene = JSON.parse(
      fs.readFileSync(path.join(shapeDir, "scene.json"), "utf8"),
    );
    const repair = "";
    const round = 0;
    {
      stage("规划材质与花纹");
      const dir =
        state.surfaceDraft?.dir ||
        path.join(o.root, `appearance-${Date.now()}`);
      fs.mkdirSync(dir, { recursive: true });
      state.surfaceDraft = { ...state.surfaceDraft, dir, round };
      save();
      if (!state.surfaceDraft.applied)
        fs.copyFileSync(
          path.join(shapeDir, "scene.blend"),
          path.join(dir, "scene.blend"),
        );
      fs.copyFileSync(
        path.join(shapeDir, "generated.py"),
        path.join(dir, "generated.py"),
      );
      const targets = shapeScene.objects.filter((obj) =>
        state.targets!.includes(obj.id),
      );
      const surface =
        state.surfaceDraft.plan ||
        (await timed("material-plan", "规划材质与花纹", () => json(
          surfaceSchema,
          `为已生成的主体制定一次材质计划，所有目标网格各出现一次，只能使用提供的真实 id。solid=纯色/塑料/金属，wood=规则木纹，fabric=布纹，image=独特图案、文字、色块或需要图片纹理。材质应还原原图，不能用好看代替相似。image 的 color 是不可见部分使用的基础底色，贴图直接连接 Base Color，不会乘以该颜色；不要为避免重复染色而将底色设为白色。lighting 默认 viewTransform=Standard、exposure=0、worldStrength=0.25、key=fill=rim=1；高光过曝时可选 AgX 压缩高光，网页和 Blender 会共同采用。保持中性自然，使用一次材质规划，不进行视觉评分或自动返工。\n主体：${subject}\n目标：${JSON.stringify(targets)}\n当前已有方案：${JSON.stringify(state.lastSurface || null)}。\n${repair}`,
          o.images,
        )));
      if (
        surface.objects.length !== targets.length ||
        new Set(surface.objects.map((v) => v.id)).size !== targets.length ||
        surface.objects.some((v) => !state.targets!.includes(v.id))
      )
        throw new Error("材质计划没有完整且唯一地覆盖目标网格");
      state.surfaceDraft.plan = surface;
      state.lastSurface = surface;
      const planFile = path.join(dir, "surface-plan.json");
      fs.writeFileSync(planFile, JSON.stringify(surface, null, 2));
      evidence(planFile, `材质与灯光方案 · 第 ${round + 1} 轮`, "report");
      save();
      let textureViews: Record<string, any> = {};
      if (surface.objects.some((v) => v.kind === "image")) {
        if (!fs.existsSync(path.join(shapeDir, "views.json")))
          await timed("projection", "准备纹理投影视图", () => trusted(shapeDir, "render", { targets: state.targets, shape: true }, true));
        textureViews = JSON.parse(
          fs.readFileSync(path.join(shapeDir, "views.json"), "utf8"),
        );
        for (const [i, name] of viewNames.entries()) {
          stage(`制作图片纹理 · ${["正面", "右侧", "顶部"][i]}`);
          const output = path.join(dir, `texture-${name}.png`);
          await timed(`texture-${name}`, `制作图片纹理 · ${viewLabels[name]}`, () => image(
            output,
            `第一张是已经确定几何的${name}正交渲染，后续是原始参考和已生成三视图，最后 ${i} 张是本轮已完成的其他视角纹理。各视角图案对应的物体高度、宽度和部件位置必须一致。只给第一张主体补上匹配原图的颜色、图案和纹理，严格保持第一张的轮廓、位置、留白和部件边界，禁止改变几何或构图。生成可投影的平光基础颜色图，白背景，去除高光、投影和环境明暗，不画新装饰。原图文字若无法准确复现不能自创文字。\n材质计划：${JSON.stringify(surface)}\n${repair}`,
            [
              path.join(shapeDir, name + ".png"),
              ...refs,
              ...viewNames
                .slice(0, i)
                .map((v) => path.join(dir, `texture-${v}.png`)),
            ],
          ));
          // Projection is normalized; square output is required, never stretch a changed aspect.
          const meta = await sharp(output).metadata();
          if (meta.width !== meta.height)
            throw new Error("纹理生成改变了参考图宽高比，拒绝拉伸贴图");
          textureViews[name].image = path.basename(output);
          evidence(output, `${name} 表面纹理 · 第 ${round + 1} 轮`);
        }
      }
      stage("应用材质与自然布光");
      if (!state.surfaceDraft.applied)
        await timed("surface", "应用材质与自然布光", () => trusted(dir, "surface", {
          targets: state.targets,
          surface,
          views: textureViews,
        }));
      state.surfaceDraft.applied = true;
      save();
      stage("烘焙贴图与验证导出");
      if (!state.surfaceDraft.validated) await timed("export", "烘焙贴图与验证导出", () => o.validate(dir));
      state.surfaceDraft.validated = true;
      state.appearanceDir = dir;
      save();
      evidence(
        path.join(dir, "scene.glb"),
        `外观候选 · 第 ${round + 1} 轮`,
        "model",
      );
      const textures = path.join(dir, "textures");
      if (fs.existsSync(textures))
        for (const name of fs
          .readdirSync(textures)
          .filter((n) => n.endsWith(".png")))
          evidence(path.join(textures, name), `2K 烘焙贴图 · ${name}`);
      delete state.surfaceDraft;
      state.complete = true;
      save();
    }
  }
  const dir = state.appearanceDir!;
  const scene: Scene = JSON.parse(
    fs.readFileSync(path.join(dir, "scene.json"), "utf8"),
  );
  return {
    dir,
    scene,
    state: state.visible,
    summary:
      "模型已生成，可查看效果。参考三视图只生成一轮，未进行 AI 视觉评分；未见结构属于推测。",
  };
}
