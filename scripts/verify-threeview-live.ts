import { requireLiveEnvironment } from "./require-live-environment";
const live = requireLiveEnvironment({ ai: true });
import fs from "node:fs";
import path from "node:path";
const { runVisualPipeline } = await import("../server/visual-pipeline");
const { executeScene, validateScene } = await import("../server/jobs");
const { codex } = await import("../server/codex");
const { runBlender } = await import("../server/sandbox");
const { ROOT, acquireDataOwnership } = await import("../server/config");
acquireDataOwnership();
const root = path.join(live.dataDir, "threeview-live");
fs.mkdirSync(root, { recursive: true });
const empty = {
  objects: [],
  stats: { objects: 0, vertices: 0, triangles: 0 },
  units: "meters",
  coordinates: "blender-z-up",
} as const;
const signal = new AbortController().signal;
const { fixtures, ensureFixture } = await import("./visual-fixtures");
const chosen = process.argv[2] ? [process.argv[2]] : Object.keys(fixtures);
const results: any[] = [];
for (const name of chosen) {
  const test = fixtures[name];
  if (!test) throw new Error("未知测试类别");
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, "source");
  fs.mkdirSync(source, { recursive: true });
  try {
    await ensureFixture(name, root, signal);
    console.log(name, "START", new Date().toISOString());
    const result = await runVisualPipeline({
      runId: name,
      root: path.join(dir, "pipeline"),
      prompt: test.prompt,
      images: [path.join(source, "render.png")],
      baseScene: structuredClone(empty) as any,
      restartFailedPhase: process.argv.includes("--retry"),
      signal,
      onStage: (s) => console.log(name, s, new Date().toISOString()),
      onState: (s) =>
        fs.writeFileSync(
          path.join(dir, "visible.json"),
          JSON.stringify(s, null, 2),
        ),
      register: (f) => path.relative(dir, f),
      generate: (p, images) =>
        codex.generate(
          "validation-" + name,
          null,
          p,
          signal,
          () => {},
          () => {},
          images,
        ),
      execute: (d) => executeScene(d, "execute", signal, () => {}),
      validate: (d) => validateScene(d, signal),
    });
    results.push({
      name,
      passed: true,
      dir: result.dir,
      reviews: result.state.reviews,
    });
  } catch (e) {
    results.push({ name, passed: false, error: (e as Error).message });
    console.log(name, "FAILED", (e as Error).message);
  }
  fs.writeFileSync(
    path.join(root, "results-" + chosen.join("-") + ".json"),
    JSON.stringify(results, null, 2),
  );
}
console.log("LIVE_RESULTS", JSON.stringify(results));
process.exit(results.every((r) => r.passed) ? 0 : 1);
