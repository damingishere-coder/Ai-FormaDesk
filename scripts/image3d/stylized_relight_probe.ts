/** Recheck an immutable candidate after calibrating inspection lighting only. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "../../server/config";
import { runBlender } from "../../server/sandbox";
import { codex } from "../../server/codex";
import {
  changedObjects,
  finalPassed,
  reviewContract,
  validateReview,
} from "../../server/stylized/contracts";
if (!process.env.ZAOWU_DATA_DIR) throw new Error("需要独立实验数据目录");
const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw new Error("stylized_relight_probe.ts EXPERIMENT_JSON NEW_OUTPUT");
const original = JSON.parse(fs.readFileSync(source, "utf8"));
if (!original.colored) throw new Error("需要已验证的彩色候选");
const directory = path.resolve(output);
fs.mkdirSync(directory, { recursive: false });
const signal = AbortSignal.timeout(300000),
  started = performance.now();
for (const name of ["reference.png", "reference-128.png", "features.json"])
  fs.copyFileSync(
    path.join(path.dirname(source), name),
    path.join(directory, name),
  );
fs.copyFileSync(
  path.join(original.colored.directory, "candidate.blend"),
  path.join(directory, "input.blend"),
);
fs.writeFileSync(
  path.join(directory, "request.json"),
  JSON.stringify({
    camera: original.colored.camera,
    bounds: original.colored.bounds,
    colorViews: true,
    constraints: {},
  }),
);
const record = {
  ...original,
  parentExperiment: source,
  calibration: "neutral inspection fill only; no geometry or palette change",
  startedAt: new Date().toISOString(),
  status: "running",
  budgetMs: 300000,
  stages: [] as any[],
  codeHashes: {
    worker: createHash("sha256")
      .update(fs.readFileSync(path.join(ROOT, "blender/photo_fit_worker.py")))
      .digest("hex"),
  },
};
try {
  const result = await runBlender(
    directory,
    [
      "--python",
      path.join(ROOT, "blender/photo_fit_worker.py"),
      "--",
      "inspect",
      directory,
    ],
    signal,
    120000,
    true,
    { maxFootprintMb: 12288 },
  );
  fs.writeFileSync(
    path.join(directory, "execution.log"),
    result.stdout + result.stderr,
  );
  if (result.code !== 0) throw new Error("照明校准执行失败");
  const report = JSON.parse(
    fs.readFileSync(path.join(directory, "report.json"), "utf8"),
  );
  if (
    !report.geometryValid ||
    changedObjects(original.colored.objects, report.objects, []).length
  )
    throw new Error("照明校准改变了模型");
  const check = validateReview(
    original.features,
    await codex.structured(
      "stylized-relight",
      `第1张为原照，后4张是同一候选的彩色四面视图。只校准了中性检查照明，网格和色板未修改。特征：${JSON.stringify(original.features)}；风格：${JSON.stringify(original.style)}。这是彩色阶段，无前后修改目标，targetImproved=false。判断辨识特征、风格和结构是否通过。`,
      signal,
      [
        path.join(directory, "reference.png"),
        ...["front", "left", "right", "back"].map((v) =>
          path.join(directory, "color-" + v + ".png"),
        ),
      ],
      reviewContract,
    ),
  );
  record.colored = { ...original.colored, ...report, directory };
  record.best = record.colored;
  record.finalReview = check;
  record.automaticPassed =
    finalPassed(original.features, check) &&
    report.preview.silhouetteDeviation <= 0.01;
  record.status = "partial";
  record.stage = "照明校准完成，模型未修改";
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  record.status = "partial";
} finally {
  record.completedAt = new Date().toISOString();
  record.remainingMs = 300000 - (performance.now() - started);
  fs.writeFileSync(
    path.join(directory, "experiment.json"),
    JSON.stringify(record, null, 2),
  );
  codex.close();
}
