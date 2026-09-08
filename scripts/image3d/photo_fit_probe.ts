import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../../server/config";
import { codex } from "../../server/codex";
import { runBlender } from "../../server/sandbox";
import { runPhotoFitExperiment, type ExperimentInput } from "../../server/photo-fit/experiment";

if (!process.env.ZAOWU_DATA_DIR) throw new Error("需要独立 ZAOWU_DATA_DIR，不能使用作品数据目录");
const [mode, output, configFile] = process.argv.slice(2);
if (!output || !["controlled", "batch"].includes(mode)) throw new Error("photo_fit_probe.ts controlled|batch OUTPUT [CONFIG_JSON]");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  if (mode === "controlled") {
    fs.mkdirSync(output, { recursive: false });
    const result = await runBlender(path.resolve(output), ["--python", path.join(ROOT, "blender/photo_fit_probe.py"), "--", path.resolve(output)],
      controller.signal, 120000, true);
    fs.writeFileSync(path.join(output, "execution.log"), result.stdout+result.stderr);
    if (result.code) throw new Error((result.stderr+result.stdout).slice(-3500));
    console.log(fs.readFileSync(path.join(output, "controlled.json"), "utf8"));
  } else {
    fs.mkdirSync(output, { recursive: false });
    const cases: (Omit<ExperimentInput, "output"> & { name: string })[] = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (new Set(cases.map(c => c.name)).size !== cases.length || cases.some(c => !/^[a-z0-9-]+$/.test(c.name))) throw new Error("样本名称重复或无效");
    const reports = [];
    for (const sample of cases) {
      if (controller.signal.aborted) break;
      console.log("PHOTO_FIT_CASE "+sample.name);
      reports.push({ name: sample.name, ...await runPhotoFitExperiment({ ...sample, output: path.join(path.resolve(output), sample.name) }, controller.signal) });
      fs.writeFileSync(path.join(output, "batch.json"), JSON.stringify({ reports, categoryAcceptance: [],
        note: "机制改善需要结合受控测试、四张固定照片和用户视觉验收；不能仅统计文件生成成功" }, null, 2));
    }
  }
} finally { codex.close(); }
