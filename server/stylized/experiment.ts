import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { ROOT, MODEL, EFFORT } from "../config";
import { codex } from "../codex";
import { runBlender } from "../sandbox";
import {
  style,
  featureContract,
  scriptContract,
  proposalContract,
  reviewContract,
  paletteContract,
  validateReview,
  canAccept,
  finalPassed,
  changedObjects,
  featuresSchema,
  type Features,
} from "./contracts";
const hash = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const codeHashes = Object.fromEntries(
  [
    "server/stylized/experiment.ts",
    "server/stylized/contracts.ts",
    "blender/stylized_geometry.py",
    "blender/photo_fit_worker.py",
    "server/sandbox.ts",
    "server/codex.ts",
  ].map((f) => [f, hash(path.join(ROOT, f))]),
);
const write = (p: string, v: unknown) => {
  fs.writeFileSync(p + ".tmp", JSON.stringify(v, null, 2), { mode: 0o600 });
  fs.renameSync(p + ".tmp", p);
};
const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
export type StylizedInput = {
  output: string;
  reference: string;
  prompt: string;
  budgetMs?: number;
  featuresFile?: string;
};
/** Isolated Stage A. No official revisions or public API are written before user acceptance. */
export async function runStylizedExperiment(
  input: StylizedInput,
  signal: AbortSignal,
) {
  const dir = path.resolve(input.output);
  fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
  const id = randomUUID(),
    budget = Math.min(input.budgetMs ?? 1800000, 1800000),
    started = performance.now();
  if (!Number.isFinite(budget) || budget <= 0) throw new Error("预算无效");
  let queue = 0;
  const remaining = () => budget - (performance.now() - started - queue);
  const record: any = {
    id,
    route: "stylized",
    schemaVersion: 1,
    status: "running",
    model: MODEL,
    effort: EFFORT,
    style,
    codeHashes,
    startedAt: new Date().toISOString(),
    budgetMs: budget,
    sourceHash: hash(input.reference),
    corrections: [],
    stages: [],
    acceptedCategories: [],
    userAcceptance: "pending",
  };
  const persist = () =>
    write(path.join(dir, "experiment.json"), {
      ...record,
      remainingMs: remaining(),
      queueExcludedMs: queue,
    });
  const ensure = () => {
    signal.throwIfAborted();
    if (remaining() <= 0) throw new Error("达到有效执行预算，保留已验证候选");
  };
  const ai = async <T>(name: string, fn: (s: AbortSignal) => Promise<T>) => {
    ensure();
    record.stage = name;
    persist();
    console.log(name);
    const t = performance.now();
    try {
      return await fn(
        AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.floor(remaining()))),
        ]),
      );
    } finally {
      record.stages.push({ name, elapsedMs: performance.now() - t });
      persist();
    }
  };
  const blender = async (name: string, folder: string, mode: string) => {
    ensure();
    record.stage = name;
    persist();
    console.log(name);
    const t = performance.now();
    const workerHashes = Object.fromEntries(
      [
        "blender/photo_fit_worker.py",
        "blender/stylized_geometry.py",
        "blender/photo_fit_geometry.py",
      ].map((f) => [f, hash(path.join(ROOT, f))]),
    );
    write(path.join(folder, "worker-sources.json"), workerHashes);
    const r = await runBlender(
      folder,
      [
        "--python",
        path.join(ROOT, "blender/photo_fit_worker.py"),
        "--",
        mode,
        folder,
      ],
      signal,
      Math.max(1, Math.floor(remaining())),
      mode !== "script",
      { maxFootprintMb: 12288 },
    );
    queue += Math.max(0, performance.now() - t - r.executionMs);
    record.stages.push({ name, elapsedMs: r.executionMs });
    fs.writeFileSync(
      path.join(folder, "execution.log"),
      r.stdout + "\n" + r.stderr,
    );
    persist();
    if (r.code !== 0)
      throw new Error(`Blender ${name}: ${(r.stderr + r.stdout).slice(-1800)}`);
  };
  let best: any;
  try {
    const disk = fs.statfsSync(dir);
    if (disk.bavail * disk.bsize < 10 * 1024 ** 3)
      throw new Error("可用工作空间不足10GiB");
    const meta = await sharp(input.reference).metadata();
    if (!meta.hasAlpha) throw new Error("需要透明主体PNG");
    const ref = path.join(dir, "reference.png");
    await sharp(input.reference)
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(ref);
    await sharp(ref)
      .resize(128, 128)
      .png()
      .toFile(path.join(dir, "reference-128.png"));
    let features: Features;
    if (input.featuresFile) {
      const { sourceHash, revision, ...value } = read(input.featuresFile);
      if (sourceHash !== record.sourceHash)
        throw new Error("复用特征不属于同一原图");
      features = featuresSchema.parse(value);
      record.featureSource = hash(input.featuresFile);
    } else
      features = await ai("提取核心特征与简化清单", (s) =>
        codex.structured(id, input.prompt, s, [ref], featureContract),
      );
    if (
      new Set(features.preserve.map((f) => f.id)).size !==
      features.preserve.length
    )
      throw new Error("核心特征ID重复");
    write(path.join(dir, "features.json"), {
      ...features,
      revision: 1,
      sourceHash: record.sourceHash,
    });
    record.features = features;
    persist();
    const script = await ai("生成圆润简化的参数化灰模", (s) =>
      codex.structured(
        id,
        `${input.prompt}\n风格：${JSON.stringify(style)}\n照片分析：${JSON.stringify(features)}\n仅几何，之后后台上色。`,
        s,
        [ref],
        {
          ...scriptContract,
          timeoutMs: Math.min(remaining(), 15 * 60000),
          instructions:
            scriptContract.instructions +
            "\n输出简洁脚本，优先12至20个有意义参数，控制在约150行内。直接调用受信任函数，不重复实现网格生成、检查或材质框架。",
        },
      ),
    );
    const scriptDir = path.join(dir, "script");
    fs.mkdirSync(scriptDir);
    fs.writeFileSync(path.join(scriptDir, "generated.py"), script.python);
    write(path.join(scriptDir, "request.json"), { stylized: true });
    await blender("执行参数化灰模", scriptDir, "script");
    const inspect = async (
      name: string,
      source: string,
      request: any = {},
      mode = "inspect",
    ) => {
      const d = path.join(dir, name);
      fs.mkdirSync(d);
      fs.copyFileSync(source, path.join(d, "input.blend"));
      for (const f of ["reference.png", "reference-128.png"])
        fs.copyFileSync(path.join(dir, f), path.join(d, f));
      write(path.join(d, "request.json"), { constraints: {}, ...request });
      await blender(name, d, mode);
      const report = read(path.join(d, "report.json"));
      if (
        !report.geometryValid ||
        !Number.isFinite(report.metrics.silhouetteError)
      )
        throw new Error("候选文件或测量无效");
      return { ...report, directory: d };
    };
    best = await inspect("initial", path.join(scriptDir, "input.blend"));
    best.parameters = read(path.join(scriptDir, "parameters.json"));
    best.sourceScript = path.join(scriptDir, "effective.py");
    const frozen = best.parameters;
    record.initial = best;
    record.best = best;
    persist();
    const views = (v: any, color = false) =>
      ["front", "left", "right", "back"].map((n) =>
        path.join(v.directory, (color ? "color-" : "") + n + ".png"),
      );
    const review = async (
      name: string,
      candidate: any,
      baseline: any | undefined,
      proposal: unknown,
      color = false,
    ) =>
      validateReview(
        features,
        await ai(name, (s) =>
          codex.structured(
            id,
            `第1张原照，接着4张候选${color ? "彩色" : "灰模"}视图${baseline ? "，最后4张基线视图" : ""}。\n特征：${JSON.stringify(features)}\n风格：${JSON.stringify(style)}\n受信任场景清单：${JSON.stringify(candidate.objects.map((o: any) => ({ name: o.name, id: o.objectId, bounds: o.bounds })))}\n可编辑参数：${JSON.stringify(candidate.parameters ?? {})}\n本轮目标：${JSON.stringify(proposal)}\n颜色阶段=${color}。部件ID和参数只能证明控制结构，不能代替视觉质量。整体检查必须诚实，不能因能导出就通过。`,
            s,
            [
              ref,
              ...views(candidate, color),
              ...(baseline ? views(baseline, color) : []),
            ],
            reviewContract,
          ),
        ),
      );
    record.initialReview = await review(
      "检查初始灰模特征与结构",
      best,
      undefined,
      {},
    );
    persist();
    for (let round = 1; round <= 2; round++) {
      ensure();
      const baseline = best;
      const proposal = await ai(`第${round}轮：选择局部形体问题`, (s) =>
        codex.structured(
          id,
          `${input.prompt}\n特征：${JSON.stringify(features)}\n参数：${JSON.stringify(best.parameters)}\n上次检查：${JSON.stringify(record.bestReview ?? record.initialReview)}\n已尝试的修正：${JSON.stringify(record.corrections.map((r: any) => ({ proposal: r.proposal, accepted: r.accepted, reason: r.reason, trialErrors: r.trials.map((t: any) => t.error).filter(Boolean) })))}\n目标是保留特征的圆润简化，不追逐轮廓IoU。若形体已适合上色无需强制修改。`,
          s,
          [ref, ...views(best)],
          proposalContract,
        ),
      );
      const rr: any = { round, proposal, accepted: false, trials: [] };
      record.corrections.push(rr);
      persist();
      if (!proposal.parameters.length) {
        rr.reason = "没有安全且必要的几何修正";
        break;
      }
      if (
        new Set(proposal.parameters.map((p) => p.name)).size !==
        proposal.parameters.length
      )
        throw new Error("重复修改参数");
      let selected: any;
      for (const strength of [0.5, 1]) {
        ensure();
        const trialRecord: any = { strength, accepted: false };
        rr.trials.push(trialRecord);
        try {
          const params: Record<string, number> = {},
            targets = new Set<string>();
          for (const item of proposal.parameters) {
            const p = baseline.parameters[item.name];
            if (!p || item.value < p.min || item.value > p.max)
              throw new Error("参数超出冻结风格范围");
            const v = p.value + (item.value - p.value) * strength;
            params[item.name] = p.integer ? Math.round(v) : v;
            p.targets.forEach((t: string) => targets.add(t));
          }
          const d = path.join(dir, `parameter-${round}-${strength}`);
          fs.mkdirSync(d);
          fs.copyFileSync(baseline.sourceScript, path.join(d, "generated.py"));
          write(path.join(d, "request.json"), {
            stylized: true,
            parameters: params,
            frozenParameters: frozen,
            identities: Object.fromEntries(
              baseline.objects.map((o: any) => [o.name, o.objectId]),
            ),
          });
          await blender(`参数候选 ${round}/${strength}`, d, "script");
          const candidate = await inspect(
            `round-${round}-${strength}`,
            path.join(d, "input.blend"),
            { camera: baseline.camera, bounds: baseline.bounds },
          );
          candidate.parameters = read(path.join(d, "parameters.json"));
          candidate.sourceScript = path.join(d, "effective.py");
          trialRecord.changedParts = changedObjects(
            baseline.objects,
            candidate.objects,
            [...targets],
          );
          Object.assign(trialRecord, candidate);
          if (!trialRecord.changedParts.length) {
            trialRecord.reason = "无实际变化";
            persist();
            continue;
          }
          const check = await review(
            `视觉复核 ${round}/${strength}`,
            candidate,
            baseline,
            proposal,
          );
          trialRecord.review = check;
          trialRecord.accepted = canAccept(check);
          // Prefer a smaller successful change. Do not rank by photo silhouette IoU.
          if (trialRecord.accepted && !selected)
            selected = { candidate, check };
        } catch (error) {
          trialRecord.error =
            error instanceof Error ? error.message : String(error);
          signal.throwIfAborted();
        }
        persist();
      }
      if (selected) {
        best = selected.candidate;
        record.best = best;
        record.bestReview = selected.check;
        rr.accepted = true;
      } else rr.reason = "目标未改善、特征退化或影响范围验证失败，保留上一候选";
      persist();
    }
    // Initial colouring is a separate deterministic material stage, not a correction.
    const palette = await ai("提取主色板与辨识花纹", (s) =>
      codex.structured(
        id,
        `${input.prompt}\n核心特征：${JSON.stringify(features)}\n全部部件：${JSON.stringify(best.objects)}\n为灰模提取主要配色，不照搬阴影，保持圆润简化。`,
        s,
        [ref, ...views(best)],
        paletteContract,
      ),
    );
    const color = await inspect(
      "colored",
      path.join(best.directory, "candidate.blend"),
      { camera: best.camera, bounds: best.bounds, palette, colorViews: true },
      "palette",
    );
    color.sourceScript = best.sourceScript;
    color.parameters = best.parameters;
    color.palette = palette;
    write(path.join(dir, "palette.json"), palette);
    record.colored = color;
    record.geometryBest = best;
    record.finalReview = await review(
      "检查完整风格与辨识度",
      color,
      undefined,
      {},
      true,
    );
    record.previewStable = color.preview.silhouetteDeviation <= 0.01;
    record.automaticPassed =
      finalPassed(features, record.finalReview) && record.previewStable;
    record.best = color;
    record.mechanismImproved = record.corrections.some((r: any) => r.accepted);
    record.status = "partial";
    record.stage = "实验完成，等待用户检查；没有写入正式作品";
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.status = signal.aborted ? "cancelled" : best ? "partial" : "failed";
  } finally {
    record.completedAt = new Date().toISOString();
    persist();
  }
  return record;
}
