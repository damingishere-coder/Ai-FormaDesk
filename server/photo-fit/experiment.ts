import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { ROOT, MODEL, EFFORT } from "../config";
import { codex } from "../codex";
import { runBlender } from "../sandbox";
import { constraintsContract, correctionContract, numericalGate, type Constraints, type FitMetrics } from "./contracts";

type Stage = { directory: string; camera: unknown; bounds: number[][];
  objects: unknown[]; metrics: FitMetrics; geometryValid: boolean; changes: unknown[];
  anchors?: {id:string;x:number;y:number;objectId:string;center:[number,number,number]}[];
  parameters?: Record<string, { value:number; min:number; max:number; integer:boolean }>; sourceScript?: string };
export type ExperimentInput = {
  output: string; reference: string; blend?: string; prompt: string;
  strategy: "mesh" | "script"; budgetMs?: number;
};
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
// Capture loaded adapter sources once, rather than hashing edited disk files
// halfway through a long batch and attributing them to already-loaded modules.
const loadedCodeHashes = Object.fromEntries(["server/codex.ts", "server/sandbox.ts", "server/photo-fit/experiment.ts", "server/photo-fit/contracts.ts"]
  .map(file => [file, hash(path.join(ROOT, file))]));
const write = (file: string, value: unknown) => {
  fs.writeFileSync(file+".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file+".tmp", file);
};

/** Stage A experiment: isolated artifacts only. Never adopts or edits a project. */
export async function runPhotoFitExperiment(input: ExperimentInput, signal: AbortSignal) {
  const directory = path.resolve(input.output);
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  let remaining = Math.min(input.budgetMs ?? 1_800_000, 1_800_000);
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("处理预算必须为正数");
  const allowance = remaining, started = performance.now();
  let queueMs = 0;
  const refreshBudget = () => { remaining = allowance-(performance.now()-started-queueMs); };
  const id = randomUUID();
  const record: any = { schemaVersion: 2, id, route: "photoFit", status: "running", startedAt: new Date().toISOString(),
    model: MODEL, effort: EFFORT, strategy: input.strategy, budgetMs: remaining,
    sourceHash: hash(input.reference), sourceBlendHash: input.blend ? hash(input.blend) : null,
    corrections: [], acceptedCategories: [], visualAcceptance: "pending", stages: [] };
  record.codeHashes = { ...loadedCodeHashes, ...Object.fromEntries(["blender/photo_fit_worker.py", "blender/photo_fit_geometry.py", "scripts/image3d/resource_exec.py"].map(file => [file, hash(path.join(ROOT, file))])) };
  const persist = () => write(path.join(directory, "experiment.json"), { ...record, remainingMs: remaining });
  const ensure = () => { refreshBudget(); signal.throwIfAborted(); if (remaining <= 0) throw new Error("达到 30 分钟执行预算，保留已验证候选"); };
  const ai = async <T>(name: string, fn: (s: AbortSignal) => Promise<T>): Promise<T> => {
    ensure(); record.stage = name; persist(); console.log(name);
    const start = performance.now();
    try { return await fn(AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(remaining)))])); }
    finally { const elapsedMs = performance.now()-start; refreshBudget(); record.stages.push({ name, elapsedMs }); persist(); }
  };
  const blender = async (name: string, dir: string, mode: string) => {
    ensure(); record.stage = name; persist(); console.log(name);
    const start = performance.now();
    const result = await runBlender(dir, ["--python", path.join(ROOT, "blender/photo_fit_worker.py"), "--", mode, dir], signal,
      Math.max(1, Math.floor(remaining)), mode !== "script", { maxFootprintMb: 12288 });
    queueMs += Math.max(0, performance.now()-start-result.executionMs);
    refreshBudget();
    record.stages.push({ name, elapsedMs: result.executionMs });
    fs.writeFileSync(path.join(dir, "execution.log"), result.stdout+"\n"+result.stderr);
    persist();
    if (result.code !== 0) throw new Error(`Blender ${name}: ${(result.stderr+result.stdout).slice(-2400)}`);
  };
  let best: Stage | undefined;
  try {
    const disk = fs.statfsSync(directory);
    if (disk.bavail*disk.bsize < 10*1024**3) throw new Error("工作盘剩余不足 10 GiB，未启动建模");
    // Keep source immutable and record the exact resize mapping for future UI edits.
    const metadata = await sharp(input.reference).metadata();
    if (!metadata.hasAlpha) throw new Error("阶段 A 要求透明主体图，不能把整张背景当作蒙版");
    const square = await sharp(input.reference).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    fs.writeFileSync(path.join(directory, "reference.png"), square);
    await sharp(square).resize(128, 128).png().toFile(path.join(directory, "reference-128.png"));
    record.inputMapping = { sourceWidth: metadata.width, sourceHeight: metadata.height, fit: "contain", width: 512, height: 512 };
    const constraints: Constraints = await ai("分析照片结构与可见约束", s => codex.structured(id, input.prompt, s,
      [path.join(directory, "reference.png")], constraintsContract));
    write(path.join(directory, "constraints.json"), { ...constraints, sourceHash: record.sourceHash, revision: 1 });
    const stage = async (name: string, source: string, request: object, mode: "inspect" | "correct", beforeFront?: string) => {
      const dir = path.join(directory, name);
      fs.mkdirSync(dir);
      fs.copyFileSync(source, path.join(dir, "input.blend"));
      if (beforeFront) fs.copyFileSync(beforeFront, path.join(dir, "before-front.png"));
      for (const file of ["reference.png", "reference-128.png"]) fs.copyFileSync(path.join(directory, file), path.join(dir, file));
      write(path.join(dir, "request.json"), { constraints, ...request });
      await blender(name, dir, mode);
      const result = JSON.parse(fs.readFileSync(path.join(dir, "report.json"), "utf8"));
      if (!result.geometryValid || !Number.isFinite(result.metrics.silhouetteError)) throw new Error("候选测量无效");
      const labels=(result.anchors ?? []).map((a:any)=>`<circle cx="${a.x*512}" cy="${a.y*512}" r="2" fill="#ffd43b"/><text x="${a.x*512+3}" y="${a.y*512-3}" fill="#ffd43b" stroke="#111" stroke-width="2" paint-order="stroke" font-size="11">${a.id}</text>`).join("");
      await sharp(path.join(dir,"front.png")).composite([{input:Buffer.from(`<svg width="512" height="512">${labels}</svg>`)}]).png().toFile(path.join(dir,"anchors.png"));
      return { ...result, directory: dir } as Stage;
    };
    let source = input.blend;
    if (input.strategy === "script") {
      const generated = await ai("生成可参数化灰模脚本", s => codex.generate(id, null,
        `${input.prompt}\n照片约束：${JSON.stringify(constraints)}\n只建照片主体灰模，Z向上，面向-Y，最长边约1米。所有主要尺寸集中在顶层PARAMS字典，字典值必须为数字字面量，不用表达式/函数/嵌套字典。对象用确定的部件名称。避免随机噪声和装饰。不要创建相机灯光。可调用已注入的 fit.loft(name, sections:等长3D截面环), fit.sweep(name, points, radius), fit.repeat(obj,count,offset), fit.leaf(name,length,width,bend), fit.boolean(obj,cutter,operation)；布尔后必须删除辅助cutter。规则部件可以使用bpy。脚本只建几何，暂不处理纹理。`,
        s, () => {}, () => {}, [path.join(directory, "reference.png")]));
      const dir = path.join(directory, "script"); fs.mkdirSync(dir);
      write(path.join(dir, "request.json"), {});
      fs.writeFileSync(path.join(dir, "generated.py"), generated.python);
      write(path.join(dir, "intent.json"), { summary: generated.summary });
      await blender("执行初始脚本", dir, "script");
      source = path.join(dir, "input.blend");
    }
    if (!source) throw new Error("网格路线需要底模");
    best = await stage("initial", source, {}, "inspect");
    if (input.strategy === "script") {
      best.sourceScript = path.join(directory, "script/effective.py");
      best.parameters = JSON.parse(fs.readFileSync(path.join(directory, "script/parameters.json"), "utf8"));
    }
    record.initial = best; record.best = best; persist();
    for (let round = 1; round <= 2; round++) {
      ensure();
      const baseline = best;
      const proposal = await ai(`第 ${round} 轮：诊断局部形体差异`, s => codex.structured(id,
        `${input.prompt}\n冻结包围盒（世界坐标Z向上）：${JSON.stringify(baseline.bounds)}\n对象：${JSON.stringify(baseline.objects)}\n可编辑parameters：${JSON.stringify(baseline.parameters ?? {})}\n当前视角光线投射获得的可见表面anchors：${JSON.stringify(baseline.anchors ?? [])}\n约束：${JSON.stringify(constraints)}\n指标：${JSON.stringify(baseline.metrics)}\n差异图绿色是照片有而模型缺少的区域，红色是模型多出的区域。不要只追求轮廓分数，保留所有正确的结构。`, s,
        [path.join(directory, "reference.png"), ...["anchors", "difference", "left", "right", "back"].map(n => path.join(baseline.directory, n+".png"))], correctionContract));
      for (const operation of proposal.operations) {
        const anchor=baseline.anchors?.find(a=>a.id===operation.anchorId);
        if (!anchor) throw new Error("局部操作未指定有效可见表面锚点");
        operation.objectId=anchor.objectId;operation.center=anchor.center;
      }
      const roundRecord: any = { round, proposal, trials: [], accepted: false };
      record.corrections.push(roundRecord); persist();
      if (!proposal.operations.length && !proposal.parameters.length) { roundRecord.reason = "无法安全局部修复，保留候选"; break; }
      const sourceIds = new Set((baseline.objects as any[]).map(o => o.objectId));
      if (proposal.operations.some(o => !sourceIds.has(o.objectId))) throw new Error("修正指定了不存在的对象");
      // Bounded line search: both candidates start from the same immutable parent.
      let candidate: Stage | undefined;
      for (const strength of [.5, 1]) {
        let trial: Stage;
        if (proposal.parameters.length) {
          if (!baseline.sourceScript || !baseline.parameters) throw new Error("当前候选没有可重建的参数来源");
          const parameters: Record<string, number> = {};
          for (const item of proposal.parameters) {
            const parameter = baseline.parameters[item.name];
            if (!parameter || item.value < parameter.min || item.value > parameter.max) throw new Error("参数调整超出声明范围");
            const interpolated = parameter.value+(item.value-parameter.value)*strength;
            parameters[item.name] = parameter.integer ? Math.round(interpolated) : interpolated;
          }
          const scriptDir = path.join(directory, `parameter-${round}-${strength}`); fs.mkdirSync(scriptDir);
          fs.copyFileSync(baseline.sourceScript, path.join(scriptDir, "generated.py"));
          write(path.join(scriptDir, "request.json"), { parameters,
            identities: Object.fromEntries((baseline.objects as any[]).map(o => [o.name, o.objectId])) });
          await blender(`有界参数搜索 ${round}/${strength}`, scriptDir, "script");
          trial = await stage(`round-${round}-${strength}`, path.join(scriptDir, "input.blend"),
            { camera: baseline.camera, bounds: baseline.bounds }, "inspect");
          trial.parameters = JSON.parse(fs.readFileSync(path.join(scriptDir, "parameters.json"), "utf8"));
          trial.sourceScript = path.join(scriptDir, "effective.py");
        } else {
          trial = await stage(`round-${round}-${strength}`, path.join(baseline.directory, "candidate.blend"),
            { operations: proposal.operations, strength, camera: baseline.camera, bounds: baseline.bounds }, "correct", path.join(baseline.directory, "front.png"));
        }
        const target = (trial as any).targetRegion;
        const numerical = numericalGate({ ...baseline.metrics, targetRegionError: target?.before ?? null }, trial.metrics);
        roundRecord.trials.push({ ...trial, strength, numerical }); persist();
        if (numerical && (!candidate || trial.metrics.silhouetteError < candidate.metrics.silhouetteError)) candidate = trial;
      }
      if (!candidate) { roundRecord.reason = "数值目标未改善，保留原候选"; persist(); continue; }
      const visual = await ai(`第 ${round} 轮：固定相机前后视觉复核`, s => codex.reviewImage(id,
        `这是形体阶段，仅检查轮廓、比例、部件数量、明显粘连。textureIssues必须为空。第1张参考照，2..5为修正后，6..9为修正前。严格比较是否改善了这些问题：${JSON.stringify(proposal)}。acceptable按整体质量判断；regressed专门记录是否有任何关键几何特征退化。`,
        s, [path.join(directory, "reference.png"), ...[candidate!, baseline].flatMap(v => ["front", "left", "right", "back"].map(n => path.join(v.directory, n+".png")))]));
      roundRecord.visual = visual;
      if (!visual.regressed && visual.textureIssues.length === 0) {
        best = candidate; roundRecord.accepted = true;
        record.best = best;
        record.visualAcceptance = visual.acceptable ? "model-review-passed-awaiting-user" : "still-experimental";
      } else roundRecord.reason = "视觉检查出现退化或检查范围错误，保留原候选";
      persist();
    }
    record.status = "partial";
    record.mechanismImproved = best.metrics.silhouetteError <= record.initial.metrics.silhouetteError+.002 && record.corrections.some((r: any) => r.accepted);
    record.stage = "阶段 A 完成；形体候选未写入作品";
  } catch (error) {
    record.status = signal.aborted ? "cancelled" : best ? "partial" : "failed";
    record.error = error instanceof Error ? error.message : String(error);
    record.best = best;
  } finally {
    refreshBudget(); record.queueExcludedMs = queueMs;
    record.completedAt = new Date().toISOString(); persist();
  }
  return record;
}
