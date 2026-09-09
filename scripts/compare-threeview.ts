import fs from "node:fs";
import path from "node:path";
import { fixtures, ensureFixture } from "./visual-fixtures";
import { codex } from "../server/codex";
import { executeScene } from "../server/jobs";
import { runBlender } from "../server/sandbox";
import { ROOT } from "../server/config";
import { visualRequest } from "../server/visual-ai";
const root = path.resolve("data/threeview-live"),
  signal = new AbortController().signal;
const results: any[] = [];
for (const name of process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(fixtures)) {
  const source = await ensureFixture(name, root, signal);
  const dir = path.join(root, name, "direct-baseline");
  fs.mkdirSync(dir, { recursive: true });
  try {
    if (!fs.existsSync(path.join(dir, "scene.glb"))) {
      if (!fs.existsSync(path.join(dir, "generated.py"))) {
        const generated = await codex.generate(
          "direct-comparison-" + name,
          null,
          `仅根据这张原图直接写 Blender 建模脚本，不生成三视图。用户要求：${fixtures[name].prompt}。空白场景。主体几何中心位于原点附近，正面朝 -Y，保留原图颜色和材质，禁止地板、背景、灯光和相机。`,
          signal,
          () => {},
          () => {},
          [source],
        );
        fs.writeFileSync(path.join(dir, "generated.py"), generated.python);
      }
      await executeScene(dir, "execute", signal, (s) => console.log(name, s));
    }
    const scene = JSON.parse(
      fs.readFileSync(path.join(dir, "scene.json"), "utf8"),
    );
    fs.writeFileSync(
      path.join(dir, "visual.json"),
      JSON.stringify({
        targets: scene.objects
          .filter((o: any) => o.type === "MESH")
          .map((o: any) => o.id),
      }),
    );
    const r = await runBlender(
      dir,
      ["--python", path.join(ROOT, "blender/visual.py"), "--", "render", dir],
      signal,
      300000,
      true,
    );
    if (r.code !== 0) throw new Error((r.stdout + r.stderr).slice(-2500));
    const stateFile = path.join(root, name, "pipeline/pipeline.json");
    const state = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
      : {};
    const images = [
      source,
      ...["front", "right", "top"].map((v) => path.join(dir, v + ".png")),
    ];
    if (state.complete)
      images.push(
        ...["front", "right", "top"].map((v) =>
          path.join(state.appearanceDir, v + ".png"),
        ),
      );
    const resultSchema = {
      type: "object",
      properties: {
        observations: { type: "string" },
        directShape: { type: "boolean" },
        directAppearance: { type: "boolean" },
        multiShape: { type: ["boolean", "null"] },
        multiAppearance: { type: ["boolean", "null"] },
        limitations: { type: "array", items: { type: "string" } },
      },
      required: [
        "observations",
        "directShape",
        "directAppearance",
        "multiShape",
        "multiAppearance",
        "limitations",
      ],
      additionalProperties: false,
    };
    const review = await visualRequest({
      cwd: dir,
      signal,
      images,
      schema: resultSchema,
      prompt: `这是对照评测：第1张为合成原图，第2-4张为仅看原图直接写脚本的模型正/右/顶渲染。${state.complete ? "第5-7张为使用三视图流程的模型正/右/顶渲染" : "三视图流程尚未完成，没有它的模型，不可推测，multiShape和multiAppearance必须为null"}。用户要求：${fixtures[name].prompt}。分别判断轮廓比例部件，以及颜色/花纹外观是否还原原图。只依据给出的图片，不偏袒某条流程。说明主要差异和看不到的结构限制。`,
    });
    const row = {
      name,
      directExecuted: true,
      multiCompleted: !!state.complete,
      review,
    };
    results.push(row);
    fs.writeFileSync(
      path.join(dir, "comparison.json"),
      JSON.stringify(row, null, 2),
    );
    console.log("COMPARE", name, JSON.stringify(row));
  } catch (e) {
    results.push({ name, error: (e as Error).message });
  }
  fs.writeFileSync(
    path.join(
      root,
      "comparison-" + (process.argv.slice(2).join("-") || "all") + ".json",
    ),
    JSON.stringify(results, null, 2),
  );
}
process.exit(results.some((r) => r.error) ? 1 : 0);
