import fs from "node:fs";
import path from "node:path";
import { codex } from "../../server/codex";
import { runStylizedExperiment } from "../../server/stylized/experiment";
if (!process.env.ZAOWU_DATA_DIR) throw new Error("需要独立实验数据目录");
const [output, config] = process.argv.slice(2);
if (!output || !config) throw new Error("stylized_probe.ts OUTPUT CASES_JSON");
const cases = JSON.parse(fs.readFileSync(config, "utf8"));
if (
  !Array.isArray(cases) ||
  new Set(cases.map((c) => c.name)).size !== cases.length ||
  cases.some((c) => !/^[a-z0-9-]+$/.test(c.name))
)
  throw new Error("样本名称无效");
fs.mkdirSync(output, { recursive: false });
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  const results: any[] = [];
  let cursor = 0;
  const concurrency = process.argv.includes("--overlap-analysis") ? 2 : 1;
  const worker = async () => {
    while (cursor < cases.length && !controller.signal.aborted) {
      const c = cases[cursor++];
      console.log("STYLIZED_CASE " + c.name);
      results.push({
        name: c.name,
        ...(await runStylizedExperiment(
          { ...c, output: path.join(path.resolve(output), c.name) },
          controller.signal,
        )),
      });
      fs.writeFileSync(
        path.join(output, "batch.json"),
        JSON.stringify(
          {
            results,
            userAcceptance: "pending",
            analysisConcurrency: concurrency,
            blenderConcurrency: 1,
          },
          null,
          2,
        ),
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
} finally {
  codex.close();
}
