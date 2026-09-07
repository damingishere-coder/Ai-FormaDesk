/** Actual stored-camera refinement and GPT comparison, using a controlled seat region.
 * This tests the correction backend, not whether GPT spontaneously chooses a patch.
 */
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { correctionMask } from "../../server/image-correction";
import { runImageProbe } from "../../server/image3d";
import { codex } from "../../server/codex";
import { uid } from "../../server/store";

const [source, output] = process.argv.slice(2);
if (!source || !output || !process.env.ZAOWU_DATA_DIR)
  throw new Error("Need source inference, output and isolated data directory");
fs.mkdirSync(output, { recursive: false });
const digest = () =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(source, "textured.blend")))
    .digest("hex");
const before = digest();
const patch = {
  view: 0,
  left: 0.32,
  top: 0.47,
  right: 0.68,
  bottom: 0.62,
  prompt:
    "An antique light brown wooden chair with a plain muted beige fabric seat cushion, consistent original color, no stripes or decorative patterns, realistic fabric surface",
};
fs.copyFileSync(
  path.join(source, "textured.blend"),
  path.join(output, "base.blend"),
);
fs.copyFileSync(
  path.join(source, "reference.png"),
  path.join(output, "reference.png"),
);
fs.writeFileSync(
  path.join(output, "selection.png"),
  await correctionMask(patch),
);
fs.writeFileSync(
  path.join(output, "request.json"),
  JSON.stringify({ storedCameraIndex: patch.view }),
);
try {
  const result = await runImageProbe(
    output,
    ["--prompt", patch.prompt, "--budget", "1800"],
    new AbortController().signal,
    (report) =>
      console.log(
        JSON.stringify({
          status: report.status,
          stage: report.stages?.at(-1)?.stage,
        }),
      ),
    "refine",
  );
  assert.equal(digest(), before);
  assert.equal(result.result.unselectedPixelsUnchanged, true);
  assert.equal(result.result.alphaUnchanged, true);
  for (let i = 0; i < 4; i++)
    assert.ok(
      fs.statSync(path.join(output, `textured-view-${i}.png`)).size > 1000,
    );
  const quality = await codex.reviewImage(
    uid(),
    "这是局部纹理纠错后对照。第一张为原照，随后四张是修正后正/左/右/背面，最后四张是修正前的对应视图。比较坐垫颜色、木材纹理及未选部位是否退化，不再提出下一轮修正。",
    AbortSignal.timeout(300000),
    [
      path.join(source, "reference.png"),
      ...[0, 1, 2, 3].map((i) => path.join(output, `textured-view-${i}.png`)),
      ...[0, 1, 2, 3].map((i) => path.join(source, `textured-view-${i}.png`)),
    ],
  );
  fs.writeFileSync(
    path.join(output, "comparison-report.json"),
    JSON.stringify(
      {
        backendPassed: true,
        decisionSource: "controlled-test-region",
        originalCandidateUnchanged: digest() === before,
        originalSha256: before,
        correction: patch,
        quality,
        wouldAcceptCorrection: quality.acceptable && !quality.regressed,
        result,
      },
      null,
      2,
    ),
  );
  console.log("AUTOMATIC_REFINE_BACKEND_OK");
} finally {
  codex.close();
}
